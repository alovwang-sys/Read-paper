import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTikHubBridge, inspectTikHubSkill, TIKHUB_TOOL } from './tikhub-tools.mjs';

const schema = { name: 'search_posts', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 }, cursor: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['query'], additionalProperties: false } };

function fixture(options = {}) {
  const spawned = []; const interactions = []; const children = [];
  const spawnImpl = (executable, args, settings) => {
    const child = new EventEmitter(); children.push(child);
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    child.kill = (signal) => {
      record.kills.push(signal);
      if (options.waitForKill) return true;
      child.exitCode = 0; child.emit('close', 0); return true;
    };
    const record = { executable, args, settings, input: '', kills: [] }; spawned.push(record);
    child.stdin = new Writable({ write(chunk, _encoding, callback) { record.input += chunk.toString(); callback(); } });
    child.stdin.on('finish', () => {
      setImmediate(() => {
        if (options.hang) return;
        if (options.respond) { options.respond(child, record); return; }
        const data = args[1] === 'schema' ? schema : args[1] === 'platforms' ? ['douyin'] : { content: [{ type: 'text', text: 'Post from https://example.com/post/1' }] };
        child.stdout.write(JSON.stringify(data)); child.exitCode = 0; child.emit('close', 0);
      });
    });
    return child;
  };
  const controller = new AbortController();
  const bridge = createTikHubBridge({ scriptPath: '/skills/tikhub/scripts/tikhub.py', env: { PATH: '/usr/bin', HOME: '/user', TIKHUB_API_KEY: 'private-key-value', UNRELATED_SECRET: 'do-not-inherit', NODE_OPTIONS: '--require /untrusted' }, spawnImpl, signal: controller.signal, onInteraction: async (input) => { interactions.push(input); return { decision: options.deny ? 'deny' : 'allowOnce' }; } });
  return { bridge, spawned, interactions, children, controller };
}

const discover = (f) => f.bridge.call({ action: 'schema', platform: 'douyin', tool: 'search_posts' });
const call = (f, args = { query: 'paper', limit: 2, cursor: null }) => f.bridge.call({ action: 'call', platform: 'douyin', tool: 'search_posts', arguments: args });

test('TikHub inspection finds only in-skill scripts and checks credential permissions without reading values', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'read-paper-tikhub-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillDir = join(root, 'skill'); await mkdir(join(skillDir, 'scripts'), { recursive: true });
  const path = join(skillDir, 'SKILL.md'); await writeFile(path, 'TikHub');
  const script = join(skillDir, 'scripts', 'tikhub.py'); await writeFile(script, '# local');
  const keyfile = join(root, 'key'); await writeFile(keyfile, 'never-read-this', { mode: 0o600 });
  assert.equal(await inspectTikHubSkill({ name: 'other', path }), undefined);
  const ready = await inspectTikHubSkill({ name: 'tikhub', path }, { PATH: process.env.PATH, TIKHUB_API_KEY_FILE: keyfile });
  assert.equal(ready.ready, true); assert.equal(ready.scriptPath, await realpath(script)); assert.doesNotMatch(JSON.stringify(ready), /never-read-this/);
  await chmod(keyfile, 0o644);
  assert.equal((await inspectTikHubSkill({ name: 'tikhub', path }, { PATH: process.env.PATH, TIKHUB_API_KEY_FILE: keyfile })).ready, false);
  assert.equal((await inspectTikHubSkill({ name: 'tikhub', path }, { PATH: '/does-not-exist', TIKHUB_API_KEY: 'configured' })).ready, false);
  assert.equal((await inspectTikHubSkill({ name: 'tikhub', path }, { PATH: process.env.PATH, TIKHUB_API_KEY: 'configured' })).ready, true);
  await rm(script); await writeFile(join(root, 'outside.py'), '# external'); await symlink(join(root, 'outside.py'), script);
  assert.equal((await inspectTikHubSkill({ name: 'tikhub', path }, { PATH: process.env.PATH, TIKHUB_API_KEY: 'configured' })).ready, false);
});

