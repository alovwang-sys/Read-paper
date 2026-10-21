import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { contentHash, getAsset, loadWorkspace, putAsset, saveWorkspace } from '../../src/data/storage';
import { attachDrawingQuestion, loadDrawingImage, setDrawingQuestionMode } from '../../src/services/drawing-question';
import { drawingDigest, drawingPng, drawingQuestionFixture } from '../fixtures/drawing-question';
import { drawingSnapshotContent } from '../../src/domain/drawing-question';
import type { ResearchAgentArtifact, ResearchAgentEvent, ResearchAgentSource } from '../../src/domain/research-agent';
import type { AIRequest, Draft } from '../../src/domain/types';
import { loadPdfDocument } from '../../src/services/pdf';
import { applyResearchSuggestion, changeResearchAgent, createResearchConversation, openResearchConversation, clearResearchFocus, collectResearchSources, focusResearchResource, keepResearchDraft, stopResearchRun, streamResearchRun, submitResearchRun, undoResearchSuggestion, validateResearchArtifact } from '../../src/services/research-agent';
import { workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn(), putAsset: vi.fn(), contentHash: vi.fn() }));
vi.mock('../../src/services/pdf', () => ({ loadPdfDocument: vi.fn() }));
const hash = 'a'.repeat(64), researchId = 'research-a', conversationId = 'conversation-research-a';
const state = () => workspace.getState().data;
const source: ResearchAgentSource = { id: 'paper-a', title: '论文', hash, totalPages: 10, pages: [{ pageIndex: 0, text: 'A source sentence supports a limited observation.' }] };
const artifact: ResearchAgentArtifact = { title: '研究结果', body: '有限条件下的观察。 [1]', citations: [{ documentId: 'paper-a', documentHash: hash, pageIndex: 0, quote: 'source sentence supports a limited observation' }] };
const done = { type: 'done', model: 'test-codex', nativeSessionId: 'native-test', readPages: [{ documentId: 'paper-a', pageIndex: 0 }] } as const;
function ndjson(events: unknown[]) { return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }); }
function mockRun(events: unknown[]) { return vi.fn(async (url: string | URL | Request) => String(url).includes('capabilities') ? new Response(JSON.stringify({ connections: [{ id: 'codex', research: true, detail: 'test connection' }, { id: 'claude', research: false, detail: 'Claude Code 尚不支持研究工具；经典工作台仍可用。' }] })) : ndjson(events)); }
const draft: Draft = { id: 'draft-test', researchId, title: '原标题', body: '原正文。', evidenceIds: [] };
function addSuggestion() {
  const request: AIRequest = { id: 'revision', researchId, conversationId, prompt: '修改', body: '建议', context: [], createdAt: '2026-10-21', status: 'done', evidenceIds: [], researchRun: { draftId: draft.id, suggestion: { title: '新标题', body: '新正文。', evidenceIds: ['evidence-a'], baseTitle: draft.title, baseBody: draft.body, baseEvidenceIds: [] } } };
  workspace.updateData(data => { data.drafts[draft.id] = structuredClone(draft); data.requests.revision = request; });
}

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  vi.mocked(getAsset).mockReset().mockResolvedValue(new Blob(['fixture']));
  vi.mocked(contentHash).mockReset().mockResolvedValue(hash);
  vi.mocked(loadPdfDocument).mockReset().mockImplementation(async () => ({ hash, pdf: { numPages: 2, getPage: async () => ({ getTextContent: async () => ({ items: [{ str: source.pages[0].text }] }) }) } }) as never);
  const seed = createSeed();
  seed.researches[researchId].documentIds = ['paper-a'];
  seed.documents['paper-a'].hash = hash;
  seed.conversations[conversationId].connectionId = 'codex'; seed.conversations[conversationId].input = '整理研究资料';
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(seed);
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('研究资料与引用边界', () => {
  it('只抽取关联研究，明确优先追问文献并裁切页、字与文献范围', async () => {
    const data = structuredClone(state());
    data.researches[researchId].documentIds = Array.from({ length: 10 }, (_, index) => `doc-${index}`);
    for (const id of data.researches[researchId].documentIds) data.documents[id] = { ...data.documents['paper-a'], id, title: id };
    vi.mocked(loadPdfDocument).mockResolvedValue({ hash, pdf: { numPages: 40, getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'x'.repeat(14000) }] }) }) } } as never);
    const { sources, summary } = await collectResearchSources(data, researchId, new AbortController().signal, undefined, 'doc-9');
    expect(sources).toHaveLength(8); expect(sources[0].id).toBe('doc-9');
    expect(sources.flatMap(item => item.pages).reduce((sum, page) => sum + page.text.length, 0)).toBe(160000);
    expect(sources.flatMap(item => item.pages).every(page => page.pageIndex < 24 && page.text.length <= 12000)).toBe(true);
    expect(summary).toContain('另有 2 份未发送'); expect(summary).toContain('明确追问的文献优先');
  });
  it('无全文资料与不可读PDF明确报告，不假装读过', async () => {
    workspace.updateData(data => { data.researches[researchId].documentIds.push('paper-stub'); });
    vi.mocked(loadPdfDocument).mockRejectedValue(new Error('PDF 资产缺失'));
    const result = await collectResearchSources(state(), researchId, new AbortController().signal);
    expect(result.sources[0].pages).toEqual([]); expect(result.sources[0].unavailable).toBe('PDF 资产缺失');
    expect(result.sources[1].unavailable).toContain('尚无 PDF');
  });
  it('校验文献归属、hash、页码、原句与引用编号，代码和公式不误作引用', () => {
    expect(() => validateResearchArtifact(state(), researchId, [source], artifact)).not.toThrow();
    for (const citation of [{ ...artifact.citations[0], documentHash: 'wrong' }, { ...artifact.citations[0], pageIndex: 8 }, { ...artifact.citations[0], quote: 'a hallucinated quote' }, { ...artifact.citations[0], documentId: 'paper-b' }]) expect(() => validateResearchArtifact(state(), researchId, [source], { ...artifact, citations: [citation] })).toThrow('引用');
    expect(() => validateResearchArtifact(state(), researchId, [source], { ...artifact, body: '错误引用 [2]' })).toThrow('[2]');
    expect(() => validateResearchArtifact(state(), researchId, [source], { ...artifact, body: '`[99]` $x[88]$ [1]' })).not.toThrow();
  });
  it('普通浏览不会改变显式追问快照，清除独立于未发送输入', () => {
    workspace.updateData(data => { data.drafts[draft.id] = structuredClone(draft); });
    focusResearchResource(researchId, { kind: 'draft', id: draft.id });
    workspace.openResource({ kind: 'document', id: 'paper-a' }, { scope: { kind: 'research', researchId }, target: 'main' });
    expect(state().conversations[conversationId].researchFocus?.body).toBe(draft.body);
    clearResearchFocus(researchId); expect(state().conversations[conversationId].researchFocus).toBeUndefined(); expect(state().conversations[conversationId].input).toBe('整理研究资料');
    expect(() => focusResearchResource(researchId, { kind: 'research', id: 'research-b' })).toThrow('不属于');
  });
});

