import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
test('安装包白名单排除.env、真实材料、测试和Git文件', () => {
  const ignore = config.packagerConfig.ignore;
  for (const file of ['/dist/index.html', '/dist/samples/a.pdf', '/desktop/main.mjs', '/server/ai.mjs', '/node_modules/electron-squirrel-startup/index.js']) assert.equal(ignore(file), false, file);
  for (const file of ['/.env.local', '/.git/config', '/docs/private.pdf', '/tests/fixtures/a.pdf', '/server/ai.test.mjs', '/desktop/settings.test.mjs', '/README.md', '/package-lock.json']) assert.equal(ignore(file), true, file);
});
test('仅工作台主框架可写剪贴板，设置页/子框架/读取/外部来源均拒绝', () => {
  const contents = { getURL: () => APP_URL, isDestroyed: () => false };
  const request = { contents, mainContents: contents, permission: 'clipboard-sanitized-write', origin: APP_ORIGIN, details: { isMainFrame: true, requestingUrl: APP_URL } };
  assert.equal(canWriteClipboard(request), true);
  assert.equal(canWriteClipboard({ ...request, origin: APP_URL }), true);
  for (const patch of [{ permission: 'clipboard-read' }, { contents: { ...contents } }, { origin: 'https://example.com' }, { details: { isMainFrame: false, requestingUrl: APP_URL } }, { details: { isMainFrame: true, requestingUrl: 'papertrail://app/desktop-settings' } }]) assert.equal(canWriteClipboard({ ...request, ...patch }), false);
});
