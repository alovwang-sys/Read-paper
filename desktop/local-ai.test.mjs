import test from 'node:test';
import assert from 'node:assert/strict';
import { request, Server } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { startDesktopAI } from './local-ai.mjs';

const secret = 'desktop-api-key-never-send-to-renderer';
const env = { AI_API_KEY: secret };
const prompt = { requestId: 'desktop-1', purpose: 'chat', messages: [{ role: 'user', content: '解释这段论文。' }] };
const chunk = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const response = (body = `${chunk('桌面回答。')}data: [DONE]\n\n`) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });

function call(service, { path = '/api/ai/config', method = 'GET', body, token = service.token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, service.baseURL), {
      method, agent: false, headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { 'X-Papertrail-Token': token }), ...headers },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('desktop server uses an isolated random loopback port and private token for config and streaming', async () => {
  let calls = 0;
  const service = await startDesktopAI({ env, fetchImpl: async (_url, options) => {
    calls += 1;
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    return response();
  } });
  try {
    assert.match(service.baseURL, /^http:\/\/127\.0\.0\.1:[1-9][0-9]+$/);
    assert.match(service.token, /^[A-Za-z0-9_-]{43}$/);
    for (const token of [null, 'wrong', 'x'.repeat(service.token.length)]) {
      for (const options of [{}, { path: '/api/ai/chat', method: 'POST', body: prompt }]) {
        const res = await call(service, { ...options, token });
        assert.equal(res.status, 403);
        assert.equal(JSON.parse(res.body).code, 'forbidden_token');
      }
    }
    const config = await call(service);
    assert.equal(config.status, 200);
    assert.equal(JSON.parse(config.body).configured, true);
    assert.equal(config.body.includes(secret), false);
    assert.equal(config.body.includes(service.token), false);
    const answer = await call(service, { path: '/api/ai/chat', method: 'POST', body: prompt });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.trim().split('\n').map(JSON.parse), [{ type: 'delta', text: '桌面回答。' }, { type: 'done', model: 'glm-5.3-flash' }]);
    for (const headers of [{ Host: 'attacker.example:8787' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await call(service, { headers })).status, 403);
    }
    assert.equal(calls, 1);
  } finally {
    await service.stop();
  }
  await service.stop();
  await assert.rejects(call(service), (error) => error.code === 'ECONNREFUSED');
});

test('unconfigured desktop server stays in demo mode and tokens differ for every start', async () => {
  const first = await startDesktopAI();
  const second = await startDesktopAI();
  try {
    assert.notEqual(first.token, second.token);
    assert.notEqual(first.baseURL, second.baseURL);
    assert.equal(JSON.parse((await call(first)).body).mode, 'demo');
    assert.equal((await call(first, { path: '/api/ai/chat', method: 'POST', body: prompt })).status, 503);
    assert.equal((await call(first, { token: second.token })).status, 403);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test('stop aborts a pending upstream, destroys an unfinished client connection, and closes the listener', async () => {
  let upstreamSignal;
  let started;
  const upstreamStarted = new Promise((resolve) => { started = resolve; });
  const service = await startDesktopAI({ env, fetchImpl: (_url, { signal }) => {
    upstreamSignal = signal;
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const pending = call(service, { path: '/api/ai/chat', method: 'POST', body: prompt });
  const failedRequest = assert.rejects(pending, (error) => ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code));
  const socket = connect(new URL(service.baseURL).port, '127.0.0.1');
  socket.on('error', () => {});
  try {
    await Promise.all([upstreamStarted, once(socket, 'connect')]);
    socket.write('GET /api/ai/config HTTP/1.1\r\n');
    const disconnected = new Promise((resolve) => socket.once('close', resolve));
    await service.stop();
    await Promise.all([failedRequest, disconnected]);
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(socket.destroyed, true);
    await assert.rejects(call(service), (error) => error.code === 'ECONNREFUSED');
  } finally {
    socket.destroy();
    await service.stop();
  }
});

test('stop cancels an active stream and resolves after its reader is released', async () => {
  let upstreamSignal;
  let upstreamBody;
  const service = await startDesktopAI({ env, fetchImpl: async (_url, { signal }) => {
    upstreamSignal = signal;
    upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk('已收到的部分')));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return response(upstreamBody);
  } });
  try {
    await new Promise((resolve, reject) => {
      const req = request(new URL('/api/ai/chat', service.baseURL), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Papertrail-Token': service.token } }, (res) => {
        res.on('error', () => {});
        res.once('data', () => resolve());
      });
      req.on('error', reject);
      req.end(JSON.stringify(prompt));
    });
    await service.stop();
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(upstreamBody.locked, false);
  } finally {
    await service.stop();
  }
});

test('invalid settings are rejected before a socket can listen, without leaking configuration values', async (t) => {
  let listens = 0;
  const originalListen = Server.prototype.listen;
  t.mock.method(Server.prototype, 'listen', function (...args) {
    listens += 1;
    return originalListen.apply(this, args);
  });
  for (const invalidEnv of [{ AI_BASE_URL: `http://${secret}.example` }, { AI_MODEL: 'invalid model' }, { AI_PORT: 'invalid' }, { AI_APP_PORT: '-1' }]) {
    await assert.rejects(startDesktopAI({ env: { ...env, ...invalidEnv } }), (error) => !error.message.includes(secret));
  }
  assert.equal(listens, 0);
});