describe('选区绘图附送、冻结与归属', () => {
  async function prepare() {
    const question = await drawingQuestionFixture();
    vi.mocked(contentHash).mockImplementation(async bytes => drawingDigest(bytes));
    vi.mocked(getAsset).mockImplementation(async id => id === question.snapshot.image.assetId ? drawingPng : undefined);
    workspace.updateData(data => { data.conversations[conversationId].drawingQuestion = structuredClone(question); });
    return question;
  }
  function visionRun(images = true, events: unknown[] = [{ type: 'delta', text: '根据你选中的画面，这是待验证的想法。' }, { ...done, readPages: [] }]) {
    return vi.fn(async (url: string, _options?: RequestInit) => url.includes('capabilities') ? new Response(JSON.stringify({ connections: [{ id: 'codex', research: true, images, detail: 'test' }] })) : ndjson(events));
  }
  it('真实PNG和选区结构入请求；不读PDF、不继承正文修改目标、不强制建卡片', async () => {
    const question = await prepare(), fetcher = visionRun(); vi.stubGlobal('fetch', fetcher);
    workspace.updateData(data => { data.drafts[draft.id] = structuredClone(draft); data.conversations[conversationId].researchFocus = { ref: { kind: 'draft', id: draft.id }, title: draft.title, body: draft.body }; });
    const id = await submitResearchRun(researchId, '整理研究资料');
    const request = state().requests[id]; expect(request.status).toBe('done');
    expect(request.researchRun?.drawingQuestion).toEqual(question); expect(request.researchRun?.focus).toBeUndefined(); expect(request.researchRun?.suggestion).toBeUndefined();
    const payload = JSON.parse(fetcher.mock.calls.find(call => call[0].endsWith('/run'))![1]!.body as string);
    expect(payload.sources).toEqual([]); expect(payload.focus).toBeUndefined(); expect(payload.drawing.snapshot).toEqual(question.snapshot);
    expect(payload.drawing.imageDataUrl).toMatch(/^data:image\/png;base64,/); expect(loadPdfDocument).not.toHaveBeenCalled();
    expect(state().drafts[draft.id]).toEqual(draft); expect(state().conversations[conversationId].drawingQuestion).toBeUndefined();
    expect(request.researchRun?.sourceSummary).toContain('未追加论文原文');
  });
  it('未证实图片能力拒绝发送，保留输入附件；用户明确选择文字后才降级', async () => {
    const question = await prepare(), fetcher = visionRun(false); vi.stubGlobal('fetch', fetcher);
    const first = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[first].error).toContain('未确认支持图片'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state().conversations[conversationId].drawingQuestion).toEqual(question); expect(state().conversations[conversationId].input).toBe('整理研究资料');
    setDrawingQuestionMode(researchId, 'text');
    const second = await submitResearchRun(researchId, '整理研究资料'); expect(state().requests[second].status).toBe('done');
    const payload = JSON.parse(fetcher.mock.calls.find(call => call[0].endsWith('/run'))![1]!.body as string);
    expect(payload.drawing.mode).toBe('text'); expect(payload.drawing.imageDataUrl).toBeUndefined(); expect(payload.sources).toEqual([]);
  });
  it('纯笔迹不可伪装文字模式；快照或图片遭改动时拒绝', async () => {
    const question = await prepare();
    workspace.updateData(data => { data.conversations[conversationId].drawingQuestion!.snapshot.elements[0] = { ...question.snapshot.elements[0], type: 'freedraw', text: undefined }; });
    expect(() => setDrawingQuestionMode(researchId, 'text')).toThrow('快照损坏');
    const altered = structuredClone(question.snapshot); altered.elements[0].text = '篡改';
    await expect(loadDrawingImage(altered)).rejects.toThrow('校验失败');
    vi.mocked(getAsset).mockResolvedValue(new Blob(['not png']));
    await expect(loadDrawingImage(question.snapshot)).rejects.toThrow('损坏');
  });
  it('能力检测失败前就冻结历史，重试不改用后来的会话内容', async () => {
    await prepare();
    workspace.updateData(data => {
      data.requests.prior = { id: 'prior', researchId, conversationId, prompt: '先前问题', body: '提交时的历史', status: 'done', createdAt: '2026-10-21', context: [], evidenceIds: [], researchRun: {} };
      data.conversations[conversationId].requestIds.push('prior');
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('检测连接暂时失败'); }));
    const first = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[first].history?.[0].body).toBe('提交时的历史');
    workspace.updateData(data => {
      data.requests.later = { ...structuredClone(data.requests.prior), id: 'later', prompt: '后来的问题', body: '之后新增的问答' };
      data.conversations[conversationId].requestIds.push('later');
    });
    const fetcher = visionRun(); vi.stubGlobal('fetch', fetcher);
    const retry = await submitResearchRun(researchId, '整理研究资料', first);
    expect(state().requests[retry].status).toBe('done');
    const payload = JSON.parse(fetcher.mock.calls.find(call => call[0].endsWith('/run'))![1]!.body as string);
    expect(payload.history).toEqual([{ prompt: '先前问题', body: '提交时的历史' }]);
  });
  it('重试使用当轮图和历史，切会话迟到结果不污染新话题', async () => {
    const original = await prepare(); vi.stubGlobal('fetch', visionRun(true, [{ type: 'error', error: 'temporary' }]));
    const first = await submitResearchRun(researchId, '整理研究资料'); expect(state().requests[first].status).toBe('error');
    workspace.updateData(data => {
      const pending = data.conversations[conversationId].drawingQuestion!;
      pending.snapshot.elements[0].text = '新画面'; pending.snapshot.hash = drawingDigest(new TextEncoder().encode(drawingSnapshotContent(pending.snapshot)).buffer);
    });
    const fetcher = visionRun();
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/run')) createResearchConversation(researchId);
      return fetcher(url, options);
    }));
    const retried = await submitResearchRun(researchId, '整理研究资料', first);
    expect(state().requests[retried].status).toBe('done'); expect(state().requests[retried].researchRun?.drawingQuestion).toEqual(original);
    expect(state().requests[retried].conversationId).toBe(conversationId);
    const current = workspace.getActiveConversation(researchId); expect(current.id).not.toBe(conversationId); expect(current.drawingQuestion).toBeUndefined();
    expect(state().conversations[conversationId].drawingQuestion?.snapshot.elements[0].text).toBe('新画面');
    const payload = JSON.parse(fetcher.mock.calls.find(call => call[0].endsWith('/run'))![1]!.body as string);
    expect(payload.drawing.snapshot).toEqual(original.snapshot); expect(payload.history).toEqual([]);
  });
  it('附送不抹输入、取代旧目标；await期间切会话则不误附', async () => {
    const question = await prepare();
    vi.mocked(putAsset).mockResolvedValue(undefined);
    workspace.updateData(data => { data.drafts[draft.id] = draft; data.conversations[conversationId].researchFocus = { ref: { kind: 'draft', id: draft.id }, title: draft.title, body: draft.body }; });
    const capture = { image: drawingPng, width: 1, height: 1, elements: question.snapshot.elements, connections: question.snapshot.connections, conversationId, generation: workspace.getGeneration() };
    await attachDrawingQuestion(researchId, 'board-a', capture);
    expect(state().conversations[conversationId].researchFocus).toBeUndefined(); expect(state().conversations[conversationId].input).toBe('整理研究资料');
    vi.mocked(putAsset).mockImplementationOnce(async () => { createResearchConversation(researchId); });
    await expect(attachDrawingQuestion(researchId, 'board-a', capture)).rejects.toThrow('会话已切换');
    expect(workspace.getActiveConversation(researchId).drawingQuestion).toBeUndefined();
  });
  it('停止保留图和输入，刷新从原会话恢复', async () => {
    const question = await prepare();
    let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => url.includes('capabilities') ? Promise.resolve(new Response(JSON.stringify({ connections: [{ id: 'codex', research: true, images: true }] }))) : new Promise<Response>((_resolve, reject) => { started(); options?.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError'))); })));
    const run = submitResearchRun(researchId, '整理研究资料'); await began;
    const running = Object.values(state().requests).find(request => request.status === 'generating')!; stopResearchRun(running.id); await run;
    expect(state().requests[running.id].status).toBe('stopped'); expect(state().conversations[conversationId].drawingQuestion).toEqual(question);
    const saved = structuredClone(state()); vi.mocked(loadWorkspace).mockResolvedValue(saved); await workspace.load();
    expect(state().conversations[conversationId].drawingQuestion).toEqual(question); expect(state().conversations[conversationId].input).toBe('整理研究资料');
  });
});

