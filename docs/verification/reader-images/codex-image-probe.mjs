import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createCodexClient } from '../../../server/codex-runtime.mjs';

// A complete noisy PNG makes any base64 echo exceed the production 4 MB event cap.
function png() {
  const chunk = (name, data) => {
    const content = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const output = Buffer.alloc(content.length + 8);
    output.writeUInt32BE(data.length); content.copy(output, 4); output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1024); header.writeUInt32BE(1024, 4); header[8] = 8; header[9] = 2;
  const pixels = randomBytes(1024 * 1024 * 3), rows = Buffer.alloc(1024 * (1024 * 3 + 1));
  for (let y = 0; y < 1024; y++) pixels.copy(rows, y * (1024 * 3 + 1) + 1, y * 1024 * 3, (y + 1) * 1024 * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'papertrail-image-probe-'));
const state = join(root, 'isolated-codex-state'), cwd = join(root, 'project'), materials = join(root, 'materials');
const imagePath = join(materials, 'region-1.png'), bytes = png(), expectedHash = digest(bytes);
const question = 'SYNTHETIC LOCAL IMAGE PROBE: no user data and no real model call.';
const answer = 'SYNTHETIC LOCAL ANSWER: image received by the loopback mock provider.';
let client, providerRequests = 0, providerImageBytes = 0, providerImageHash, providerError;
let maximumEventBytes = 0, imageEcho = false;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/responses'); assert.equal(req.headers.authorization, undefined);
    let raw = '';
    for await (const part of req) { raw += part; assert.ok(raw.length < 8_000_000); }
    assert.ok(raw.includes(question)); providerRequests++; assert.equal(providerRequests, 1);
    const request = JSON.parse(raw);
    const images = request.input.flatMap(item => item.content || []).filter(part => part.type === 'input_image');
    assert.equal(images.length, 1);
    assert.match(images[0].image_url, /^data:image\/png;base64,/);
    const received = Buffer.from(images[0].image_url.split(',')[1], 'base64');
    providerImageBytes = received.length; providerImageHash = digest(received);
    assert.equal(providerImageHash, expectedHash, 'The actual CLI must forward the exact selected PNG bytes.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const item = { id: 'synthetic-image-answer', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: answer, annotations: [] }] };
    send({ type: 'response.created', response: { id: 'synthetic-image-response', object: 'response', status: 'in_progress', output: [] } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer });
    send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: answer });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: 'synthetic-image-response', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  } catch (error) { providerError = error; res.writeHead(500); res.end('Synthetic image probe failed.'); }
});

try {
  await mkdir(state); await mkdir(cwd); await mkdir(materials);
  await writeFile(imagePath, bytes, { mode: 0o400 }); await chmod(materials, 0o500);
  assert.equal((await stat(imagePath)).mode & 0o777, 0o400);
  assert.equal((await stat(materials)).mode & 0o777, 0o500);
  assert.ok(bytes.toString('base64').length > 4_000_000);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(join(state, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "synthetic_image_probe"\n[analytics]\nenabled = false\n[model_providers.synthetic_image_probe]\nname = "Local synthetic image probe"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  let finish, fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; }); completed.catch(() => {});
  client = createCodexClient({ executable: 'codex', env: { PATH: process.env.PATH, CODEX_HOME: state, NO_PROXY: '127.0.0.1,localhost' }, cwd, rpcTimeoutMs: 15_000,
    onFailure: fail,
    onNotification({ method, params }) {
      const event = JSON.stringify({ method, params }); maximumEventBytes = Math.max(maximumEventBytes, Buffer.byteLength(event)); imageEcho ||= event.includes('data:image/');
      if (method === 'turn/completed') finish(params.turn);
    },
  });
  await client.initialize();
  const read = await client.rpc('command/exec', { command: ['/usr/bin/wc', '-c', imagePath], cwd: materials, permissionProfile: 'read_paper_materials', outputBytesCap: 512, timeoutMs: 3000 });
  assert.equal(read.exitCode, 0); assert.equal(Number(read.stdout.trim().split(/\s+/)[0]), bytes.length);
  const write = await client.rpc('command/exec', { command: ['/usr/bin/touch', join(materials, 'write-denied')], cwd: materials, permissionProfile: 'read_paper_materials', outputBytesCap: 512, timeoutMs: 3000 });
  assert.notEqual(write.exitCode, 0);
  const { thread } = await client.rpc('thread/start', { cwd, runtimeWorkspaceRoots: [cwd, materials], model: 'gpt-5.4', modelProvider: 'synthetic_image_probe', approvalPolicy: 'never', permissions: 'read_paper_materials', ephemeral: false });
  await client.rpc('turn/start', { threadId: thread.id, cwd, runtimeWorkspaceRoots: [cwd, materials], permissions: 'read_paper_materials', approvalPolicy: 'never', input: [{ type: 'text', text: question, text_elements: [] }, { type: 'localImage', path: imagePath }] });
  let timer;
  try {
    const turn = await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic image turn did not complete.')), 15_000); })]);
    assert.equal(turn.status, 'completed');
  } finally { clearTimeout(timer); }
  if (providerError) throw providerError;
  assert.equal(providerRequests, 1); assert.equal(imageEcho, false); assert.ok(maximumEventBytes < 4_000_000);
  console.log(JSON.stringify({ phase: 'actual-cli-local-image', cli: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(), localhostProviderRequests: providerRequests, realModelCalls: 0, userSessionsAccessed: 0, sourceBytes: bytes.length, providerImageBytes, providerImageHash, exactSourceHash: expectedHash === providerImageHash, readonlyFile: '0400', readonlyDirectory: '0500', readonlyReadPassed: true, writeDenied: true, imageBase64Echo: imageEcho, maximumEventBytes, pass: true }));
} finally {
  await client?.shutdown();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await chmod(materials, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ phase: 'owned-client-and-loopback-server-closed-temporary-state-removed', pass: true }));
}