test('discovery and approved exact-schema calls use shell-free CLI and JSON stdin; secrets stay out of arguments/events', async () => {
  const f = fixture();
  assert.equal(TIKHUB_TOOL.name, 'read_paper_tikhub'); assert.equal(TIKHUB_TOOL.inputSchema.additionalProperties, false);
  await f.bridge.call({ action: 'platforms' });
  await f.bridge.call({ action: 'tools', platform: 'douyin', search: 'search' });
  assert.equal((await discover(f)).success, true); assert.equal((await call(f)).success, true);
  assert.deepEqual(f.spawned[0].args, ['/skills/tikhub/scripts/tikhub.py', 'platforms']);
  assert.deepEqual(f.spawned[1].args, ['/skills/tikhub/scripts/tikhub.py', 'tools', 'douyin', '--search=search']);
  assert.deepEqual(f.spawned[3].args, ['/skills/tikhub/scripts/tikhub.py', 'call', 'douyin', 'search_posts', '--args-file', '-']);
  assert.deepEqual(JSON.parse(f.spawned[3].input), { query: 'paper', limit: 2, cursor: null });
  assert.equal(f.spawned[3].settings.shell, false); assert.equal(f.spawned[3].settings.env.TIKHUB_API_KEY, 'private-key-value');
  assert.equal(f.spawned[3].settings.env.UNRELATED_SECRET, undefined); assert.equal(f.spawned[3].settings.env.NODE_OPTIONS, undefined);
  assert.equal(f.spawned[3].settings.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.doesNotMatch(JSON.stringify(f.spawned.map(({ args, input }) => ({ args, input }))), /private-key-value/);
  assert.equal(f.interactions.length, 1); assert.match(f.interactions[0].detail, /search_posts/); assert.match(f.interactions[0].detail, /可能消耗/); assert.match(f.interactions[0].detail, /"query":"paper"/);
  assert.doesNotMatch(JSON.stringify(f.interactions), /private-key-value/);
});

test('unknown platform, command injection fields and tools missing discovery never spawn data calls', async () => {
  const f = fixture();
  for (const args of [
    { action: 'tools', platform: 'not-real' }, { action: 'tools', platform: 'douyin', url: 'https://untrusted' },
    { action: 'call', platform: 'douyin', tool: '--unsafe', arguments: {} },
    { action: 'platforms', platform: 'douyin' },
  ]) assert.equal((await f.bridge.call(args)).success, false);
  assert.equal((await call(f)).success, false);
  assert.equal(f.spawned.length, 0); assert.equal(f.interactions.length, 0);
});

test('schema validation rejects missing required, unknown fields, wrong types and out-of-range values before approval', async () => {
  const f = fixture(); await discover(f);
  for (const args of [{}, { query: 1 }, { query: 'paper', limit: 0 }, { query: 'paper', limit: 2.5 }, { query: 'paper', url: 'https://untrusted' }, { query: 'paper', cursor: false }]) assert.equal((await call(f, args)).success, false);
  assert.equal(f.spawned.length, 1); assert.equal(f.interactions.length, 0);
});

test('denying approval never invokes the data tool, and unsupported schema constraints fail closed', async () => {
  const f = fixture({ deny: true }); await discover(f);
  assert.match((await call(f)).contentItems[0].text, /拒绝/); assert.equal(f.spawned.length, 1);
  const complex = fixture({ respond: (child) => { child.stdout.write(JSON.stringify({ ...schema, inputSchema: { $ref: '#/$defs/Input' } })); child.exitCode = 0; child.emit('close', 0); } });
  await discover(complex); assert.match((await call(complex)).contentItems[0].text, /暂不支持/); assert.equal(complex.spawned.length, 1); assert.equal(complex.interactions.length, 0);
});

test('cancellation kills and waits for only the owned process to close', async () => {
  const f = fixture({ hang: true, waitForKill: true });
  let settled = false;
  const pending = f.bridge.call({ action: 'check', platform: 'douyin' }).then((value) => { settled = true; return value; });
  f.controller.abort(); await new Promise(setImmediate);
  assert.deepEqual(f.spawned[0].kills, ['SIGTERM']); assert.equal(settled, false);
  f.children[0].exitCode = 0; f.children[0].emit('close', 0);
  assert.match((await pending).contentItems[0].text, /已停止/);
});

test('timeout and output bounds stop the owned process without retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ hang: true });
  const pending = f.bridge.call({ action: 'check', platform: 'douyin' });
  t.mock.timers.tick(60_000);
  assert.match((await pending).contentItems[0].text, /超时/); assert.equal(f.spawned.length, 1); assert.deepEqual(f.spawned[0].kills, ['SIGTERM']);
  t.mock.timers.reset();
  const large = fixture({ respond: (child) => child.stdout.write('x'.repeat(1_048_577)) });
  assert.match((await large.bridge.call({ action: 'check', platform: 'douyin' })).contentItems[0].text, /超过大小限制/); assert.equal(large.spawned.length, 1);
});

