import { createServer } from 'node:http';
import { once } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createAgentHandler } from './agents.mjs';
import { createSourceHandler } from './sources.mjs';
import { IMAGE_LIMITS, decodeImageDataURL } from './images.mjs';
import { runPiCompletion } from './pi-runtime.mjs';
import { createLiteratureHandler } from './literature.mjs';
import { createResearchHandler } from './research.mjs';

const LIMITS = Object.freeze({ maxInputChars: 120_000, ...IMAGE_LIMITS });
const MAX_BODY_BYTES = LIMITS.maxInputChars * 6 + Math.ceil(LIMITS.maxImageBytes / 3) * 4 * LIMITS.maxImages + 4096;
const DEFAULT_BASE = 'https://open.bigmodel.cn/api/coding/paas/v4';

class AIError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (message = '请求格式不正确。') => new AIError(400, 'invalid_request', message);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value, keys) => Object.keys(value).every((key) => keys.includes(key));

function settings(env) {
  const model = env.AI_MODEL?.trim() || 'glm-5.3-flash';
  const port = Number(env.AI_PORT || 8787);
  const appPort = Number(env.AI_APP_PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(appPort) || appPort < 1 || appPort > 65535) {
    throw new Error('AI_PORT / AI_APP_PORT 必须是有效端口。');
  }
  let base;
  try { base = new URL(env.AI_BASE_URL?.trim() || DEFAULT_BASE); }
  catch { throw new Error('AI_BASE_URL 必须是有效的 HTTPS 地址。'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('AI_BASE_URL 必须是无认证信息与查询参数的 HTTPS 地址。');
  }
  if (!/^[a-zA-Z0-9._:/-]{1,100}$/.test(model)) throw new Error('AI_MODEL 格式不正确。');
  const key = env.AI_API_KEY?.trim() || '';
  if (key.length > 4096 || /[^\x21-\x7E]/.test(key)) {
    throw new Error('API 密钥格式不正确：请只粘贴控制台密钥，不要包含说明文字、内部空白或非英文字符。');
  }
  return {
    model, port,
    key,
    endpoint: `${base.href.replace(/\/$/, '')}/chat/completions`,
    images: env.AI_IMAGES === 'true',
    ports: new Set([port, appPort, 5173, 5174, 4173]),
  };
}

function publicSettings(config) {
  return { configured: Boolean(config.key), model: config.model, provider: '智谱', images: config.images, mode: config.key ? 'live' : 'demo', runtime: 'pi', tools: [], limits: LIMITS };
}

export function validateAISettings(env = process.env) {
  return publicSettings(settings(env));
}

function localURL(value, ports) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && ports.has(Number(url.port)) && !url.username && !url.password && url.pathname === '/'
      && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function checkCaller(req, config) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (!host || !localURL(`http://${host}`, config.ports)
    || (origin !== undefined && (!localURL(origin, config.ports) || new URL(origin).origin !== origin))
    || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new AIError(403, 'forbidden_origin', 'AI 服务仅允许本机工作台访问。');
  }
}

function checkToken(req, token) {
  if (token === undefined) return;
  const actual = req.headers['x-papertrail-token'];
  const expectedBytes = Buffer.from(token);
  const actualBytes = typeof actual === 'string' ? Buffer.from(actual) : Buffer.alloc(0);
  if (!expectedBytes.length || actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new AIError(403, 'forbidden_token', 'AI 服务访问凭证无效。');
  }
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new AIError(415, 'unsupported_media_type', '请求须使用 application/json。');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new AIError(413, 'request_too_large', '发送内容过大，请缩小材料范围。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AIError(413, 'request_too_large', '发送内容过大，请缩小材料范围。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw invalid('请求不是有效的 JSON。');
  }
}

function imageURL(part, config) {
  if (!config.images) throw new AIError(400, 'images_unsupported', '当前模型连接未启用图片，请使用文字证据。');
  if (!isRecord(part.image_url) || !hasOnly(part.image_url, ['url']) || typeof part.image_url.url !== 'string') throw invalid();
  const url = part.image_url.url;
  try { decodeImageDataURL(url); }
  catch (error) { throw new AIError(error.status, error.code, error.message); }
  return { type: 'image_url', image_url: { url } };
}

