import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppProtocol, canWriteClipboard, APP_URL, APP_ORIGIN } from './protocol.mjs';
import config from '../forge.config.cjs';

test('生产协议仅服务dist与设置文件，阻止路径穿越和未知接口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-protocol-'));
  try {
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'dist', 'index.html'), 'app');
    await writeFile(join(directory, 'secret'), 'private');
    const handler = createAppProtocol({ distDirectory: join(directory, 'dist'), desktopDirectory: directory, getAI: () => undefined });
    const response = await handler(new Request('papertrail://app/'));
    assert.equal(await response.text(), 'app');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await handler(new Request('papertrail://other/'))).status, 403);
    assert.equal((await handler(new Request('papertrail://app/..%2fsecret'))).status, 403);
    assert.equal((await handler(new Request('papertrail://app/api/arbitrary'))).status, 404);
    assert.equal((await handler(new Request('papertrail://app/api/ai/config?url=https://example.com'))).status, 404);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('AI代理只注入主进程token，不转发Origin/任意头且保留流式与取消', async () => {
  let received;
  const handler = createAppProtocol({ distDirectory: '.', desktopDirectory: '.', getAI: () => ({ baseURL: 'http://127.0.0.1:1234', token: 'session-secret' }), fetchImpl: async (url, options) => {
    received = { url, options };
    return new Response('stream\n', { headers: { 'content-type': 'application/x-ndjson' } });
  } });
  const controller = new AbortController();
  const response = await handler(new Request('papertrail://app/api/ai/chat', { method: 'POST', body: '{}', signal: controller.signal, headers: { Origin: 'papertrail://app', Authorization: 'malicious' } }));
  assert.equal(await response.text(), 'stream\n');
  assert.equal(received.url, 'http://127.0.0.1:1234/api/ai/chat');
  assert.equal(received.options.headers['X-Papertrail-Token'], 'session-secret');
  assert.equal(Object.keys(received.options.headers).length, 2);
  controller.abort();
  assert.equal(received.options.signal.aborted, true);
});
test('桌面原生助手与项目接口按路径和方法逐项放行，未知接口不进入本机服务', async () => {
  const calls = [];
  const handler = createAppProtocol({ distDirectory: '.', desktopDirectory: '.', getAI: () => ({ baseURL: 'http://127.0.0.1:1234', token: 'private-agent-token' }), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ready: true });
  } });
  const getPaths = ['/api/ai/agents', '/api/ai/agents/codex/capabilities'];
  const postPaths = ['/api/ai/agents/run', '/api/ai/agents/respond', '/api/ai/agents/stop', ...['browse', 'preview', 'bind', 'status', 'list', 'read', 'defaults', 'sync'].map(action => `/api/ai/agents/projects/${action}`)];
  for (const method of ['GET', 'POST']) for (const path of method === 'GET' ? getPaths : postPaths) {
    const response = await handler(new Request(`papertrail://app${path}`, { method, ...(method === 'POST' ? { body: '{"researchId":"fixture"}' } : {}), headers: { Origin: 'https://untrusted.example', Authorization: 'never-forward' } }));
    assert.equal(response.status, 200, path);
    assert.equal(calls.at(-1).url, `http://127.0.0.1:1234${path}`);
    assert.deepEqual(calls.at(-1).options.headers, { 'X-Papertrail-Token': 'private-agent-token', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) });
    assert.equal((await handler(new Request(`papertrail://app${path}`, { method: method === 'POST' ? 'GET' : 'POST' }))).status, 404, `${path} wrong method`);
    assert.equal((await handler(new Request(`papertrail://app${path}?directory=/private`, { method }))).status, 404, `${path} query`);
  }
  const permitted = calls.length;
  for (const path of ['/api/ai/agents/arbitrary', '/api/ai/agents/projects/delete', '/api/ai/agents/projects/read/extra', '/api/ai/agents/probe', '/api/ai/agents/codex/capabilities/extra']) assert.equal((await handler(new Request(`papertrail://app${path}`, { method: 'POST', body: '{}' }))).status, 404, path);
  assert.equal(calls.length, permitted);
});
test('资料接口仅放行两个 POST 路径，保留 PDF 字节并注入本机凭证', async () => {
  const calls = [];
  const pdf = Buffer.from('%PDF-1.7\nlocal-source');
  const handler = createAppProtocol({ distDirectory: '.', desktopDirectory: '.', getAI: () => ({ baseURL: 'http://127.0.0.1:1234', token: 'source-token' }), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/pdf') ? new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } }) : Response.json({ title: 'Source' });
  } });
  for (const path of ['/api/sources/resolve', '/api/sources/pdf']) {
    const response = await handler(new Request(`papertrail://app${path}`, { method: 'POST', body: '{"url":"https://example.com/paper"}' }));
    assert.equal(response.status, 200);
    assert.deepEqual(calls.at(-1).options.headers, { 'X-Papertrail-Token': 'source-token', 'Content-Type': 'application/json' });
    if (path.endsWith('/pdf')) {
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
    }
  }
  for (const path of ['/api/sources/resolve', '/api/sources/pdf', '/api/sources/arbitrary', '/api/sources/pdf/extra']) {
    assert.equal((await handler(new Request(`papertrail://app${path}`, { method: 'GET' }))).status, 404);
    if (path.includes('extra') || path.includes('arbitrary')) assert.equal((await handler(new Request(`papertrail://app${path}`, { method: 'POST', body: '{}' }))).status, 404);
    assert.equal((await handler(new Request(`papertrail://app${path}?url=https://example.com`, { method: 'POST', body: '{}' }))).status, 404);
  }
  assert.equal(calls.length, 2);
});
test('安装包白名单排除.env、真实材料、测试和Git文件', () => {
  const ignore = config.packagerConfig.ignore;
  for (const file of ['/LICENSE', '/dist/index.html', '/dist/samples/a.pdf', '/desktop/main.mjs', ...['ai', 'sources', 'agents', 'codex-runtime', 'claude-runtime', 'opencode-runtime', 'projects', 'tikhub-tools', 'images'].map(name => `/server/${name}.mjs`), '/node_modules/electron-squirrel-startup/index.js']) assert.equal(ignore(file), false, file);
  for (const file of ['/.env.local', '/desktop/.env.local', '/dist/.env', '/.git/config', '/docs/private.pdf', '/tests/fixtures/a.pdf', '/server/ai.test.mjs', '/server/private.mjs', '/desktop/settings.test.mjs', '/README.md', '/package-lock.json']) assert.equal(ignore(file), true, file);
});
test('生产服务的相对模块依赖都包含在安装包中', async () => {
  const visited = new Set();
  async function visit(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    assert.equal(config.packagerConfig.ignore(`/server/${url.pathname.split('/').at(-1)}`), false, url.pathname);
    const source = await readFile(url, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"](.\/[^'"]+)['"]/g)) await visit(new URL(match[1], url));
  }
  await visit(new URL('../server/ai.mjs', import.meta.url));
  assert.ok(visited.has(new URL('../server/pi-runtime.mjs', import.meta.url).href));
  assert.equal(visited.size, 11);
});
test('仅工作台主框架可写剪贴板，设置页/子框架/读取/外部来源均拒绝', () => {
  const contents = { getURL: () => APP_URL, isDestroyed: () => false };
  const request = { contents, mainContents: contents, permission: 'clipboard-sanitized-write', origin: APP_ORIGIN, details: { isMainFrame: true, requestingUrl: APP_URL } };
  assert.equal(canWriteClipboard(request), true);
  assert.equal(canWriteClipboard({ ...request, origin: APP_URL }), true);
  for (const patch of [{ permission: 'clipboard-read' }, { contents: { ...contents } }, { origin: 'https://example.com' }, { details: { isMainFrame: false, requestingUrl: APP_URL } }, { details: { isMainFrame: true, requestingUrl: 'papertrail://app/desktop-settings' } }]) assert.equal(canWriteClipboard({ ...request, ...patch }), false);
});
