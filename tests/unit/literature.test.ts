import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchLiterature } from '../../src/services/literature';

afterEach(() => { vi.unstubAllGlobals(); });
const candidate = {
  id: 'openalex-W1', provider: 'openalex', providerId: 'W1', title: 'A paper', authors: [],
  url: 'https://openalex.org/W1', retrievedAt: '2026-10-20T00:00:00.000Z',
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('literature search transport', () => {
  it('sends only the explicit query and preserves missing metadata and warnings', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ candidates: [candidate], partial: true, warnings: ['摘要缺失'] }));
    vi.stubGlobal('fetch', fetch);
    const result = await searchLiterature(' focused question ');
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/ai/literature/search');
    expect(JSON.parse(options.body)).toEqual({ query: 'focused question' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ candidates: [candidate], partial: true, warnings: ['摘要缺失'] });
  });
  it('rejects blank, multiline and overlong queries before a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const query of ['', '  ', 'x'.repeat(501), 'a\nb']) await expect(searchLiterature(query)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('forwards only explicitly selected inclusive year bounds', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(response({ candidates: [] })));
    vi.stubGlobal('fetch', fetch);
    for (const filters of [{ yearFrom: 2020, yearTo: 2024 }, { yearFrom: 1 }, { yearTo: 9999 }, { yearFrom: 2024, yearTo: 2024 }]) {
      await searchLiterature('query', filters);
      expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toEqual({ query: 'query', ...filters });
    }
  });
  it('rejects invalid, reversed and unknown filter options without making a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const filters of [{ yearFrom: 0 }, { yearTo: 10000 }, { yearFrom: 2020.5 }, { yearTo: Number.NaN }, { yearFrom: 2025, yearTo: 2020 }, { yearFrom: 2020, filter: 'is_oa:true' }]) {
      await expect(searchLiterature('query', filters)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('distinguishes an empty result from malformed or invented candidates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ candidates: [] })));
    await expect(searchLiterature('query')).resolves.toEqual({ candidates: [] });
    for (const body of [{}, { candidates: [{ ...candidate, providerId: 'invented' }] }, { candidates: [{ ...candidate, title: 'x'.repeat(2001) }] }, { candidates: Array(11).fill(candidate) }, { candidates: [], warnings: [true] }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
      await expect(searchLiterature('query')).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
  it('preserves server failure codes and distinguishes network failure', async () => {
    for (const code of ['authentication_failed', 'rate_limited', 'timeout', 'invalid_query']) {
      const fetch = vi.fn().mockResolvedValue(response({ code, error: '请重试' }, 502));
      vi.stubGlobal('fetch', fetch);
      await expect(searchLiterature('query')).rejects.toMatchObject({ code });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network error')));
    await expect(searchLiterature('query')).rejects.toMatchObject({ code: 'connection_failed' });
  });
  it('does not send an already canceled request and forwards active cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(searchLiterature('query', { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(fetch).not.toHaveBeenCalled();
    const active = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })));
    const request = searchLiterature('query', { signal: active.signal });
    active.abort();
    await expect(request).rejects.toMatchObject({ code: 'aborted' });
  });
});