function validateRequest(body, config) {
  if (!isRecord(body) || !hasOnly(body, ['requestId', 'purpose', 'messages'])
    || typeof body.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.requestId)
    || !['chat', 'card', 'revision'].includes(body.purpose)
    || !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 128) throw invalid();
  let chars = 0;
  let images = 0;
  const text = (value) => {
    if (typeof value !== 'string' || !value.trim()) throw invalid('消息内容不能为空。');
    chars += value.length;
    if (chars > LIMITS.maxInputChars) throw new AIError(413, 'context_too_large', '问题、历史与材料超过 120,000 字符，请缩小范围或新建对话。');
    return value;
  };
  const messages = body.messages.map((message) => {
    if (!isRecord(message) || !hasOnly(message, ['role', 'content']) || !['system', 'user', 'assistant'].includes(message.role)) throw invalid();
    if (typeof message.content === 'string') return { role: message.role, content: text(message.content) };
    if (!Array.isArray(message.content) || message.content.length === 0 || message.content.length > 128) throw invalid();
    return {
      role: message.role,
      content: message.content.map((part) => {
        if (!isRecord(part)) throw invalid();
        if (part.type === 'text' && hasOnly(part, ['type', 'text'])) return { type: 'text', text: text(part.text) };
        if (part.type !== 'image_url' || message.role !== 'user' || !hasOnly(part, ['type', 'image_url'])) throw invalid();
        images += 1;
        if (images > LIMITS.maxImages) throw new AIError(413, 'too_many_images', '一次最多发送 4 张图片。');
        return imageURL(part, config);
      }),
    };
  });
  if (!messages.some((message) => message.role === 'user') || messages.at(-1).role !== 'user') throw invalid('请求必须以用户问题结束。');
  return { requestId: body.requestId, messages };
}

async function* sseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let data = [];
  let eventSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1_000_000) throw new AIError(502, 'invalid_stream', '模型响应格式异常，请重试。');
      while (true) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0 || (!done && end === buffer.length - 1 && buffer[end] === '\r')) break;
        const line = buffer.slice(0, end);
        const delimiter = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(end + delimiter);
        if (!line) {
          if (data.length) yield data.join('\n');
          data = [];
          eventSize = 0;
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '');
          eventSize += value.length;
          if (eventSize > 1_000_000) throw new AIError(502, 'invalid_stream', '模型响应格式异常，请重试。');
          data.push(value);
        }
      }
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
        if (data.length) yield data.join('\n');
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* readCompletionStream(body) {
  let hasContent = false;
  for await (const data of sseData(body)) {
    if (data.trim() === '[DONE]') {
      if (!hasContent) throw new AIError(502, 'empty_response', '模型没有返回可见回答，请重试。');
      yield { type: 'done' };
      return;
    }
    let event;
    try { event = JSON.parse(data); } catch { throw new AIError(502, 'invalid_stream', '模型响应格式异常，已保留收到的部分。'); }
    if (!isRecord(event) || event.error) throw new AIError(502, 'upstream_error', '模型返回错误，已保留收到的部分，请重试。');
    if (event.choices !== undefined && !Array.isArray(event.choices)) throw new AIError(502, 'invalid_stream', '模型响应格式异常，已保留收到的部分。');
    for (const choice of event.choices || []) {
      if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
        hasContent = true;
        yield { type: 'delta', text: choice.delta.content };
      }
      if (choice?.finish_reason != null) {
        if (choice.finish_reason === 'length') throw new AIError(502, 'output_limit', '模型回答达到输出上限，已保留收到的部分，请缩小问题后重试。');
        if (choice.finish_reason !== 'stop') throw new AIError(502, 'incomplete_response', '模型未完整回答，已保留收到的部分，请调整问题后重试。');
        if (!hasContent) throw new AIError(502, 'empty_response', '模型没有返回可见回答，请重试。');
        yield { type: 'done' };
        return;
      }
    }
  }
  throw new AIError(502, 'stream_interrupted', '模型连接意外中断，已保留收到的部分，请重试。');
}

function upstreamError(status) {
  if (status === 401 || status === 403) return new AIError(502, 'authentication_failed', '模型认证失败，请检查本地服务的密钥与权限。');
  if (status === 429) return new AIError(429, 'rate_limited', '模型额度或并发受限，请稍后手动重试。');
  return new AIError(502, 'upstream_error', '模型服务暂时不可用，请稍后手动重试。');
}

