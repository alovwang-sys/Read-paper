const PATH = '/api/ai/literature/search';
const MAX_QUERY_CHARS = 500;
const MAX_BODY_BYTES = 4096;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SELECT = 'id,display_name,publication_year,doi,authorships,abstract_inverted_index,primary_location,best_oa_location,open_access';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class LiteratureError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const invalid = message => new LiteratureError(400, 'invalid_request', message);
const responseError = () => new LiteratureError(502, 'invalid_response', '文献服务返回格式异常，请手动重试。');

function queryValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_QUERY_CHARS || /[\x00-\x1f\x7f]/.test(value)) {
    throw invalid('请填写不超过 500 字符的检索词。');
  }
  return value.trim();
}

function text(value, max) {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
}

function publicURL(value) {
  if (typeof value !== 'string' || value.length > 4000 || /[\x00-\x20\x7f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 4000) return url.href;
  } catch { /* Missing or unsafe links stay absent. */ }
}

function abstractText(index) {
  if (!record(index)) return;
  const words = new Map();
  let chars = 0;
  for (const [word, positions] of Object.entries(index)) {
    if (!word || word.length > 2000 || !Array.isArray(positions) || !positions.length) return;
    for (const position of positions) {
      if (!Number.isInteger(position) || position < 0 || position >= 10_000 || words.has(position)) return;
      chars += word.length + 1;
      if (chars > 50_000) return;
      words.set(position, word);
    }
  }
  if (!words.size) return;
  const ordered = [...words].sort((a, b) => a[0] - b[0]);
  if (ordered.some(([position], index) => position !== index)) return;
  return ordered.map(([, word]) => word).join(' ');
}

function candidatesFrom(payload, retrievedAt) {
  if (!record(payload) || !Array.isArray(payload.results) || payload.results.length > 10) throw responseError();
  const candidates = [];
  let skipped = 0;
  let missing = 0;
  let authorLimit = false;
  const seen = new Set();
  for (const work of payload.results) {
    const providerId = typeof work?.id === 'string' ? /^https:\/\/openalex\.org\/(W\d{1,30})$/.exec(work.id)?.[1] : undefined;
    const title = text(work?.display_name, 2000);
    if (!providerId || !title || seen.has(providerId)) { skipped += 1; continue; }
    seen.add(providerId);
    const authorships = Array.isArray(work.authorships) ? work.authorships : [];
    const authors = authorships.slice(0, 100).map(item => text(item?.author?.display_name, 500) || text(item?.raw_author_name, 500)).filter(Boolean);
    authorLimit ||= authorships.length >= 100;
    const year = Number.isInteger(work.publication_year) && work.publication_year > 0 && work.publication_year < 10_000 ? work.publication_year : undefined;
    const doiURL = publicURL(work.doi);
    const doi = doiURL && /^https:\/\/doi\.org\/(10\.\d{4,9}\/\S+)$/i.exec(doiURL)?.[1];
    const validDoi = doi && doi.length <= 500 ? doi : undefined;
    const abstract = abstractText(work.abstract_inverted_index);
    const url = publicURL(work.primary_location?.landing_page_url) || publicURL(work.best_oa_location?.landing_page_url) || work.id;
    const location = [work.best_oa_location, work.primary_location].find(item => item?.is_oa === true && publicURL(item.pdf_url));
    const pdfUrl = location ? publicURL(location.pdf_url) : undefined;
    if (!authors.length || authors.length !== authorships.length || year === undefined || !validDoi || !abstract) missing += 1;
    candidates.push({ id: `openalex-${providerId}`, provider: 'openalex', providerId, title, authors,
      ...(year !== undefined ? { year } : {}), ...(validDoi ? { doi: validDoi } : {}), url,
      ...(abstract ? { abstract } : {}), ...(pdfUrl ? { pdfUrl } : {}), retrievedAt });
  }
  if (payload.results.length && !candidates.length) throw responseError();
  const warnings = [];
  if (skipped) warnings.push(`${skipped} 条题录缺少有效标识、标题或重复，已跳过。`);
  if (missing) warnings.push(`${missing} 条文献缺少部分作者、年份、DOI 或摘要；未补写缺失信息。`);
  if (authorLimit) warnings.push('部分文献的作者名单达到 API 列表上限，仅显示本次返回的前 100 位。');
  return { candidates, ...(warnings.length ? { warnings, partial: true } : {}) };
}