describe('真实事件流与成果写入', () => {
  it('跨块NDJSON解码，末行无换行也只处理一次', async () => {
    const encoder = new TextEncoder(), text = JSON.stringify({ type: 'delta', text: '你好' }) + '\n' + JSON.stringify(done), bytes = encoder.encode(text);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 28)); controller.enqueue(bytes.slice(28)); controller.close(); } }))));
    const events: ResearchAgentEvent[] = [];
    await streamResearchRun({ requestId: 'test', researchId, connectionId: 'codex', prompt: 'test', sources: [], history: [] }, new AbortController().signal, event => events.push(event));
    expect(events).toHaveLength(2); expect(events[0]).toEqual({ type: 'delta', text: '你好' });
  });
  it('创建真实证据及独立文稿，长结果不重复聊天正文，清除仅同一份输入', async () => {
    const fetcher = mockRun([{ type: 'artifact', artifact }, done]); vi.stubGlobal('fetch', fetcher);
    const id = await submitResearchRun(researchId, '整理研究资料');
    const request = state().requests[id]; expect(request.status).toBe('done');
    const result = state().drafts[request.researchRun!.draftId!]; expect(result.body).toBe(artifact.body); expect(request.body).not.toBe(artifact.body);
    expect(state().evidence[result.evidenceIds[0]].quote).toBe(artifact.citations[0].quote); expect(request.context[0].documentHash).toBe(hash);
    expect(state().sessions[researchId].active).toEqual({ kind: 'researchView', id: 'home' }); expect(state().conversations[conversationId].input).toBe('');
    const sent = JSON.parse((fetcher.mock.calls.find(call => String(call[0]).endsWith('/run')) as unknown as [string, RequestInit])[1].body as string);
    expect(sent.sources).toHaveLength(1); expect(sent.connectionId).toBe('codex');
  });
  it('示例PDF首次准备可建立真实hash，绝不忽略已有hash冲突', async () => {
    workspace.updateData(data => { data.documents['paper-a'].hash = ''; });
    vi.stubGlobal('fetch', mockRun([{ type: 'artifact', artifact }, done]));
    const id = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[id].status).toBe('done'); expect(state().documents['paper-a'].hash).toBe(hash); expect(state().documents['paper-a'].pageCount).toBe(2);
  });
  it('不支持的连接准确失败，保留输入且不偷偷转Codex或演示', async () => {
    workspace.updateData(data => { data.conversations[conversationId].connectionId = 'claude'; });
    const fetcher = mockRun([]); vi.stubGlobal('fetch', fetcher);
    const id = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[id].status).toBe('error'); expect(state().requests[id].error).toContain('经典工作台'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state().conversations[conversationId].input).toBe('整理研究资料'); expect(loadPdfDocument).not.toHaveBeenCalled();
  });
  it('短答不强制建稿；引用未实际读页时拒绝写入', async () => {
    vi.stubGlobal('fetch', mockRun([{ type: 'delta', text: '这是解释，不需要建立成果。' }, done]));
    let id = await submitResearchRun(researchId, '解释一下'); expect(state().requests[id].status).toBe('done'); expect(state().requests[id].researchRun?.draftId).toBeUndefined();
    const before = Object.keys(state().drafts).length;
    vi.stubGlobal('fetch', mockRun([{ type: 'artifact', artifact }, { ...done, readPages: [] }]));
    id = await submitResearchRun(researchId, '整理研究资料'); expect(state().requests[id].error).toContain('未实际读取'); expect(Object.keys(state().drafts)).toHaveLength(before);
  });
  it('资产改变或缺失时不写结果，保留用户目标', async () => {
    vi.stubGlobal('fetch', mockRun([{ type: 'artifact', artifact }, done])); vi.mocked(getAsset).mockResolvedValue(undefined);
    const before = Object.keys(state().drafts).length, id = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[id].status).toBe('error'); expect(state().requests[id].error).toContain('原文件'); expect(Object.keys(state().drafts)).toHaveLength(before);
  });
  it('运行中切研究或换视图，迟到结果归原研究且不抢画面与新输入', async () => {
    const fetcher = mockRun([{ type: 'artifact', artifact }, done]);
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => { if (url.endsWith('/run')) { workspace.switchResearch('research-b'); workspace.updateData(data => { data.conversations[conversationId].input = '另一份未发送问题'; }); } return fetcher(url); }));
    const id = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[id].status).toBe('done'); expect(state().drafts[state().requests[id].researchRun!.draftId!].researchId).toBe(researchId);
    expect(state().scope).toEqual({ kind: 'research', researchId: 'research-b' }); expect(state().conversations[conversationId].input).toBe('另一份未发送问题');
  });
  it('停止中止fetch，留下输入和已有成果', async () => {
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => { if (url.includes('capabilities')) return Promise.resolve(new Response(JSON.stringify({ connections: [{ id: 'codex', research: true, detail: 'ok' }] }))); began(); return new Promise<Response>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')))); }));
    const promise = submitResearchRun(researchId, '整理研究资料'); await started;
    const request = Object.values(state().requests).find(item => item.researchRun && item.status === 'generating')!; stopResearchRun(request.id); await promise;
    expect(state().requests[request.id].status).toBe('stopped'); expect(state().conversations[conversationId].input).toBe('整理研究资料');
  });
});

