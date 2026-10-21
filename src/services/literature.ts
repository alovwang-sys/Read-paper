import type { LiteratureCandidate } from '../domain/types';
import { validateLiteratureCandidate } from '../domain/research';

export type LiteratureSearchResult = { candidates: LiteratureCandidate[]; warnings?: string[]; partial?: boolean };
export type LiteratureSearchOptions = { signal?: AbortSignal; yearFrom?: number; yearTo?: number };
export class LiteratureError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'LiteratureError'; this.code = code; }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function validCandidate(value: unknown): value is LiteratureCandidate {
  try {
    validateLiteratureCandidate(value);
    return /^W\d{1,30}$/.test(value.providerId) && value.id === `openalex-${value.providerId}`
      && value.authors.length <= 100 && value.url.startsWith('https://') && Number.isFinite(Date.parse(value.retrievedAt));
  } catch { return false; }
}

export async function searchLiterature(query: string, options: LiteratureSearchOptions = {}): Promise<LiteratureSearchResult> {
  if (!query.trim() || query.length > 500 || /[\x00-\x1f\x7f]/.test(query)) throw new LiteratureError('invalid_request', '请填写不超过 500 字符的检索词。');
  if (Object.keys(options).some(key => !['signal', 'yearFrom', 'yearTo'].includes(key))
    || [options.yearFrom, options.yearTo].some(year => year !== undefined && (!Number.isInteger(year) || year < 1 || year > 9999))
    || options.yearFrom !== undefined && options.yearTo !== undefined && options.yearFrom > options.yearTo) throw new LiteratureError('invalid_request', '请填写有效年份范围：1–9999 的整数，起始年份不晚于截止年份。');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    controller.signal.throwIfAborted();
    const response = await fetch('/api/ai/literature/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ query: query.trim(), ...(options.yearFrom !== undefined ? { yearFrom: options.yearFrom } : {}), ...(options.yearTo !== undefined ? { yearTo: options.yearTo } : {}) }) });
    const body: unknown = await response.json().catch(() => { throw new LiteratureError('invalid_response', '文献服务返回格式异常，请检查本机服务后重试。'); });
    if (!response.ok) throw new LiteratureError(record(body) && typeof body.code === 'string' ? body.code : 'upstream_error', record(body) && typeof body.error === 'string' ? body.error : '文献检索失败，请手动重试。');
    if (!record(body) || !Array.isArray(body.candidates) || body.candidates.length > 10 || !body.candidates.every(validCandidate)
      || (body.warnings !== undefined && (!Array.isArray(body.warnings) || !body.warnings.every(value => typeof value === 'string')))
      || (body.partial !== undefined && typeof body.partial !== 'boolean')) throw new LiteratureError('invalid_response', '文献服务返回格式异常，请手动重试。');
    return { candidates: body.candidates, ...(body.warnings ? { warnings: body.warnings as string[] } : {}), ...(body.partial !== undefined ? { partial: body.partial } : {}) };
  } catch (error) {
    if (timedOut) throw new LiteratureError('timeout', '文献检索超时，请手动重试。');
    if (controller.signal.aborted) throw new LiteratureError('aborted', '文献检索已停止。');
    if (error instanceof LiteratureError) throw error;
    throw new LiteratureError('connection_failed', '无法连接文献服务，请检查本机服务和网络后重试。');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