async function limitedJSON(response, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw responseError();
  }
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new LiteratureError(502, 'response_too_large', '文献服务返回内容过大，请缩小检索词后重试。');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new LiteratureError(502, 'response_too_large', '文献服务返回内容过大，请缩小检索词后重试。');
      chunks.push(value);
    }
    signal.throwIfAborted();
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw responseError(); }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readRequest(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new LiteratureError(415, 'unsupported_media_type', '请求须使用 application/json。');
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new LiteratureError(413, 'request_too_large', '检索请求过大。');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new LiteratureError(413, 'request_too_large', '检索请求过大。');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw invalid('检索请求不是有效 JSON。'); }
  return validateLiteratureQuery(body);
}

export function validateLiteratureQuery(body) {
  if (!record(body) || Object.keys(body).some(key => !['query', 'yearFrom', 'yearTo'].includes(key))) throw invalid('检索请求仅接受 query、yearFrom 和 yearTo。');
  for (const year of [body.yearFrom, body.yearTo]) if (year !== undefined && (!Number.isInteger(year) || year < 1 || year > 9999)) throw invalid('年份须为 1–9999 的整数。');
  if (body.yearFrom !== undefined && body.yearTo !== undefined && body.yearFrom > body.yearTo) throw invalid('起始年份不能晚于截止年份。');
  return { query: queryValue(body.query), yearFrom: body.yearFrom, yearTo: body.yearTo };
}

// Caller origin and optional desktop token are checked by the shared AI handler before dispatch.
export function createLiteratureHandler({ env = process.env, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const controllers = new Set();
  const pending = new Set();
  async function search(input, { signal } = {}) {
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      controller.signal.throwIfAborted();
      const { query, yearFrom, yearTo } = validateLiteratureQuery(input);
      const key = env.OPENALEX_API_KEY?.trim() || '';
      if (key.length > 4096 || /[^\x21-\x7e]/.test(key)) throw new LiteratureError(503, 'configuration_invalid', 'OpenAlex 密钥格式无效，请检查本机 OPENALEX_API_KEY。');
      if (controllers.size >= 2) throw new LiteratureError(429, 'concurrency_limit', '已有两个文献检索正在进行，请等待或停止后重试。');
      controllers.add(controller);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const url = new URL('https://api.openalex.org/works');
      url.search = new URLSearchParams({ search: query, per_page: '10', page: '1', select: SELECT }).toString();
      if (yearFrom !== undefined || yearTo !== undefined) url.searchParams.set('filter', `publication_year:${yearFrom ?? 1}-${yearTo ?? 9999}`);
      const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
      return await Promise.race([aborted, (async () => {
        const response = await fetchImpl(url.href, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if ([401, 403].includes(response.status)) throw new LiteratureError(502, 'authentication_failed', 'OpenAlex 认证失败，请检查本机密钥及其激活状态。');
          if (response.status === 429) throw new LiteratureError(429, 'rate_limited', 'OpenAlex 额度或请求频率受限，请稍后手动重试。');
          if (response.status === 400) throw new LiteratureError(400, 'invalid_query', 'OpenAlex 无法识别此查询，请缩短检索词或调整检索语法。');
          throw new LiteratureError(502, 'upstream_error', 'OpenAlex 暂时不可用，请稍后手动重试。');
        }
        return candidatesFrom(await limitedJSON(response, controller.signal), new Date().toISOString());
      })()]);
    } catch (error) {
      throw timedOut ? new LiteratureError(504, 'timeout', '文献检索超时，请手动重试。')
        : controller.signal.aborted ? new LiteratureError(499, 'aborted', '文献检索已停止。')
        : error instanceof LiteratureError ? error : new LiteratureError(502, 'connection_failed', '无法连接 OpenAlex，请检查网络后手动重试。');
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      signal?.removeEventListener('abort', cancel);
    }
  }
  const track = task => {
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  async function handle(req, res) {
    if (req.url !== PATH) return false;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    req.on('aborted', cancel);
    res.on('close', cancel);
    try {
      if (req.method !== 'POST') throw new LiteratureError(405, 'method_not_allowed', '文献检索仅支持 POST。');
      const result = await handler.search(await readRequest(req), { signal: controller.signal });
      if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify(result));
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      const failure = error instanceof LiteratureError ? error : new LiteratureError(502, 'connection_failed', '无法连接 OpenAlex，请检查网络后手动重试。');
      res.statusCode = failure.status;
      res.end(JSON.stringify({ error: failure.message, code: failure.code }));
    } finally {
      req.off('aborted', cancel);
      res.off('close', cancel);
    }
    return true;
  }
  const handler = (req, res) => track(handle(req, res));
  handler.search = (input, options) => track(search(input, options));
  handler.stop = async () => {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(pending);
  };
  return handler;
}
