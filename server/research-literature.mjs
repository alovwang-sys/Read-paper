import { validateLiteratureQuery } from './literature.mjs';

export const RESEARCH_LITERATURE_TOOLS = [{
  type: 'function', name: 'search_literature',
  description: '仅在用户明确要求找新论文时，用提炼的关键词检索 OpenAlex。最多返回 10 条真实题录及来源摘要，不读取 PDF，不自动收录。不要发送用户整段问题、历史、图片或私有论文原文。每轮最多检索 3 次；候选不构成已核实的原文证据。回答用题名和来源链接，不给候选编造 PDF 引用编号 [n]。',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['query'],
    properties: { query: { type: 'string', minLength: 1, maxLength: 500 }, yearFrom: { type: 'integer', minimum: 1, maximum: 9999 }, yearTo: { type: 'integer', minimum: 1, maximum: 9999 } },
  },
}];

const result = (success, value) => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const knownCodes = new Set(['invalid_request', 'configuration_invalid', 'concurrency_limit', 'authentication_failed', 'rate_limited', 'invalid_query', 'upstream_error', 'connection_failed', 'invalid_response', 'response_too_large', 'timeout', 'aborted']);

export function createResearchLiterature({ search, signal, onSearch = () => {} } = {}) {
  const searches = [];
  const publish = item => onSearch(structuredClone(item));
  const check = () => { if (signal?.aborted) throw failure(499, 'aborted', '文献检索已停止。'); };
  return {
    definitions: RESEARCH_LITERATURE_TOOLS,
    async call(args) {
      check();
      let query;
      try { query = validateLiteratureQuery(args); }
      catch (error) { return result(false, { error: error.message, code: 'invalid_request' }); }
      if (typeof search !== 'function') return result(false, { error: '文献检索服务尚未连接，不能生成或编造候选。', code: 'unavailable' });
      if (searches.length >= 3) return result(false, { error: '本轮已检索 3 次，请根据已有结果继续，或在下一轮调整关键词。', code: 'search_limit' });
      const item = { id: `literature-${searches.length + 1}`, ...query, createdAt: new Date().toISOString(), status: 'searching', candidates: [] };
      searches.push(item);
      publish(item);
      try {
        const found = await search(query, { signal });
        check();
        Object.assign(item, structuredClone(found), { status: 'done' });
        publish(item);
        return result(true, { ...item, scope: 'OpenAlex 返回的题录与来源摘要；未读取 PDF，尚未加入资料库。用户可在本条消息中选择收录。用题名与来源链接讨论候选，不把候选当作 PDF 引用编号 [n]。' });
      } catch (error) {
        const stopped = signal?.aborted || error?.code === 'aborted';
        const safe = stopped ? failure(499, 'aborted', '文献检索已停止。')
          : knownCodes.has(error?.code) && typeof error?.status === 'number' ? error
            : failure(502, 'connection_failed', '无法连接文献检索服务，请稍后重试。');
        Object.assign(item, { status: stopped ? 'stopped' : 'error', error: safe.message, errorCode: safe.code });
        publish(item);
        if (signal?.aborted) throw safe;
        return result(false, { error: safe.message, code: safe.code });
      }
    },
    get searches() { return structuredClone(searches); },
  };
}
