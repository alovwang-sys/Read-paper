import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createResearchHandler } from '../../../../server/research.mjs';
import { createCodexRuntime } from '../../../../server/codex-runtime.mjs';

// The exclusive evidence file prevents an accidental second real generation.
const output = new URL('./result.json', import.meta.url);
const marker = await open(output, 'wx', 0o600);
await marker.writeFile('{"status":"running","note":"One-shot real generation; do not rerun."}\n');
await marker.close();
const started = Date.now();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (name, data) => {
  const type = Buffer.from(name), bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); type.copy(bytes, 4); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(Buffer.concat([type, data])), data.length + 8);
  return bytes;
};
function makePng(second) {
  const width = 320, height = 240;
  const pixels = Buffer.alloc(height * (width * 3 + 1), 255);
  for (let y = 0; y < height; y++) {
    pixels[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const inside = second ? (x - 160) ** 2 + (y - 120) ** 2 <= 72 ** 2 : x >= 55 && x <= 265 && y >= 65 && y <= 175;
      if (inside) Buffer.from(second ? [25, 75, 220] : [220, 30, 30]).copy(pixels, y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const originals = [makePng(false), makePng(true)];
const images = originals.map((bytes, index) => ({ assetId: `synthetic-chat-${index + 1}`, hash: sha256(bytes), name: `input-${index + 1}.png`, mimeType: 'image/png', size: bytes.length, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }));
const prompt = '请仅辨认附件，严格按图片输入顺序返回一个 JSON 对象：{"images":[{"index":1,"color":"主要图形的中文颜色","shape":"主要图形的中文形状"},{"index":2,"color":"主要图形的中文颜色","shape":"主要图形的中文形状"}]}。只写你实际看到的内容，不从文件名或元数据猜测。不要调用任何工具，不找论文，不写文稿，不读本机文件，不执行命令。';
const request = { requestId: 'synthetic-chat-image-smoke-20261021', researchId: 'synthetic-image-research', connectionId: 'codex', prompt, sources: [], history: [], images };
const evidence = { startedAt: new Date(started).toISOString(), nodeVersion: process.version,
  scope: 'One real Codex generation with two self-generated public synthetic PNGs. No user research, workspace data, library writes, PDF reads, credential inspection, reasoning, private paths or native session IDs are recorded.',
  limits: { requestDeadlineMs: 170000, researchInactivityMs: 120000, totalBudgetMs: 180000, automaticRetries: 0 },
  request: { ...request, images: images.map(({ dataUrl, ...metadata }) => metadata) }, expected: [{ index: 1, color: '红色', shape: '矩形' }, { index: 2, color: '蓝色', shape: '圆形' }], events: [], toolCalls: [] };
let runtime, handler, server;
try {
  evidence.cliVersion = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
  await Promise.all(originals.map((bytes, index) => writeFile(new URL(`./input-${index + 1}.png`, import.meta.url), bytes)));
  runtime = createCodexRuntime({ env: process.env, interruptTimeoutMs: 3000 });
  server = createServer((req, res) => handler(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }).catch(() => { if (!res.writableEnded) res.end(); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  handler = createResearchHandler({ env: process.env, ports: [port], timeoutMs: 120000, runtimes: { codex: { async run(input) {
    evidence.transport = { localImageCount: input.localImages?.length ?? 0,
      generatedFileNames: (input.localImages || []).map(path => basename(path)),
      exactOrderedBytes: JSON.stringify(await Promise.all((input.localImages || []).map(async path => sha256(await readFile(path))))) === JSON.stringify(images.map(image => image.hash)),
      base64ExcludedFromPrompt: !/data:image|;base64,/.test(input.prompt), registeredTools: input.researchTools.definitions.map(tool => tool.name) };
    const call = input.researchTools.call;
    input.researchTools.call = (name, args) => { evidence.toolCalls.push(name); return call(name, args); };
    return runtime.run(input);
  } } } });
  const remaining = Math.max(1, 170000 - (Date.now() - started));
  const response = await fetch(`http://127.0.0.1:${port}/api/ai/research/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(remaining) });
  evidence.httpStatus = response.status;
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  const consume = line => {
    if (!line.trim()) return;
    const raw = JSON.parse(line), event = { elapsedMs: Date.now() - started, type: raw.type };
    if (raw.type === 'delta') event.text = raw.text;
    if (raw.type === 'done') { event.model = raw.model; event.readPages = raw.readPages; event.nativeSessionObserved = typeof raw.nativeSessionId === 'string'; }
    if (raw.type === 'error') event.error = raw.error;
    evidence.events.push(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end; while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    }
    buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
  } finally { reader.releaseLock(); }
  evidence.answer = evidence.events.filter(event => event.type === 'delta').map(event => event.text).join('');
  try { evidence.recognized = JSON.parse(evidence.answer.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim()); } catch { evidence.recognized = null; }
  const result = evidence.recognized?.images;
  evidence.checks = { actualTwoImageFiles: evidence.transport?.localImageCount === 2, exactOrderedBytes: evidence.transport?.exactOrderedBytes === true,
    base64ExcludedFromPrompt: evidence.transport?.base64ExcludedFromPrompt === true,
    firstRecognizedRedRectangle: result?.length === 2 && result[0].index === 1 && /红/.test(result[0].color) && /矩形|长方形/.test(result[0].shape),
    secondRecognizedBlueCircle: result?.length === 2 && result[1].index === 2 && /蓝/.test(result[1].color) && /圆/.test(result[1].shape),
    cleanDone: evidence.events.at(-1)?.type === 'done', noPdfReads: evidence.events.at(-1)?.readPages?.length === 0,
    noArtifact: evidence.events.every(event => event.type !== 'artifact'), noToolCalls: evidence.toolCalls.length === 0 };
  evidence.success = Object.values(evidence.checks).every(check => check === true);
} catch (failure) {
  evidence.success = false;
  evidence.failure = { name: failure.name, code: typeof failure.code === 'string' ? failure.code : undefined,
    message: failure.name === 'TimeoutError' ? 'The one-shot request deadline elapsed; no automatic retry.' : 'The one-shot synthetic image smoke did not complete; inspect the filtered response only.' };
} finally {
  handler?.close(); server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await runtime?.close();
  evidence.finishedAt = new Date().toISOString(); evidence.elapsedMs = Date.now() - started;
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
}
process.stdout.write(JSON.stringify({ success: evidence.success, elapsedMs: evidence.elapsedMs, checks: evidence.checks, failure: evidence.failure }) + '\n');
if (!evidence.success) process.exitCode = 1;
