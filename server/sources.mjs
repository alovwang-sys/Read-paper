import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const METADATA_BYTES = 2 * 1024 * 1024;
const PDF_BYTES = 50 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
class SourceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const failure = (message, status = 502) => new SourceError(status, message);
const hostnameOf = url => url.hostname.replace(/^\[|\]$/g, '');

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
      || a === 100 && b >= 64 && b <= 127 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6 || address.includes('%')) return false;
  const parts = address.toLowerCase().split(':');
  const first = parseInt(parts[0] || '0', 16);
  const second = parseInt(parts[1] || '0', 16);
  // Only global unicast; exclude transition/protocol/documentation ranges as well.
  return first >= 0x2000 && first <= 0x3fff && !(first === 0x2001 && second <= 0x1ff)
    && !(first === 0x2001 && second === 0xdb8) && first !== 0x2002 && !(first === 0x3fff && second < 0x1000);
}

export function remoteURL(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw failure('请输入有效的公开网页、DOI 或 arXiv 地址。', 400); }
  const host = hostnameOf(url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096
    || !host || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(host)
    || isIP(host) && !isPublicAddress(host) || url.port && !['80', '443'].includes(url.port)) {
    throw failure('仅支持无登录凭据的公开 HTTP(S) 来源地址。', 400);
  }
  url.hash = '';
  return url;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || failure('获取已取消。', 499);
}

async function resolvedAddresses(url, lookup, signal) {
  throwIfAborted(signal);
  const host = hostnameOf(url);
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || failure('获取已取消。', 499));
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })).then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', abort));
  });
  throwIfAborted(signal);
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
    throw failure('来源地址解析到非公开网络，已停止获取。', 400);
  }
  return addresses;
}

