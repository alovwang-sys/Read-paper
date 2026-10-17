import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export const APP_ORIGIN = 'papertrail://app';
export const APP_URL = `${APP_ORIGIN}/`;
export const SETTINGS_URL = `${APP_ORIGIN}/desktop-settings`;
export function canWriteClipboard({ contents, mainContents, permission, details, origin = APP_ORIGIN }) {
  return Boolean(mainContents && contents === mainContents && !contents.isDestroyed() && contents.getURL() === APP_URL
    && permission === 'clipboard-sanitized-write' && details?.isMainFrame === true && details.requestingUrl === APP_URL && (origin === APP_ORIGIN || origin === APP_URL));
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
const readableAPI = new Set(['/api/ai/config', '/api/ai/agents', '/api/ai/agents/codex/capabilities']);
const writableAPI = new Set(['/api/ai/chat', '/api/ai/agents/run', '/api/ai/agents/respond', '/api/ai/agents/stop',
  ...['browse', 'preview', 'bind', 'status', 'list', 'read', 'defaults', 'sync'].map(action => `/api/ai/agents/projects/${action}`)]);

export function createAppProtocol({ distDirectory, desktopDirectory, getAI, fetchImpl = fetch }) {
  return async (request) => {
    const url = new URL(request.url);
    if (url.protocol !== 'papertrail:' || url.hostname !== 'app' || url.port || url.username || url.password) return new Response('Forbidden', { status: 403 });
    if (url.pathname.startsWith('/api/')) {
      const allowed = request.method === 'GET' && readableAPI.has(url.pathname) || request.method === 'POST' && writableAPI.has(url.pathname);
      if (!allowed || url.search || url.hash) return new Response('Not found', { status: 404 });
      const ai = getAI();
      if (!ai) return Response.json({ error: '模型连接正在更新，请稍后重试。' }, { status: 503 });
      try {
        const response = await fetchImpl(`${ai.baseURL}${url.pathname}`, {
          method: request.method, signal: request.signal, redirect: 'error',
          headers: { 'X-Papertrail-Token': ai.token, ...(request.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
          ...(request.method === 'POST' ? { body: request.body, duplex: 'half' } : {}),
        });
        return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      } catch { return Response.json({ error: '模型连接已中断，请重新连接。' }, { status: 503 }); }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    let filename;
    try {
      if (url.pathname === '/desktop-settings' || url.pathname === '/desktop-settings.js' || url.pathname === '/desktop-settings.css') {
        filename = resolve(desktopDirectory, url.pathname === '/desktop-settings' ? 'settings.html' : url.pathname.endsWith('.js') ? 'settings-ui.js' : 'settings.css');
      } else {
        const root = resolve(distDirectory);
        filename = resolve(root, url.pathname === '/' ? 'index.html' : `.${decodeURIComponent(url.pathname)}`);
        if (!filename.startsWith(`${root}${sep}`)) return new Response('Forbidden', { status: 403 });
      }
      const content = await readFile(filename);
      return new Response(request.method === 'HEAD' ? null : content, { headers: { 'Content-Type': types[extname(filename)] || 'application/octet-stream', 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' } });
    } catch { return new Response('Not found', { status: 404 }); }
  };
}