export function createAIHandler({ env = process.env, fetchImpl = fetch, timeoutMs = 120_000, localToken, agentRuntimes, sourceOptions } = {}) {
  const config = settings(env);
  const agents = createAgentHandler({ env, runtimes: agentRuntimes, ports: [...config.ports] });
  const sources = createSourceHandler(sourceOptions);
  const literature = createLiteratureHandler({ env, fetchImpl });
  const research = createResearchHandler({ env, runtimes: agentRuntimes, ports: [...config.ports], searchLiterature: literature.search });
  const active = new Set();
  const controllers = new Set();
  const pending = new Set();
  async function handleAI(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let requestId;
    let timeout;
    let timedOut = false;
    let terminalSent = false;
    const controller = new AbortController();
    controllers.add(controller);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    req.on('aborted', cancel);
    res.on('close', cancel);
    const send = async (event) => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      const flushed = res.write(`${JSON.stringify(event)}\n`);
      if (event.type === 'done' || event.type === 'error') {
        terminalSent = true;
        clearTimeout(timeout);
      } else if (!flushed) {
        await once(res, 'drain', { signal: controller.signal });
      }
    };
    try {
      checkCaller(req, config);
      checkToken(req, localToken);
      if (await sources(req, res, controller.signal)) return;
      if (await research(req, res)) return;
      if (await literature(req, res)) return;
      if (await agents(req, res)) return;
      if (req.url === '/api/ai/config' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(publicSettings(config)));
        return;
      }
      if (req.url !== '/api/ai/chat') throw new AIError(404, 'not_found', '接口不存在。');
      if (req.method !== 'POST') throw new AIError(405, 'method_not_allowed', '此接口仅支持 POST。');
      if (!config.key) throw new AIError(503, 'not_configured', '尚未配置模型密钥，请启动已配置的本地 AI 服务。');
      const validated = validateRequest(await readBody(req), config);
      if (active.has(validated.requestId)) throw new AIError(409, 'request_in_progress', '此请求正在生成，请勿重复发送。');
      if (active.size >= 2) throw new AIError(429, 'concurrency_limit', '已有两个请求正在生成，请等待或停止后重试。');
      requestId = validated.requestId;
      active.add(requestId);
      timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      await runPiCompletion({
        model: config.model, messages: validated.messages, images: config.images, signal: controller.signal,
        onDelta: (text) => send({ type: 'delta', text }),
        streamCompletion: async function* (messages, signal) {
          const upstream = await fetchImpl(config.endpoint, {
            method: 'POST', signal, redirect: 'error',
            headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify({ model: config.model, messages, stream: true, reasoning_effort: 'low', max_tokens: 8192 }),
          });
          if (!upstream.ok) {
            await upstream.body?.cancel().catch(() => {});
            throw upstreamError(upstream.status);
          }
          if (!upstream.body || !/^text\/event-stream(?:\s*;|$)/i.test(upstream.headers.get('content-type') || '')) {
            await upstream.body?.cancel().catch(() => {});
            throw new AIError(502, 'invalid_stream', '模型未返回流式回答，请检查模型连接。');
          }
          yield* readCompletionStream(upstream.body);
        },
      });
      controller.signal.throwIfAborted();
      await send({ type: 'done', model: config.model });
      res.end();
    } catch (error) {
      if (res.destroyed || (controller.signal.aborted && !timedOut)) return;
      if (terminalSent) { res.end(); return; }
      const failure = timedOut ? new AIError(504, 'timeout', '模型响应超过 120 秒，已保留收到的部分，请手动重试。')
        : error instanceof AIError ? error : new AIError(502, 'connection_failed', '无法连接模型服务，已保留收到的部分，请手动重试。');
      if (!res.headersSent) res.statusCode = failure.status;
      await send({ type: 'error', error: failure.message, code: failure.code }).catch(() => {});
      res.end();
    } finally {
      clearTimeout(timeout);
      if (requestId) active.delete(requestId);
      controllers.delete(controller);
      req.off('aborted', cancel);
      res.off('close', cancel);
    }
  }
  const handler = (req, res) => {
    const task = handleAI(req, res);
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  handler.stop = async () => {
    const agentsClosed = agents.close();
    research.close();
    const literatureClosed = literature.stop();
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...pending, agentsClosed, literatureClosed]);
  };
  return handler;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.loadEnvFile('.env.local'); } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法加载 .env.local，请检查文件格式。'); }
  const handler = createAIHandler();
  const port = Number(process.env.AI_PORT || 8787);
  const server = createServer(handler);
  server.requestTimeout = 30_000;
  server.listen(port, '127.0.0.1', () => { console.log(`本地 AI 服务已启动：http://127.0.0.1:${port}`); });
  const close = () => { server.close(); void handler.stop().finally(() => server.closeAllConnections()); };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