describe('人工正文保护与独立撤销', () => {
  it('修改当前稿始终提出建议，人工编辑保留，采用旧建议时拒绝', async () => {
    workspace.updateData(data => { data.drafts[draft.id] = structuredClone(draft); }); focusResearchResource(researchId, { kind: 'draft', id: draft.id });
    vi.stubGlobal('fetch', mockRun([{ type: 'artifact', artifact }, done]));
    const id = await submitResearchRun(researchId, '根据原文修改这份结果'); expect(state().drafts[draft.id].body).toBe(draft.body); expect(state().requests[id].researchRun?.suggestion?.body).toBe(artifact.body);
    workspace.updateData(data => { data.drafts[draft.id].title = '我已改标题'; });
    expect(() => applyResearchSuggestion(id)).toThrow('旧版本'); expect(state().drafts[draft.id].title).toBe('我已改标题');
  });
  it('提交时刷新同一显式对象正文，使模型上下文与修订基线一致', async () => {
    workspace.updateData(data => { data.drafts[draft.id] = structuredClone(draft); }); focusResearchResource(researchId, { kind: 'draft', id: draft.id });
    workspace.updateData(data => { data.drafts[draft.id].body = '点击追问后，我先补充了判断。'; });
    const fetcher = mockRun([{ type: 'artifact', artifact }, done]); vi.stubGlobal('fetch', fetcher);
    const id = await submitResearchRun(researchId, '继续修改');
    expect(state().requests[id].researchRun?.focus?.body).toBe('点击追问后，我先补充了判断。');
    expect(state().requests[id].researchRun?.suggestion?.baseBody).toBe(state().requests[id].researchRun?.focus?.body);
  });
  it('采用与撤销同时保护标题、正文及引用，保留我的不会改稿', () => {
    addSuggestion(); applyResearchSuggestion('revision'); expect(state().drafts[draft.id].body).toBe('新正文。'); undoResearchSuggestion('revision'); expect(state().drafts[draft.id]).toMatchObject(draft);
    addSuggestion(); applyResearchSuggestion('revision'); workspace.updateData(data => { data.drafts[draft.id].evidenceIds.push('evidence-b'); }); expect(() => undoResearchSuggestion('revision')).toThrow('继续编辑');
    addSuggestion(); keepResearchDraft('revision'); expect(state().drafts[draft.id].body).toBe(draft.body); expect(state().requests.revision.researchRun?.suggestion).toBeUndefined();
  });
});