function requestBytes(url, addresses, { maxBytes, signal, requestImpl, accept, stopOnPDF }) {
  return new Promise((resolve, reject) => {
    const send = requestImpl || (url.protocol === 'https:' ? httpsRequest : httpRequest);
    // Pin the verified answers: connection establishment must not perform a second DNS lookup.
    const lookup = (_host, options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      const suitable = addresses.filter(item => !options?.family || item.family === options.family);
      if (!suitable.length) return callback(failure('来源没有可用的公开地址。'));
      if (options?.all) callback(null, suitable);
      else callback(null, suitable[0].address, suitable[0].family);
    };
    const req = send(url, { method: 'GET', signal, lookup, headers: {
      'User-Agent': 'Papertrail/0.1 (personal research library)', Accept: accept, 'Accept-Encoding': 'identity',
    } }, res => {
      const status = res.statusCode || 502;
      if (REDIRECTS.has(status)) {
        const location = res.headers.location;
        res.destroy();
        resolve({ status, headers: res.headers, location, bytes: Buffer.alloc(0) });
        return;
      }
      if (status < 200 || status >= 300) {
        res.destroy();
        reject(failure(status === 401 || status === 403 ? '原网站限制访问，可打开原网页后手动补充全文。'
          : status === 404 ? '原网站未找到这份资料。' : `原网站暂时无法获取（HTTP ${status}），可稍后重试。`));
        return;
      }
      if (stopOnPDF && /^application\/pdf(?:\s*;|$)/i.test(res.headers['content-type'] || '')) {
        res.destroy();
        resolve({ status, headers: res.headers, bytes: Buffer.alloc(0), pdf: true });
        return;
      }
      const encoding = res.headers['content-encoding'];
      if (encoding && encoding !== 'identity') {
        res.destroy(); reject(failure('原网站返回了无法读取的压缩内容，请打开原网页获取。')); return;
      }
      if (Number(res.headers['content-length']) > maxBytes) {
        res.destroy(); reject(failure(`来源文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制，请手动获取。`, 413)); return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(failure('来源内容超过大小限制，请手动获取。', 413)); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('aborted', () => reject(failure('来源连接中断，请重试或手动获取。')));
      res.on('end', () => resolve({ status, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

export function createRemoteReader({ lookup = dnsLookup, requestImpl, timeoutMs = 15_000 } = {}) {
  return async (value, { maxBytes = METADATA_BYTES, signal, stopOnPDF = false, accept = 'text/html, application/xhtml+xml, application/json, application/atom+xml;q=0.9' } = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(failure('获取来源超时，可稍后重试或手动补充。', 504)), timeoutMs);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      let url = remoteURL(value);
      for (let hop = 0; hop <= 5; hop += 1) {
        const addresses = await resolvedAddresses(url, lookup, controller.signal);
        const result = await requestBytes(url, addresses, { maxBytes, signal: controller.signal, requestImpl, accept, stopOnPDF });
        if (!REDIRECTS.has(result.status)) return { ...result, url: url.href };
        if (hop === 5 || !result.location) throw failure('来源重定向过多或地址缺失，请打开原网页获取。');
        url = remoteURL(result.location, url);
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason || failure('获取已取消。', 499);
      if (error instanceof SourceError) throw error;
      throw failure('无法连接来源，可稍后重试或手动补充。');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  };
}

function decode(value = '') {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, key) => {
    if (key[0] !== '#') return entities[key.toLowerCase()] || whole;
    const number = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
  });
}
function plain(value = '', limit = 40_000) {
  return decode(value.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, limit);
}
function attributes(tag) {
  const values = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) values[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4]);
  return values;
}
function optionalURL(value, base) {
  if (!value) return undefined;
  try { return remoteURL(value, base).href; } catch { return undefined; }
}
const DOI = /^10\.\d{4,9}\/[^\s?#]+$/i;
const ARXIV = /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i;
export function normalizeSource(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw failure('请输入有效的来源链接。', 400);
  const input = value.trim();
  const doi = input.replace(/^doi:\s*/i, '');
  const arxiv = input.replace(/^arxiv:\s*/i, '');
  const url = remoteURL(DOI.test(doi) ? `https://doi.org/${doi}` : ARXIV.test(arxiv) ? `https://arxiv.org/abs/${arxiv}` : input);
  const identifiers = { url: url.href };
  if (['doi.org', 'dx.doi.org'].includes(url.hostname)) {
    let id;
    try { id = decodeURIComponent(url.pathname.slice(1)); } catch { throw failure('DOI 地址格式不正确。', 400); }
    if (DOI.test(id)) identifiers.doi = id.toLowerCase();
  }
  if (['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname)) {
    const id = url.pathname.replace(/^\/(?:abs|pdf)\//, '').replace(/\.pdf$/i, '');
    if (ARXIV.test(id)) identifiers.arxiv = id;
  }
  return { url: url.href, title: identifiers.doi || (identifiers.arxiv ? `arXiv:${identifiers.arxiv}` : `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`),
    identifiers, kind: identifiers.doi || identifiers.arxiv ? 'paper' : 'web' };
}

export function parseHTMLMetadata(html, sourceURL, now = new Date().toISOString()) {
  const clean = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  const meta = new Map();
  for (const tag of clean.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = attributes(tag);
    const name = (attrs.name || attrs.property || '').toLowerCase();
    if (!name || !attrs.content) continue;
    meta.set(name, [...(meta.get(name) || []), attrs.content]);
  }
  const first = (...keys) => keys.map(key => meta.get(key)?.[0]).find(Boolean);
  const title = plain(first('citation_title', 'dc.title', 'og:title') || clean.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1], 2000);
  const authors = (meta.get('citation_author') || meta.get('dc.creator') || meta.get('author') || []).map(value => plain(value, 300)).join(', ').slice(0, 4000);
  const year = first('citation_publication_date', 'citation_date', 'dc.date', 'article:published_time')?.match(/\b(?:19|20)\d{2}\b/)?.[0];
  const rawDOI = first('citation_doi', 'dc.identifier');
  const doi = rawDOI?.replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, '').trim();
  const result = { ...(title ? { title } : {}), ...(authors ? { authors } : {}), ...(year ? { year } : {}),
    ...(doi && DOI.test(doi) ? { identifiers: { doi: doi.toLowerCase() }, kind: 'paper' } : {}),
    ...(meta.has('citation_title') ? { kind: 'paper' } : {}) };
  let abstract = first('citation_abstract');
  if (!abstract && ['arxiv.org', 'www.arxiv.org'].includes(new URL(sourceURL).hostname)) {
    abstract = clean.match(/<blockquote\b[^>]*class\s*=\s*["'][^"']*\babstract\b[^"']*["'][^>]*>([\s\S]*?)<\/blockquote\s*>/i)?.[1]?.replace(/<span\b[^>]*>[\s\S]*?<\/span\s*>/i, '');
  }
  if (abstract && plain(abstract)) result.abstract = { text: plain(abstract), url: sourceURL, retrievedAt: now };
  const pdfUrl = optionalURL(first('citation_pdf_url'), sourceURL);
  if (pdfUrl) result.pdfUrl = pdfUrl;
  if (Object.keys(result).length) result.metadataSource = sourceURL;
  return result;
}

function parseArxiv(xml, id, sourceURL, now) {
  const entry = xml.match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/i)?.[1];
  if (!entry) throw failure('arXiv 暂未返回文献信息。');
  const get = name => entry.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1];
  const title = plain(get('title'), 2000);
  if (!title || /^error$/i.test(title)) throw failure('arXiv 未找到该论文。');
  const authors = [...entry.matchAll(/<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map(match => plain(match[1], 300)).join(', ').slice(0, 4000);
  const summary = plain(get('summary'));
  const pdf = (entry.match(/<link\b[^>]*>/gi) || []).map(attributes).find(link => link.type === 'application/pdf' || link.title === 'pdf');
  return { title, ...(authors ? { authors } : {}), ...(get('published')?.match(/\d{4}/) ? { year: get('published').match(/\d{4}/)[0] } : {}),
    ...(summary ? { abstract: { text: summary, url: sourceURL, retrievedAt: now } } : {}), metadataSource: sourceURL,
    pdfUrl: optionalURL(pdf?.href) || `https://arxiv.org/pdf/${id}` };
}

function parseCrossref(json, sourceURL, now) {
  const data = JSON.parse(json).message;
  if (!data || !Array.isArray(data.title) || typeof data.title[0] !== 'string') throw failure('Crossref 暂未返回文献信息。');
  const authors = Array.isArray(data.author) ? data.author.map(item => plain([item.given, item.family].filter(value => typeof value === 'string').join(' ') || item.name || '', 300)).filter(Boolean).join(', ').slice(0, 4000) : '';
  const year = (data.published || data['published-print'] || data['published-online'] || data.issued)?.['date-parts']?.[0]?.[0];
  const text = typeof data.abstract === 'string' ? plain(data.abstract) : '';
  const pdf = Array.isArray(data.link) ? data.link.find(item => item['content-type'] === 'application/pdf' && optionalURL(item.URL)) : undefined;
  return { title: plain(data.title[0], 2000), ...(authors ? { authors } : {}), ...(Number.isInteger(year) ? { year: String(year) } : {}),
    ...(text ? { abstract: { text, url: sourceURL, retrievedAt: now } } : {}), ...(pdf ? { pdfUrl: optionalURL(pdf.URL) } : {}), metadataSource: sourceURL };
}

export function createSourceService(options = {}) {
  const read = createRemoteReader(options);
  const htmlMetadata = (result, now) => result.pdf || result.bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    ? { kind: 'paper', pdfUrl: result.url, warning: '已找到 PDF 链接，取得文件后可核对文献信息。' }
    : parseHTMLMetadata(result.bytes.toString('utf8'), result.url, now);
  return {
    async resolve(value, signal) {
      const candidate = { ...normalizeSource(value), resolvedAt: new Date().toISOString() };
      const merge = metadata => {
        Object.assign(candidate, metadata, { identifiers: { ...candidate.identifiers, ...metadata.identifiers } });
        // arXiv citation_pdf_url often omits the version even on an explicitly versioned abstract page.
        if (/v\d+$/.test(candidate.identifiers.arxiv || '')) candidate.pdfUrl = `https://arxiv.org/pdf/${candidate.identifiers.arxiv}`;
      };
      const now = candidate.resolvedAt;
      try {
        if (candidate.identifiers.arxiv) {
          candidate.pdfUrl = `https://arxiv.org/pdf/${candidate.identifiers.arxiv}`;
          try {
            const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(candidate.identifiers.arxiv)}`;
            const result = await read(url, { signal });
            merge(parseArxiv(result.bytes.toString('utf8'), candidate.identifiers.arxiv, result.url, now));
            return candidate;
          } catch (error) { throwIfAborted(signal); }
          const result = await read(`https://arxiv.org/abs/${candidate.identifiers.arxiv}`, { signal, stopOnPDF: true });
          merge(htmlMetadata(result, now));
        } else if (candidate.identifiers.doi) {
          try {
            const result = await read(`https://api.crossref.org/works/${encodeURIComponent(candidate.identifiers.doi)}`, { signal });
            merge(parseCrossref(result.bytes.toString('utf8'), result.url, now));
            if (candidate.pdfUrl) return candidate;
          } catch (error) { throwIfAborted(signal); }
          const result = await read(candidate.url, { signal, stopOnPDF: true });
          const metadata = htmlMetadata(result, now);
          // Publisher pages may add a PDF, but cannot erase stronger Crossref metadata.
          if (candidate.metadataSource) { if (metadata.pdfUrl) candidate.pdfUrl = metadata.pdfUrl; }
          else merge(metadata);
        } else if (/\.pdf$/i.test(new URL(candidate.url).pathname)) {
          candidate.kind = 'paper';
          candidate.pdfUrl = candidate.url;
          candidate.warning = '已保留 PDF 链接，取得文件后可核对文献信息。';
        } else {
          const result = await read(candidate.url, { signal, stopOnPDF: true });
          merge(htmlMetadata(result, now));
        }
        if (!candidate.metadataSource) candidate.warning ||= '暂未取得文献信息，仍可先收下链接，之后补齐。';
      } catch (error) {
        throwIfAborted(signal);
        candidate.warning = error instanceof SourceError ? error.message : '暂未取得文献信息，仍可先收下链接，之后补齐。';
      }
      return candidate;
    },
    async pdf(value, signal) {
      const url = remoteURL(value);
      const result = await read(url.href, { signal, maxBytes: PDF_BYTES, accept: 'application/pdf, application/octet-stream;q=0.9' });
      if (result.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw failure('下载内容不是有效的 PDF，可能需要登录。请打开原网页后手动补充全文。');
      return result.bytes;
    },
  };
}

async function inputURL(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw failure('请求须使用 application/json。', 415);
  if (Number(req.headers['content-length']) > 16_384) throw failure('来源请求过大。', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw failure('来源请求过大。', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('请求不是有效的 JSON。', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.url !== 'string') throw failure('请求须包含来源 url。', 400);
  return body.url;
}

export function createSourceHandler(options = {}) {
  const service = createSourceService(options);
  return async (req, res, signal) => {
    if (!['/api/sources/resolve', '/api/sources/pdf'].includes(req.url)) return false;
    try {
      if (req.method !== 'POST') throw failure('此接口仅支持 POST。', 405);
      const url = await inputURL(req);
      const result = req.url.endsWith('/pdf') ? await service.pdf(url, signal) : await service.resolve(url, signal);
      if (res.destroyed) return true;
      res.setHeader('Content-Type', Buffer.isBuffer(result) ? 'application/pdf' : 'application/json; charset=utf-8');
      res.end(Buffer.isBuffer(result) ? result : JSON.stringify(result));
    } catch (error) {
      if (!res.destroyed) {
        res.statusCode = error instanceof SourceError ? error.status : 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: error instanceof SourceError ? error.message : '获取来源失败，请重试或手动补充。' }));
      }
    }
    return true;
  };
}
