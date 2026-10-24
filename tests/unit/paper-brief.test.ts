import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { getAsset, loadWorkspace, saveMigrationBackup, saveWorkspace } from '../../src/data/storage';
import { validateReaderContext } from '../../src/domain/reader-context';
import { preparePaperBrief, stopPaperBriefs } from '../../src/services/paper-brief';
import { createInlineCardDraft, createInlineConversation } from '../../src/services/inline-ai';
import { demoResponder, regenerateAI, skipPaperBrief, stopAI, submitAI, type AIResponder } from '../../src/services/ai';
import { readerActivities, recordReaderAction } from '../../src/services/reader-actions';
import { workspace } from '../../src/services/workspace';
import { loadPdfDocument } from '../../src/services/pdf';
import type { AIRequest } from '../../src/domain/types';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn(), contentHash: vi.fn() }));
vi.mock('../../src/services/pdf', () => ({ loadPdfDocument: vi.fn() }));
const data = () => workspace.getState().data;
const selection = { documentId: 'paper-a', pageIndex: 0, quote: 'same text', textAnchor: { start: 10, end: 19 } };
const result = { body: '本篇讨论检索条件与证据的相关性；未覆盖部分未知。', rawBody: '本篇讨论检索条件与证据的相关性；未覆盖部分未知。', evidenceIds: [], model: 'test-model' };
const answer: AIResponder = async request => request.purpose === 'brief' ? structuredClone(result) : ({ body: '只回答本处 [1]', evidenceIds: [request.context[0].evidenceId] });
const question = (conversationId: string): AIRequest => ({ id: 'question', conversationId, researchId: 'research-a', prompt: 'question', context: [], createdAt: new Date().toISOString(), status: 'generating', body: '', evidenceIds: [], connectionId: 'model' });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (problem: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const pdfFixture = () => ({ hash: 'a'.repeat(64), pdf: { numPages: 1, getPage: vi.fn(async () => ({ getTextContent: vi.fn(async () => ({ items: [{ str: 'readable fixture text' }] })) })) } });

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(saveWorkspace).mockResolvedValue(undefined); vi.mocked(saveMigrationBackup).mockResolvedValue(undefined); vi.mocked(getAsset).mockResolvedValue(new Blob(['PDF']));
  const seed = createSeed(); seed.documents['paper-a'].hash = 'a'.repeat(64); seed.documents['paper-a'].pageCount = 3;
  vi.mocked(loadWorkspace).mockResolvedValue(seed); await workspace.load();
  vi.mocked(loadPdfDocument).mockReset().mockResolvedValue({ hash: 'a'.repeat(64), pdf: { numPages: 3, getPage: vi.fn(async (page: number) => ({ getTextContent: async () => ({ items: page === 2 ? [] : [{ str: page === 1 ? 'a'.repeat(7000) : 'last readable page' }] }) })) } } as never);
});
afterEach(async () => { await stopPaperBriefs(); await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('文章简要与原文操作', () => {
  it('精确位置区分同页重复句，翻译任务不复用提问历史', () => {
    const a = createInlineConversation('research-a', selection);
    expect(createInlineConversation('research-a', selection)).toBe(a);
    const b = createInlineConversation('research-a', { ...selection, textAnchor: { start: 50, end: 59 } });
    const translated = createInlineConversation('research-a', selection, { operation: 'translation' });
    expect(b).not.toBe(a); expect(translated).not.toBe(a);
    expect(data().conversations[translated].inlineSource?.evidenceId).toBe(data().conversations[a].inlineSource?.evidenceId);
    expect(readerActivities(data(), data().conversations[a].inlineSource!.evidenceId)).toEqual([]);
  });

  it('两处首问共用一个生成任务，记录真实覆盖和截断，快照互不改变', async () => {
    const a = createInlineConversation('research-a', selection), b = createInlineConversation('research-a', { ...selection, pageIndex: 2 });
    let release!: () => void;
    const generate = vi.fn(async (_request: AIRequest) => { await new Promise<void>(resolve => release = resolve); return structuredClone(result); });
    const first = preparePaperBrief(question(a), generate), second = preparePaperBrief(question(b), generate);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(generate.mock.calls[0][0]).toMatchObject({ purpose: 'brief', context: [], history: [] });
    release(); const [one, two] = await Promise.all([first, second]);
    expect(one.pageIndices).toEqual([0, 2]); expect(one.truncatedPageIndices).toEqual([0]); expect(one.totalPages).toBe(3);
    expect(one.body).toBe(result.body);
    expect(one).toEqual(two); one.body = 'changed'; expect(two.body).not.toBe('changed');
    expect(data().documents['paper-a'].paperBrief?.body).not.toBe('changed');
    await preparePaperBrief(question(a), generate); expect(generate).toHaveBeenCalledTimes(1);
    validateReaderContext(data());
  });

  it('失败可重试，简要与官方摘要分别保存', async () => {
    const id = createInlineConversation('research-a', selection);
    const generate = vi.fn().mockRejectedValueOnce(new Error('brief failed')).mockResolvedValue(result);
    const original = structuredClone(data().documents['paper-a'].abstract);
    await expect(preparePaperBrief(question(id), generate)).rejects.toThrow('brief failed');
    expect(data().documents['paper-a'].paperBrief?.status).toBe('error');
    await preparePaperBrief(question(id), generate);
    expect(data().documents['paper-a'].paperBrief?.status).toBe('ready'); expect(data().documents['paper-a'].abstract).toEqual(original);
  });

  it('实际问答冻结共享简要但只带本位置历史，手动操作与请求可回查', async () => {
    const a = createInlineConversation('research-a', selection);
    const one = await submitAI('research-a', a, 'A question', answer);
    const b = createInlineConversation('research-a', { ...selection, textAnchor: { start: 50, end: 59 } });
    const two = await submitAI('research-a', b, 'B question', answer);
    expect(data().requests[one].status).toBe('done'); expect(data().requests[two].status).toBe('done');
    expect(data().requests[two].history).toEqual([]); expect(data().requests[two].paperBrief?.key).toBe(data().requests[one].paperBrief?.key);
    expect(data().requests[two].materials?.[0].kind).toBe('background'); expect(data().requests[two].context).toHaveLength(1);
    const three = await submitAI('research-a', a, 'A follow up', answer);
    expect(data().requests[three].history?.map(turn => turn.prompt)).toEqual(['A question']);
    const evidenceId = data().conversations[a].inlineSource!.evidenceId;
    recordReaderAction(evidenceId, 'highlight'); recordReaderAction(evidenceId, 'highlight');
    expect(readerActivities(data(), evidenceId).map(item => item.kind).sort()).toEqual(['highlight', 'question', 'question']);
    validateReaderContext(data());
  });

  it('停止一处不取消另一处等待的简要任务', async () => {
    const a = createInlineConversation('research-a', selection), b = createInlineConversation('research-a', { ...selection, pageIndex: 2 });
    let release!: () => void, briefCalls = 0;
    const responder: AIResponder = async (request, options) => { if (request.purpose === 'brief') { briefCalls++; await new Promise<void>(resolve => release = resolve); return result; } return answer(request, options); };
    const first = submitAI('research-a', a, 'A', responder), second = submitAI('research-a', b, 'B', responder);
    await vi.waitFor(() => expect(briefCalls).toBe(1));
    const aRequest = data().conversations[a].requestIds[0]; stopAI(aRequest); release();
    const [, bRequest] = await Promise.all([first, second]);
    expect(data().requests[aRequest].status).toBe('stopped'); expect(data().requests[bRequest].status).toBe('done');
    expect(data().requests[bRequest].paperBrief?.version).toBe(1); expect(readerActivities(data(), data().conversations[a].inlineSource!.evidenceId)[0].status).toBe('stopped');
  });

  it('只按选区回答不被稍后简要改写，翻译也不读取整篇', async () => {
    const a = createInlineConversation('research-a', selection); let release!: () => void;
    const responder: AIResponder = async (request, options) => { if (request.purpose === 'brief') { await new Promise<void>(resolve => release = resolve); return result; } return answer(request, options); };
    const run = submitAI('research-a', a, 'A', responder);
    await vi.waitFor(() => expect(release).toBeDefined());
    const id = data().conversations[a].requestIds[0]; skipPaperBrief(id); await run;
    expect(data().requests[id].paperBrief).toBeUndefined(); expect(data().requests[id].paperBriefState).toBe('selection-only');
    release(); await vi.waitFor(() => expect(data().documents['paper-a'].paperBrief?.status).toBe('ready'));
    expect(data().requests[id].paperBrief).toBeUndefined();
    const translated = createInlineConversation('research-a', selection, { operation: 'translation' });
    vi.mocked(loadPdfDocument).mockClear(); await submitAI('research-a', translated, 'Translate', answer);
    expect(loadPdfDocument).not.toHaveBeenCalled();
    expect(data().conversations[a].requestIds).toHaveLength(1);
  });

  it.each(['load', 'page', 'text'] as const)('PDF %s 阶段挂起时停止立即返回，迟到抽取不写入简要', async stage => {
    const id = createInlineConversation('research-a', selection), pending = deferred<unknown>();
    const getTextContent = vi.fn(() => stage === 'text' ? pending.promise : Promise.resolve({ items: [{ str: 'late source' }] }));
    const page = { getTextContent }, loaded = { hash: 'a'.repeat(64), pdf: { numPages: 1,
      getPage: vi.fn(() => stage === 'page' ? pending.promise : Promise.resolve(page)) } };
    vi.mocked(loadPdfDocument).mockImplementation(() => (stage === 'load' ? pending.promise : Promise.resolve(loaded)) as ReturnType<typeof loadPdfDocument>);
    const responder = vi.fn(answer), run = preparePaperBrief(question(id), responder).then(() => undefined, problem => problem as Error);
    await vi.waitFor(() => expect(stage === 'load' ? loadPdfDocument : stage === 'page' ? loaded.pdf.getPage : getTextContent).toHaveBeenCalled());
    await stopPaperBriefs();
    expect((await run)?.name).toBe('AbortError');
    const stopped = structuredClone(data().documents['paper-a'].paperBrief);
    expect(stopped?.status).toBe('error'); expect(stopped?.body).toBe('');
    pending.resolve(stage === 'load' ? loaded : stage === 'page' ? page : { items: [{ str: 'late source' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(responder).not.toHaveBeenCalled();
    expect(data().documents['paper-a'].paperBrief).toEqual(stopped);
    validateReaderContext(data());
  });

  it('抽取等待时改研究目录，不向模型发送背景或原问题', async () => {
    workspace.updateData(next => { next.researches['research-a'].directory = { id: 'before', projectId: 'before', path: '/fixture/before' }; });
    const id = createInlineConversation('research-a', selection), loaded = deferred<ReturnType<typeof pdfFixture>>();
    vi.mocked(loadPdfDocument).mockReturnValue(loaded.promise as unknown as ReturnType<typeof loadPdfDocument>);
    const responder = vi.fn(answer), run = submitAI('research-a', id, '原目录下的问题', responder);
    await vi.waitFor(() => expect(loadPdfDocument).toHaveBeenCalled());
    workspace.updateData(next => { next.researches['research-a'].directory = { id: 'after', projectId: 'after', path: '/fixture/after' }; });
    loaded.resolve(pdfFixture());
    const requestId = await run;
    expect(responder).not.toHaveBeenCalled();
    expect(data().requests[requestId]).toMatchObject({ status: 'error', paperBriefState: 'error' });
    expect(data().requests[requestId].error).toContain('目录');
  });

  it('等待其他研究共享的简要时改自己的目录，不把问题投到新目录', async () => {
    const owner = createInlineConversation('research-a', selection), waiting = deferred<typeof result>();
    workspace.associateDocument('research-b', 'paper-a');
    workspace.updateData(next => { next.researches['research-b'].directory = { id: 'before', projectId: 'before', path: '/fixture/before' }; });
    const joiner = createInlineConversation('research-b', selection), responder = vi.fn(async (request: AIRequest) => request.purpose === 'brief' ? waiting.promise : answer(request));
    const brief = preparePaperBrief(question(owner), responder);
    await vi.waitFor(() => expect(responder).toHaveBeenCalledTimes(1));
    const run = submitAI('research-b', joiner, '等待期间仍属于原目录的问题', responder);
    await vi.waitFor(() => expect(data().conversations[joiner].requestIds).toHaveLength(1));
    workspace.updateData(next => { next.researches['research-b'].directory = { id: 'after', projectId: 'after', path: '/fixture/after' }; });
    waiting.resolve(result); await brief;
    const requestId = await run;
    expect(responder.mock.calls.map(([request]) => request.purpose)).toEqual(['brief']);
    expect(data().requests[requestId].status).toBe('error'); expect(data().requests[requestId].error).toContain('目录');
    expect(data().documents['paper-a'].paperBrief?.status).toBe('ready');
  });

  it('首次问答重新生成时，实际发送和持久记录保留同一份文章简要材料', async () => {
    const id = createInlineConversation('research-a', selection), first = await submitAI('research-a', id, '首次问题', answer);
    const frozen = structuredClone(data().requests[first].paperBrief);
    let sentSystem = '', storedAtSend: AIRequest | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/config')) return new Response(JSON.stringify({ configured: true, images: false, model: 'regenerate-fixture', provider: 'fixture', mode: 'live' }));
      if (!String(input).endsWith('/chat')) throw new Error(`Unexpected fixture URL: ${input}`);
      const payload = JSON.parse(String(init?.body));
      sentSystem = payload.messages[0].content;
      storedAtSend = structuredClone(data().requests[payload.requestId]);
      return new Response('{"type":"delta","text":"重新生成的局部回答 [1]"}\n{"type":"done","model":"regenerate-fixture"}\n');
    });
    vi.stubGlobal('fetch', fetcher);
    const regenerated = await regenerateAI(first, 'live'), request = data().requests[regenerated];
    expect(request.status).toBe('done'); expect(request.paperBrief).toEqual(frozen);
    expect(request.materials).toHaveLength(1); expect(storedAtSend?.materials).toEqual(request.materials);
    expect(sentSystem).toContain(JSON.stringify(request.materials![0]));
    expect(request.history).toEqual([]); expect(fetcher).toHaveBeenCalledTimes(2);
    const draft = createInlineCardDraft(regenerated);
    expect(data().cardDrafts[draft].source.materials).toEqual(request.materials);
    validateReaderContext(data());
  });

  it('未知总页数时准备与失败记录可保存验证，超长错误截断到4000字符', async () => {
    const id = createInlineConversation('research-a', selection), loaded = deferred<Awaited<ReturnType<typeof loadPdfDocument>>>();
    workspace.updateData(next => { delete next.documents['paper-a'].pageCount; });
    vi.mocked(loadPdfDocument).mockReturnValue(loaded.promise);
    const run = preparePaperBrief(question(id), vi.fn(answer)).then(() => undefined, problem => problem as Error);
    expect(data().documents['paper-a'].paperBrief).toMatchObject({ status: 'preparing', totalPages: 0 });
    expect(() => validateReaderContext(JSON.parse(JSON.stringify(data())))).not.toThrow();
    loaded.reject(new Error('抽取错误'.repeat(2000))); await run;
    expect(data().documents['paper-a'].paperBrief).toMatchObject({ status: 'error', totalPages: 0 });
    expect(data().documents['paper-a'].paperBrief?.error).toHaveLength(4000);
    expect(() => validateReaderContext(JSON.parse(JSON.stringify(data())))).not.toThrow();
  });

  it('演示首问不读PDF或污染文章简要，另一位置真实连接仍会首次生成', async () => {
    const demo = createInlineConversation('research-a', selection), demoRun = submitAI('research-a', demo, '演示问题', demoResponder);
    await vi.advanceTimersByTimeAsync(1000);
    const demoId = await demoRun;
    expect(data().requests[demoId]).toMatchObject({ status: 'done', mode: 'demo', paperBriefState: 'selection-only' });
    expect(loadPdfDocument).not.toHaveBeenCalled(); expect(data().documents['paper-a'].paperBrief).toBeUndefined();
    expect(data().requests[demoId].paperBrief).toBeUndefined(); expect(data().conversations[demo].paperBrief).toBeUndefined();
    const live = createInlineConversation('research-a', { ...selection, textAnchor: { start: 50, end: 59 } }), responder = vi.fn(answer);
    const realId = await submitAI('research-a', live, '真实问题', responder);
    expect(responder.mock.calls.map(([request]) => request.purpose)).toEqual(['brief', 'chat']);
    expect(loadPdfDocument).toHaveBeenCalledTimes(1);
    expect(data().requests[realId]).toMatchObject({ status: 'done', mode: 'live' });
    expect(data().documents['paper-a'].paperBrief).toMatchObject({ status: 'ready', connectionId: 'model', model: 'test-model' });
    expect(data().requests[demoId].paperBrief).toBeUndefined();
  });
});