describe('多会话导航与上下文隔离', () => {
  it('新建和切回保留各自输入与目标，不继承前话题或进入经典面板', () => {
    workspace.updateData(data => { data.drafts[draft.id] = structuredClone(draft); data.agentWorkbench = true; data.sessions[researchId].panel = { open: true, mode: 'ai', pinned: false, history: [], aiView: 'history' }; });
    focusResearchResource(researchId, { kind: 'draft', id: draft.id });
    const fresh = createResearchConversation(researchId);
    expect(state().conversations[fresh].input).toBe('');
    expect(state().conversations[fresh].requestIds).toEqual([]);
    expect(state().conversations[fresh].contextIds).toEqual([]);
    expect(state().conversations[fresh].researchFocus).toBeUndefined();
    workspace.updateData(data => { data.conversations[fresh].input = 'B的未发送文字'; });
    openResearchConversation(researchId, conversationId);
    expect(state().conversations[conversationId].input).toBe('整理研究资料');
    expect(state().conversations[conversationId].researchFocus?.ref.id).toBe(draft.id);
    expect(state().sessions[researchId].panel.aiView).toBe('history');
    expect(state().agentWorkbench).toBe(true);
    openResearchConversation(researchId, fresh);
    expect(state().conversations[fresh].input).toBe('B的未发送文字');
    expect(state().conversations[fresh].researchFocus).toBeUndefined();
  });
  it('换助手对已有话题新开会话，不跳入同供应商的旧话题或复制输入和目标', () => {
    const old = createResearchConversation(researchId, 'claude');
    workspace.updateData(data => { data.conversations[old].input = '旧Claude话题'; });
    openResearchConversation(researchId, conversationId);
    const next = changeResearchAgent(researchId, 'claude');
    expect(next).not.toBe(old); expect(next).not.toBe(conversationId);
    expect(state().conversations[next].connectionId).toBe('claude');
    expect(state().conversations[next].input).toBe('');
    expect(state().conversations[old].input).toBe('旧Claude话题');
    expect(state().conversations[conversationId].input).toBe('整理研究资料');
  });
  it('普通会话选择仍保留经典路径，新工作台显式选择不改旧契约', () => {
    workspace.selectConversation(researchId, conversationId);
    expect(state().sessions[researchId].panel.aiView).toBe('chat');
    openResearchConversation(researchId, conversationId);
    expect(state().sessions[researchId].panel.aiView).toBe('history');
    const id = workspace.createConversation(researchId);
    expect(state().sessions[researchId].panel.aiView).toBe('chat');
    expect(state().conversations[id].contextIds).toEqual([]);
  });
  it('旧空会话在研究工作台选择时默认Codex，经典选择仍使用原默认', () => {
    workspace.updateData(data => { delete data.conversations[conversationId].connectionId; });
    openResearchConversation(researchId, conversationId);
    expect(state().conversations[conversationId].connectionId).toBe('codex');
    workspace.updateData(data => { delete data.conversations[conversationId].connectionId; });
    workspace.selectConversation(researchId, conversationId);
    expect(state().conversations[conversationId].connectionId).toBe('model');
  });
  it('原生/混合历史不静默丢上下文，跨会话重试与跨研究目标在发请求前拒绝', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    workspace.updateData(data => { data.conversations[conversationId].nativeSessionId = 'native-original'; });
    await expect(submitResearchRun(researchId, '继续')).rejects.toThrow('经典上下文');
    workspace.updateData(data => { delete data.conversations[conversationId].nativeSessionId; data.conversations[conversationId].researchFocus = { ref: { kind: 'research', id: 'research-b' }, title: '其他研究', body: '不能发送' }; });
    await expect(submitResearchRun(researchId, '继续')).rejects.toThrow('不属于');
    clearResearchFocus(researchId);
    addSuggestion();
    createResearchConversation(researchId);
    await expect(submitResearchRun(researchId, '继续', 'revision')).rejects.toThrow('原会话');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('按当前会话维护标题活动时间，并且发送历史不跨话题', async () => {
    vi.stubGlobal('fetch', mockRun([{ type: 'delta', text: 'A的回答' }, done]));
    await submitResearchRun(researchId, 'A比较方法');
    expect(state().conversations[conversationId].title).toBe('A比较方法');
    expect(state().conversations[conversationId].updatedAt).toBeTruthy();
    const b = createResearchConversation(researchId);
    const fetcher = mockRun([{ type: 'delta', text: 'B的回答' }, done]); vi.stubGlobal('fetch', fetcher);
    await submitResearchRun(researchId, 'B补查限制');
    const payload = JSON.parse((fetcher.mock.calls.find(call => String(call[0]).endsWith('/run')) as unknown as [string, RequestInit])[1].body as string);
    expect(payload.history).toEqual([]); expect(payload.focus).toBeUndefined();
    expect(state().conversations[b].title).toBe('B补查限制');
    expect(state().conversations[conversationId].requestIds).toHaveLength(1);
  });
});

describe('会话字段持久恢复', () => {
  it('schema3旧焦点迁移后立即落盘，不依赖后续编辑触发保存', async () => {
    const saved = structuredClone(state());
    saved.sessions[researchId].activeConversationId = conversationId;
    saved.sessions[researchId].agentFocus = { ref: { kind: 'card', id: 'card-a' }, title: '旧会话目标', body: '保留' };
    await workspace.flushSave();
    localStorage.removeItem('papertrail-recovery-v3');
    vi.mocked(loadWorkspace).mockResolvedValue(saved);
    vi.mocked(saveWorkspace).mockClear();
    await workspace.load(); await workspace.flushSave();
    expect(state().sessions[researchId].agentFocus).toBeUndefined();
    expect(state().conversations[conversationId].researchFocus?.title).toBe('旧会话目标');
    expect(vi.mocked(saveWorkspace).mock.calls.at(-1)?.[0].conversations[conversationId].researchFocus?.title).toBe('旧会话目标');
  });
});