test('HTTP failures disclose a status only, MCP errors retain isError and content, and large results mark truncation', async () => {
  const http = fixture({ respond: (child) => { child.stderr.write('TikHub request failed: TikHub HTTP 429; private-key-value\n'); child.exitCode = 1; child.emit('close', 1); } });
  const failure = await http.bridge.call({ action: 'check', platform: 'douyin' });
  assert.equal(failure.success, false); assert.match(failure.contentItems[0].text, /429/); assert.doesNotMatch(failure.contentItems[0].text, /private-key-value/);
  const mcp = fixture({ respond: (child) => { child.stdout.write(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Quota denied, private-key-value' }] })); child.exitCode = 1; child.emit('close', 1); } });
  const response = await mcp.bridge.call({ action: 'check', platform: 'douyin' });
  assert.equal(response.success, false); assert.match(response.contentItems[0].text, /"isError": true/); assert.match(response.contentItems[0].text, /Quota denied/); assert.doesNotMatch(response.contentItems[0].text, /private-key-value/);
  const large = fixture({ respond: (child) => { child.stdout.write(JSON.stringify({ content: 'x'.repeat(70_000) })); child.exitCode = 0; child.emit('close', 0); } });
  const truncated = await large.bridge.call({ action: 'check', platform: 'douyin' });
  assert.match(truncated.contentItems[0].text, /结果已截断/); assert.ok(truncated.contentItems[0].text.length < 64_200);
});

test('turn operation cap and complete parameter bound prevent unbounded work and hidden approval arguments', async () => {
  const f = fixture(); await discover(f);
  assert.match((await call(f, { query: 'x'.repeat(8000) })).contentItems[0].text, /8000/);
  assert.match((await call(f, { query: 'private-key-value' })).contentItems[0].text, /包含凭据/);
  for (let i = 0; i < 5; i++) await f.bridge.call({ action: 'platforms' });
  assert.match((await f.bridge.call({ action: 'platforms' })).contentItems[0].text, /8 次上限/);
  assert.equal(f.interactions.length, 0); assert.equal(f.spawned.length, 6);
});

test('service failures halt later actions this turn, without making another request or approval', async () => {
  const f = fixture({ respond: (child) => { child.stderr.write('TikHub HTTP 401; authorization failed'); child.exitCode = 1; child.emit('close', 1); } });
  assert.equal((await f.bridge.call({ action: 'check', platform: 'douyin' })).success, false);
  const retry = await f.bridge.call({ action: 'tools', platform: 'douyin' });
  assert.equal(retry.success, false); assert.match(retry.contentItems[0].text, /服务错误停止，未重试/); assert.match(retry.contentItems[0].text, /401/);
  assert.equal(f.spawned.length, 1); assert.equal(f.interactions.length, 0);
});

test('unknown constraints in an alternate schema branch reject before approval; oversized schemas are never cached', async () => {
  const f = fixture({ respond: (child) => { child.stdout.write(JSON.stringify({ name: 'search_posts', inputSchema: { oneOf: [{ type: 'object' }, { $ref: '#/$defs/Other' }] } })); child.exitCode = 0; child.emit('close', 0); } });
  await discover(f); assert.match((await call(f)).contentItems[0].text, /暂不支持/); assert.equal(f.interactions.length, 0);
  const huge = fixture({ respond: (child) => { child.stdout.write(JSON.stringify({ ...schema, description: 'x'.repeat(64_000) })); child.exitCode = 0; child.emit('close', 0); } });
  assert.equal((await discover(huge)).success, false); assert.match((await call(huge)).contentItems[0].text, /请先/); assert.equal(huge.spawned.length, 1);
});

test('UTF-8 split across chunks stays intact, and leading-hyphen searches remain argument values', async () => {
  const f = fixture({ respond: (child) => { const bytes = Buffer.from(JSON.stringify({ text: '论文原文' })); for (const byte of bytes) child.stdout.write(Buffer.from([byte])); child.exitCode = 0; child.emit('close', 0); } });
  const response = await f.bridge.call({ action: 'tools', platform: 'douyin', search: '--help' });
  assert.match(response.contentItems[0].text, /论文原文/); assert.ok(f.spawned[0].args.includes('--search=--help'));
});
