import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { contentHash, getAsset, loadWorkspace, putAsset, saveWorkspace } from '../../src/data/storage';
import { attachDrawingQuestion, loadDrawingImage, setDrawingQuestionMode } from '../../src/services/drawing-question';
import { drawingDigest, drawingPng, drawingQuestionFixture } from '../fixtures/drawing-question';
import { drawingSnapshotContent } from '../../src/domain/drawing-question';
import type { ResearchAgentArtifact, ResearchAgentEvent, ResearchAgentSource, ResearchLiteratureSearch } from '../../src/domain/research-agent';
import type { AIRequest, ChatImageAttachment, Draft } from '../../src/domain/types';
import { loadPdfDocument } from '../../src/services/pdf';
import { applyResearchSuggestion, changeResearchAgent, createResearchConversation, DEFAULT_IMAGE_PROMPT, openResearchConversation, clearResearchFocus, collectResearchSources, focusResearchResource, keepResearchDraft, stopResearchRun, streamResearchRun, submitResearchRun, undoResearchSuggestion, validateResearchArtifact } from '../../src/services/research-agent';
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

describe('通用图片聊天请求与草稿隔离', () => {
  async function prepareImage() {
    const bytes = await drawingPng.arrayBuffer(), imageHash = drawingDigest(bytes);
    const image: ChatImageAttachment = { assetId: `chat-image-${imageHash}`, hash: imageHash, name: 'original.png', mimeType: 'image/png', size: bytes.byteLength };
    vi.mocked(contentHash).mockImplementation(async content => drawingDigest(content));
    vi.mocked(getAsset).mockResolvedValue(drawingPng);
    workspace.updateData(data => { data.researches[researchId].documentIds = []; data.conversations[conversationId].chatImages = [image]; data.conversations[conversationId].input = ''; });
    return image;
  }
  function imageRun(events: unknown[] = [{ type: 'delta', text: '画面中有一个待验证的想法。' }, { ...done, readPages: [] }], images = true) {
    return vi.fn(async (url: string, _options?: RequestInit) => url.includes('capabilities') ? new Response(JSON.stringify({ connections: [{ id: 'codex', research: true, images }] })) : ndjson(events));
  }
  it('纯图使用默认问题、发送原图真实字节，只在本轮快照保留图片', async () => {
    const image = await prepareImage(), fetcher = imageRun(); vi.stubGlobal('fetch', fetcher);
    const id = await submitResearchRun(researchId, '');
    expect(state().requests[id].status).toBe('done'); expect(state().requests[id].prompt).toBe(DEFAULT_IMAGE_PROMPT);
    expect(state().requests[id].researchRun?.chatImages).toEqual([image]); expect(state().conversations[conversationId].chatImages).toBeUndefined(); expect(state().conversations[conversationId].input).toBe('');
    const payload = JSON.parse(fetcher.mock.calls.find(call => call[0].endsWith('/run'))![1]!.body as string);
    expect(payload.images[0]).toMatchObject(image);
    const original = Buffer.from(await drawingPng.arrayBuffer());
    expect(Buffer.from(payload.images[0].dataUrl.split(',')[1], 'base64')).toEqual(original);
    expect(state().requests[id].researchRun?.sourceSummary).toContain('不作为论文原文证据');
    workspace.updateData(data => { data.conversations[conversationId].input = '继续讨论'; });
    const next = await submitResearchRun(researchId, '继续讨论'); expect(state().requests[next].status).toBe('done');
    const following = JSON.parse(fetcher.mock.calls.filter(call => call[0].endsWith('/run'))[1][1]!.body as string);
    expect(following.images).toBeUndefined(); expect(following.history[0].body).toContain('本轮未重新附送');
  });
  it('未确认图片能力不发原图，恢复图片而不把默认问题塞入空草稿，刷新仍保留', async () => {
    const image = await prepareImage(), fetcher = imageRun(undefined, false); vi.stubGlobal('fetch', fetcher);
    const id = await submitResearchRun(researchId, '');
    expect(state().requests[id].error).toContain('未确认支持图片'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state().conversations[conversationId].chatImages).toEqual([image]); expect(state().conversations[conversationId].input).toBe('');
    vi.mocked(loadWorkspace).mockResolvedValue(structuredClone(state())); await workspace.load();
    expect(state().conversations[conversationId].chatImages).toEqual([image]);
  });
  it('新会话尚无input字段时，纯图发送失败仍恢复原图并保持空输入', async () => {
    const image = await prepareImage();
    workspace.updateData(data => { delete data.conversations[conversationId].input; });
    const fetcher = imageRun([{ type: 'error', error: '图片发送失败' }]); vi.stubGlobal('fetch', fetcher);
    const id = await submitResearchRun(researchId, '');
    expect(state().requests[id].status).toBe('error'); expect(state().requests[id].prompt).toBe(DEFAULT_IMAGE_PROMPT);
    expect(state().conversations[conversationId].chatImages).toEqual([image]);
    expect(state().conversations[conversationId].input ?? '').toBe('');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('失败重试只用当轮冻结图片，之后新附图片和输入完整保留', async () => {
    const image = await prepareImage(); vi.stubGlobal('fetch', imageRun([{ type: 'error', error: 'temporary' }]));
    const first = await submitResearchRun(researchId, ''); expect(state().requests[first].status).toBe('error');
    const newImage = { ...image, assetId: 'later-image', name: 'later.png', hash: 'c'.repeat(64) };
    workspace.updateData(data => { data.conversations[conversationId].chatImages = [newImage]; data.conversations[conversationId].input = '下一轮的问题'; });
    const fetcher = imageRun(); vi.stubGlobal('fetch', fetcher);
    const retry = await submitResearchRun(researchId, DEFAULT_IMAGE_PROMPT, first);
    expect(state().requests[retry].status).toBe('done');
    const payload = JSON.parse(fetcher.mock.calls.find(call => call[0].endsWith('/run'))![1]!.body as string);
    expect(payload.images.map((item: ChatImageAttachment) => item.assetId)).toEqual([image.assetId]);
    expect(state().conversations[conversationId].chatImages).toEqual([newImage]); expect(state().conversations[conversationId].input).toBe('下一轮的问题');
  });
  it('停止运行恢复图片与原输入，已有下一轮输入或附件时不回填旧内容', async () => {
    const image = await prepareImage();
    const waitRun = () => {
      let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
      vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => url.includes('capabilities') ? Promise.resolve(new Response(JSON.stringify({ connections: [{ id: 'codex', research: true, images: true }] }))) : new Promise<Response>((_resolve, reject) => { started(); options?.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError'))); })));
      return began;
    };
    let began = waitRun(), run = submitResearchRun(researchId, ''); await began;
    let request = Object.values(state().requests).find(item => item.status === 'generating')!;
    stopResearchRun(request.id); await run; expect(state().conversations[conversationId].chatImages).toEqual([image]); expect(state().conversations[conversationId].input).toBe('');
    began = waitRun(); run = submitResearchRun(researchId, ''); await began;
    request = Object.values(state().requests).find(item => item.status === 'generating')!;
    const later = { ...image, assetId: 'later-image', hash: 'b'.repeat(64) };
    workspace.updateData(data => { data.conversations[conversationId].chatImages = [later]; data.conversations[conversationId].input = '新输入'; });
    stopResearchRun(request.id); await run;
    expect(state().conversations[conversationId].chatImages).toEqual([later]); expect(state().conversations[conversationId].input).toBe('新输入');
  });
  it('执行中切会话不污染新会话，完成前复查原图资产', async () => {
    const image = await prepareImage(), fetcher = imageRun();
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => { if (url.endsWith('/run')) createResearchConversation(researchId); return fetcher(url, options); }));
    const id = await submitResearchRun(researchId, '');
    expect(state().requests[id].conversationId).toBe(conversationId); expect(state().requests[id].status).toBe('done'); expect(workspace.getActiveConversation(researchId).chatImages).toBeUndefined();
    workspace.selectConversation(researchId, conversationId, { surface: 'workbench' });
    workspace.updateData(data => { data.conversations[conversationId].chatImages = [image]; });
    vi.mocked(getAsset).mockResolvedValueOnce(drawingPng).mockResolvedValueOnce(new Blob(['changed']));
    vi.stubGlobal('fetch', imageRun());
    const altered = await submitResearchRun(researchId, ''); expect(state().requests[altered].status).toBe('error'); expect(state().requests[altered].error).toContain('数据');
  });
  it('原图缺失在发送前失败，空会话换助手不能丢附件，追问目标保留普通图片', async () => {
    const image = await prepareImage();
    focusResearchResource(researchId, { kind: 'card', id: 'card-a' }); expect(state().conversations[conversationId].chatImages).toEqual([image]);
    clearResearchFocus(researchId);
    const newId = changeResearchAgent(researchId, 'claude'); expect(newId).not.toBe(conversationId); expect(state().conversations[conversationId].chatImages).toEqual([image]);
    workspace.selectConversation(researchId, conversationId, { surface: 'workbench' });
    vi.mocked(getAsset).mockResolvedValue(undefined); const fetcher = imageRun(); vi.stubGlobal('fetch', fetcher);
    const id = await submitResearchRun(researchId, ''); expect(state().requests[id].error).toContain('已缺失'); expect(fetcher).toHaveBeenCalledTimes(1); expect(state().conversations[conversationId].chatImages).toEqual([image]);
  });
  it('图片元数据计入文本预算，超限不创建请求也不消费草稿', async () => {
    await prepareImage();
    const text = 'x'.repeat(117900);
    workspace.updateData(data => { data.conversations[conversationId].input = text; });
    const before = state().conversations[conversationId].requestIds.length;
    await expect(submitResearchRun(researchId, text)).rejects.toThrow('120,000');
    expect(state().conversations[conversationId].requestIds).toHaveLength(before); expect(state().conversations[conversationId].input).toBe(text); expect(state().conversations[conversationId].chatImages).toHaveLength(1);
  });
  it('同时附送绘图与普通图片，纯图批次总数仍最多4', async () => {
    const image = await prepareImage(), question = await drawingQuestionFixture();
    vi.mocked(getAsset).mockResolvedValue(drawingPng);
    workspace.updateData(data => { data.conversations[conversationId].drawingQuestion = question; });
    const fetcher = imageRun(); vi.stubGlobal('fetch', fetcher);
    const id = await submitResearchRun(researchId, ''); expect(state().requests[id].status).toBe('done');
    const payload = JSON.parse(fetcher.mock.calls.find(call => call[0].endsWith('/run'))![1]!.body as string);
    expect(payload.drawing.imageDataUrl).toMatch(/^data:image\/png/); expect(payload.images[0].assetId).toBe(image.assetId);
    workspace.updateData(data => { data.conversations[conversationId].drawingQuestion = question; data.conversations[conversationId].chatImages = ['a', 'b', 'c', 'd'].map(letter => ({ ...image, assetId: letter, hash: letter.repeat(64) })); });
    await expect(submitResearchRun(researchId, '')).rejects.toThrow('包含所选绘图');
  });
});

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
  it('无 PDF 的题录摘要可查阅，优先来源摘要并限制为题录信息，不伪造成原文页', async () => {
    workspace.updateData(data => {
      data.researches[researchId].documentIds = ['paper-stub'];
      data.documents['paper-stub'].abstract = { text: '题录摘要'.repeat(4000), url: 'https://example.org/paper', retrievedAt: '2026-10-21' };
      data.documents['paper-stub'].discovery = { id: 'candidate', provider: 'openalex', providerId: 'W1', title: '论文', authors: [], url: 'https://openalex.org/W1', abstract: '发现的摘要', retrievedAt: '2026-10-21' };
    });
    let result = await collectResearchSources(state(), researchId, new AbortController().signal);
    expect(result.sources[0].abstract).toBe('题录摘要'.repeat(4000).slice(0, 12000));
    expect(result.sources[0].pages).toEqual([]); expect(result.sources[0].unavailable).toContain('尚无 PDF');
    expect(loadPdfDocument).not.toHaveBeenCalled();
    workspace.updateData(data => { delete data.documents['paper-stub'].abstract; });
    result = await collectResearchSources(state(), researchId, new AbortController().signal);
    expect(result.sources[0].abstract).toBe('发现的摘要'); expect(result.sources[0].pages).toEqual([]);
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

describe('研究消息提交回归', () => {
  it('超过 8,000 字的问题完整进入请求及会话，不额外按输入框字数截断', async () => {
    const prompt = '研'.repeat(9001), fetcher = mockRun([{ type: 'delta', text: '已完整收到研究条件。' }, done]);
    workspace.updateData(data => { data.conversations[conversationId].input = prompt; });
    vi.stubGlobal('fetch', fetcher);
    const id = await submitResearchRun(researchId, prompt);
    const payload = JSON.parse((fetcher.mock.calls.find(call => String(call[0]).endsWith('/run')) as unknown as [string, RequestInit])[1].body as string);
    expect(payload.prompt).toBe(prompt); expect(state().requests[id].prompt).toBe(prompt);
    expect(state().requests[id].status).toBe('done'); expect(state().conversations[conversationId].input).toBe('');
  });
  it('超过六轮和 12,000 字的完整历史继续附送，不静默丢弃长回答', async () => {
    const turns = Array.from({ length: 8 }, (_, index) => ({ id: `old-${index}`, prompt: `问题${index}`, body: '答'.repeat(index === 7 ? 12001 : 1000) }));
    workspace.updateData(data => { for (const turn of turns) { data.requests[turn.id] = { ...turn, researchId, conversationId, context: [], evidenceIds: [], createdAt: '2026-10-21', status: 'done', researchRun: {} }; data.conversations[conversationId].requestIds.push(turn.id); } });
    const fetcher = mockRun([{ type: 'delta', text: '继续回答' }, done]); vi.stubGlobal('fetch', fetcher);
    const id = await submitResearchRun(researchId, '继续比较');
    const payload = JSON.parse((fetcher.mock.calls.find(call => String(call[0]).endsWith('/run')) as unknown as [string, RequestInit])[1].body as string);
    expect(payload.history).toEqual(turns.map(({ prompt, body }) => ({ prompt, body })));
    expect(state().requests[id].history?.map(turn => turn.requestId)).toEqual(turns.map(turn => turn.id));
    expect(state().requests[id].researchRun?.sourceSummary).toContain('全部 8 轮');
  });
  it('历史或单次输入超既有传输预算时明确拒绝，输入附件保留且不创建请求', async () => {
    const question = await drawingQuestionFixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    workspace.updateData(data => {
      data.conversations[conversationId].drawingQuestion = question;
      data.requests.previous = { id: 'previous', researchId, conversationId, prompt: '前一轮', body: '答'.repeat(80000), context: [], evidenceIds: [], createdAt: '2026-10-21', status: 'done', researchRun: {} };
      data.conversations[conversationId].requestIds.push('previous');
    });
    await expect(submitResearchRun(researchId, '整理研究资料')).rejects.toThrow('80,000');
    expect(state().conversations[conversationId].input).toBe('整理研究资料'); expect(state().conversations[conversationId].drawingQuestion).toEqual(question);
    const longPrompt = '问'.repeat(119000);
    workspace.updateData(data => { data.conversations[conversationId].requestIds = []; data.conversations[conversationId].input = longPrompt; });
    await expect(submitResearchRun(researchId, longPrompt)).rejects.toThrow('120,000');
    expect(state().conversations[conversationId].input).toBe(longPrompt); expect(state().conversations[conversationId].drawingQuestion).toEqual(question);
    expect(Object.keys(state().requests)).toEqual(['previous']); expect(fetcher).not.toHaveBeenCalled();
  });
  it('4,097 个短轮次在发送前明确拒绝，不裁剪成服务端允许的历史', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    workspace.updateData(data => {
      for (let index = 0; index < 4097; index++) {
        const id = `turn-${index}`;
        data.requests[id] = { id, researchId, conversationId, prompt: 'q', body: 'a', context: [], evidenceIds: [], createdAt: '2026-10-21', status: 'done', researchRun: {} };
        data.conversations[conversationId].requestIds.push(id);
      }
    });
    await expect(submitResearchRun(researchId, '整理研究资料')).rejects.toThrow('4,096');
    expect(state().conversations[conversationId].requestIds).toHaveLength(4097);
    expect(state().conversations[conversationId].input).toBe('整理研究资料'); expect(fetcher).not.toHaveBeenCalled();
  });
  for (const outcome of ['done', 'error', 'stopped'] as const) {
    for (const nextDraft of [false, true]) {
      it(`请求入会话立即消费输入和图；${outcome} 后${nextDraft ? '保留下一条输入和新图' : '仅无回答失败时恢复原草稿'}`, async () => {
        const question = await drawingQuestionFixture();
        vi.mocked(contentHash).mockImplementation(async bytes => drawingDigest(bytes));
        vi.mocked(getAsset).mockImplementation(async id => id === question.snapshot.image.assetId ? drawingPng : undefined);
        workspace.updateData(data => { data.conversations[conversationId].drawingQuestion = structuredClone(question); });
        let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => url.includes('capabilities')
          ? new Response(JSON.stringify({ connections: [{ id: 'codex', research: true, images: true }] }))
          : new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; options?.signal?.addEventListener('abort', () => controller.error(new DOMException('已停止', 'AbortError')), { once: true }); began(); } }))));
        const promise = submitResearchRun(researchId, '整理研究资料'); await started;
        const request = Object.values(state().requests).find(item => item.status === 'generating')!;
        expect(state().conversations[conversationId].input).toBe(''); expect(state().conversations[conversationId].drawingQuestion).toBeUndefined();
        expect(request.researchRun?.drawingQuestion).toEqual(question);
        const nextQuestion = structuredClone(question); nextQuestion.snapshot.id = 'next-question';
        nextQuestion.snapshot.hash = drawingDigest(new TextEncoder().encode(drawingSnapshotContent(nextQuestion.snapshot)).buffer);
        if (nextDraft) workspace.updateData(data => { data.conversations[conversationId].input = '下一条尚未发送的问题'; data.conversations[conversationId].drawingQuestion = nextQuestion; });
        if (outcome === 'stopped') stopResearchRun(request.id);
        else { stream.enqueue(new TextEncoder().encode((outcome === 'done' ? [{ type: 'delta', text: '已经回答' }, { ...done, readPages: [] }] : [{ type: 'error', error: '模拟执行失败' }]).map(event => JSON.stringify(event)).join('\n') + '\n')); stream.close(); }
        await promise;
        expect(state().requests[request.id].status).toBe(outcome);
        expect(state().conversations[conversationId].input).toBe(nextDraft ? '下一条尚未发送的问题' : outcome === 'done' ? '' : '整理研究资料');
        expect(state().conversations[conversationId].drawingQuestion).toEqual(nextDraft ? nextQuestion : outcome === 'done' ? undefined : question);
      });
    }
  }
  it('部分回答后失败不会回填已发送问题和图片，原请求仍可按冻结范围重试', async () => {
    const question = await drawingQuestionFixture();
    vi.mocked(contentHash).mockImplementation(async bytes => drawingDigest(bytes));
    vi.mocked(getAsset).mockResolvedValue(drawingPng);
    workspace.updateData(data => { data.conversations[conversationId].drawingQuestion = question; });
    const fetcher = vi.fn(async (url: string) => url.includes('capabilities')
      ? new Response(JSON.stringify({ connections: [{ id: 'codex', research: true, images: true }] }))
      : ndjson([{ type: 'delta', text: '已经输出部分内容' }, { type: 'error', error: '连接中断' }]));
    vi.stubGlobal('fetch', fetcher);
    const id = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[id]).toMatchObject({ status: 'error', body: '已经输出部分内容' });
    expect(state().conversations[conversationId].input).toBe(''); expect(state().conversations[conversationId].drawingQuestion).toBeUndefined();
    expect(state().requests[id].researchRun?.drawingQuestion).toEqual(question);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('capabilities')
      ? new Response(JSON.stringify({ connections: [{ id: 'codex', research: true, images: true }] }))
      : ndjson([{ type: 'delta', text: '重试成功' }, { ...done, readPages: [] }])));
    const retry = await submitResearchRun(researchId, '整理研究资料', id);
    expect(state().requests[retry].status).toBe('done'); expect(state().requests[retry].researchRun?.drawingQuestion).toEqual(question);
    expect(state().conversations[conversationId].input).toBe(''); expect(state().conversations[conversationId].drawingQuestion).toBeUndefined();
  });
  it('停止后立即发送下一轮，旧回合恢复不能把原问题写入新回合的空输入区', async () => {
    let starts = 0, firstStart!: () => void, secondStart!: () => void;
    const firstStarted = new Promise<void>(resolve => { firstStart = resolve; });
    const secondStarted = new Promise<void>(resolve => { secondStart = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => url.includes('capabilities')
      ? new Response(JSON.stringify({ connections: [{ id: 'codex', research: true }] }))
      : new Response(new ReadableStream<Uint8Array>({ start(controller) { options?.signal?.addEventListener('abort', () => controller.error(new DOMException('已停止', 'AbortError')), { once: true }); if (++starts === 1) firstStart(); else secondStart(); } }))));
    const first = submitResearchRun(researchId, '整理研究资料'); await firstStarted;
    const oldRequest = Object.values(state().requests).find(item => item.status === 'generating')!;
    stopResearchRun(oldRequest.id);
    workspace.updateData(data => { data.conversations[conversationId].input = '第二轮问题'; });
    const second = submitResearchRun(researchId, '第二轮问题'); await secondStarted;
    try { await first; expect(state().conversations[conversationId].input).toBe(''); }
    finally { const current = Object.values(state().requests).find(item => item.status === 'generating')!; stopResearchRun(current.id); await second; }
  });
  it('用户只更换图片时失败不把旧问题恢复到新图上', async () => {
    const question = await drawingQuestionFixture(), nextQuestion = structuredClone(question); nextQuestion.snapshot.id = 'new-drawing';
    nextQuestion.snapshot.hash = drawingDigest(new TextEncoder().encode(drawingSnapshotContent(nextQuestion.snapshot)).buffer);
    vi.mocked(contentHash).mockImplementation(async bytes => drawingDigest(bytes)); vi.mocked(getAsset).mockResolvedValue(drawingPng);
    workspace.updateData(data => { data.conversations[conversationId].drawingQuestion = question; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('capabilities')) return new Response(JSON.stringify({ connections: [{ id: 'codex', research: true, images: true }] }));
      workspace.updateData(data => { data.conversations[conversationId].drawingQuestion = nextQuestion; });
      return ndjson([{ type: 'error', error: '执行失败' }]);
    }));
    const id = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[id].status).toBe('error'); expect(state().conversations[conversationId].input).toBe('');
    expect(state().conversations[conversationId].drawingQuestion).toEqual(nextQuestion);
  });
});

describe('Agent 文献检索事件回归', () => {
  const candidate = { id: 'openalex-W1', provider: 'openalex' as const, providerId: 'W1', title: 'A related paper', authors: ['A. Author'], year: 2025, url: 'https://openalex.org/W1', abstract: 'A real candidate abstract.', retrievedAt: '2026-10-21T12:00:00.000Z' };
  const searching: ResearchLiteratureSearch = { id: 'search-1', query: 'adaptive retrieval', yearFrom: 2020, yearTo: 2026, createdAt: '2026-10-21T12:00:00.000Z', status: 'searching', candidates: [] };
  const searched: ResearchLiteratureSearch = { ...searching, status: 'done', candidates: [candidate], warnings: ['部分题录信息缺失'], partial: true };
  it('未收录的第二篇候选及摘要进入后续历史，原回答与资料库不被改写', async () => {
    const second = { ...candidate, id: 'openalex-W2', providerId: 'W2', title: 'The second paper', abstract: 'Second abstract: distinguish evidence conditions.', url: 'https://openalex.org/W2' };
    const batch = { ...searched, candidates: [candidate, second] };
    vi.stubGlobal('fetch', mockRun([{ type: 'literature', search: batch }, { type: 'delta', text: '见下方候选。' }, done]));
    const beforeDocumentIds = [...state().researches[researchId].documentIds];
    const first = await submitResearchRun(researchId, '整理研究资料');
    const fetcher = mockRun([{ type: 'delta', text: '第二篇摘要强调证据条件。' }, done]); vi.stubGlobal('fetch', fetcher);
    const followUp = await submitResearchRun(researchId, '第二篇摘要呢？');
    const payload = JSON.parse((fetcher.mock.calls.find(call => String(call[0]).endsWith('/run')) as unknown as [string, RequestInit])[1].body as string);
    expect(payload.history).toHaveLength(1);
    expect(payload.history[0].body).toContain(second.title); expect(payload.history[0].body).toContain(second.abstract);
    expect(payload.history[0].body.indexOf(candidate.title)).toBeLessThan(payload.history[0].body.indexOf(second.title));
    expect(payload.history[0].body).toContain(searched.query); expect(payload.history[0].body).toContain('未读 PDF'); expect(payload.history[0].body).toContain('不构成本轮');
    expect(state().requests[first].body).toBe('见下方候选。'); expect(state().requests[first].researchRun?.literatureSearches).toEqual([batch]);
    expect(state().requests[followUp].history?.[0].body).toBe(payload.history[0].body);
    expect(state().researches[researchId].documentIds).toEqual(beforeDocumentIds);
  });
  for (const limit of ['history', 'input'] as const) {
    it(`候选的完整摘要计入 ${limit === 'history' ? '80,000 历史' : '120,000 单次输入'}预算，超限不截断或清空草稿`, async () => {
      const prompt = limit === 'history' ? '第二篇摘要呢？' : '问'.repeat(50000);
      const batch = { ...searched, candidates: [{ ...candidate, abstract: '摘'.repeat(limit === 'history' ? 80000 : 79000) }] };
      workspace.updateData(data => {
        data.requests.catalog = { id: 'catalog', researchId, conversationId, prompt: '寻找论文', body: '见下方候选。', status: 'done', createdAt: '2026-10-21', context: [], evidenceIds: [], researchRun: { literatureSearches: [batch] } };
        data.conversations[conversationId].requestIds.push('catalog'); data.conversations[conversationId].input = prompt;
      });
      const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
      await expect(submitResearchRun(researchId, prompt)).rejects.toThrow(limit === 'history' ? '80,000' : '120,000');
      expect(fetcher).not.toHaveBeenCalled(); expect(state().conversations[conversationId].input).toBe(prompt);
      expect(state().conversations[conversationId].requestIds).toEqual(['catalog']);
      expect(state().requests.catalog.body).toBe('见下方候选。'); expect(state().requests.catalog.researchRun?.literatureSearches).toEqual([batch]);
    });
  }
  it('其他会话的候选不会混入新话题，失败重试仍使用提交时的候选历史快照', async () => {
    vi.stubGlobal('fetch', mockRun([{ type: 'literature', search: searched }, { type: 'delta', text: '见下方候选。' }, done]));
    await submitResearchRun(researchId, '整理研究资料');
    const otherConversation = createResearchConversation(researchId);
    const isolated = mockRun([{ type: 'delta', text: '这是独立话题。' }, done]); vi.stubGlobal('fetch', isolated);
    await submitResearchRun(researchId, '独立提问');
    const isolatedPayload = JSON.parse((isolated.mock.calls.find(call => String(call[0]).endsWith('/run')) as unknown as [string, RequestInit])[1].body as string);
    expect(isolatedPayload.history).toEqual([]); expect(state().conversations[otherConversation].requestIds).toHaveLength(1);
    openResearchConversation(researchId, conversationId);
    workspace.updateData(data => { data.conversations[conversationId].input = '第二篇摘要呢？'; });
    vi.stubGlobal('fetch', mockRun([{ type: 'error', error: '需要重试' }]));
    const failed = await submitResearchRun(researchId, '第二篇摘要呢？');
    const originalHistory = structuredClone(state().requests[failed].history);
    expect(originalHistory?.[0].body).toContain(candidate.abstract);
    workspace.updateData(data => {
      data.requests.later = { id: 'later', researchId, conversationId, prompt: '后来的新查询', body: '后来候选', status: 'done', createdAt: '2026-10-21', context: [], evidenceIds: [], researchRun: { literatureSearches: [{ ...searched, id: 'later-batch', query: 'a later search', candidates: [{ ...candidate, title: 'Later different paper' }] }] } };
      data.conversations[conversationId].requestIds.push('later'); data.conversations[conversationId].input = '另外一条尚未发送的输入';
    });
    const retried = mockRun([{ type: 'delta', text: '重试回答摘要。' }, done]); vi.stubGlobal('fetch', retried);
    const retry = await submitResearchRun(researchId, '第二篇摘要呢？', failed);
    expect(state().requests[retry].history).toEqual(originalHistory);
    const retryPayload = JSON.parse((retried.mock.calls.find(call => String(call[0]).endsWith('/run')) as unknown as [string, RequestInit])[1].body as string);
    expect(retryPayload.history[0].body).toBe(originalHistory?.[0].body); expect(JSON.stringify(retryPayload.history)).not.toContain('Later different paper');
    expect(state().conversations[conversationId].input).toBe('另外一条尚未发送的输入');
  });
  it('历史只把已完成检索的候选作为题录数据，不将未完成或停止批次冒充结果', async () => {
    workspace.updateData(data => {
      data.requests.catalog = { id: 'catalog', researchId, conversationId, prompt: '寻找论文', body: '见下方候选。', status: 'done', createdAt: '2026-10-21', context: [], evidenceIds: [], researchRun: { literatureSearches: [searched, { ...searched, id: 'stopped-batch', status: 'stopped', query: 'incomplete-search', candidates: [{ ...candidate, title: 'Not a completed candidate' }] }] } };
      data.conversations[conversationId].requestIds.push('catalog');
    });
    const fetcher = mockRun([{ type: 'delta', text: '继续说明。' }, done]); vi.stubGlobal('fetch', fetcher);
    const id = await submitResearchRun(researchId, '继续比较');
    expect(state().requests[id].history?.[0].body).toContain(candidate.title);
    expect(state().requests[id].history?.[0].body).not.toContain('incomplete-search');
    expect(state().requests[id].history?.[0].body).not.toContain('Not a completed candidate');
  });
  it('同一批次搜索进度替换为完整结果并落盘，不复制批次或丢掉摘要警告', async () => {
    vi.stubGlobal('fetch', mockRun([{ type: 'literature', search: searching }, { type: 'literature', search: searched }, { type: 'delta', text: '已找到可收录的候选论文。' }, done]));
    const id = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[id].status).toBe('done');
    expect(state().requests[id].researchRun?.literatureSearches).toEqual([searched]);
    expect(vi.mocked(saveWorkspace).mock.calls.at(-1)?.[0].requests[id].researchRun?.literatureSearches).toEqual([searched]);
  });
  it('切换会话和研究后到达的检索只归提交时请求，不污染新会话或抢画面', async () => {
    let nextConversation = '';
    const events = mockRun([{ type: 'literature', search: searched }, { type: 'delta', text: '原问题的候选结果。' }, done]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/run')) {
        nextConversation = createResearchConversation(researchId);
        workspace.updateData(data => { data.conversations[nextConversation].input = '新的研究话题'; });
        workspace.switchResearch('research-b');
      }
      return events(url);
    }));
    const id = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[id]).toMatchObject({ researchId, conversationId, status: 'done' });
    expect(state().requests[id].researchRun?.literatureSearches).toEqual([searched]);
    expect(state().conversations[nextConversation]).toMatchObject({ input: '新的研究话题', requestIds: [] });
    expect(state().scope).toEqual({ kind: 'research', researchId: 'research-b' });
  });
  for (const outcome of ['error', 'stopped'] as const) {
    it(`${outcome} 结束未完成检索，保留先前完成的候选和原查询`, async () => {
      const pending: ResearchLiteratureSearch = { ...searching, id: 'search-pending', query: 'limitations' };
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => url.includes('capabilities')
        ? new Response(JSON.stringify({ connections: [{ id: 'codex', research: true }] }))
        : new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; options?.signal?.addEventListener('abort', () => controller.error(new DOMException('已停止', 'AbortError')), { once: true }); controller.enqueue(new TextEncoder().encode([{ type: 'literature', search: searched }, { type: 'literature', search: pending }].map(event => JSON.stringify(event)).join('\n') + '\n')); } }))));
      const promise = submitResearchRun(researchId, '整理研究资料');
      await vi.waitFor(() => expect(Object.values(state().requests).find(request => request.researchRun?.literatureSearches?.length === 2)).toBeTruthy());
      const request = Object.values(state().requests).find(item => item.status === 'generating')!;
      if (outcome === 'stopped') stopResearchRun(request.id);
      else { stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'error', error: '模拟运行失败' }) + '\n')); stream.close(); }
      await promise;
      expect(state().requests[request.id].status).toBe(outcome);
      const searches = state().requests[request.id].researchRun!.literatureSearches!;
      expect(searches[0]).toEqual(searched); expect(searches[1]).toMatchObject({ id: pending.id, query: pending.query, status: outcome === 'stopped' ? 'stopped' : 'interrupted', candidates: [] });
      expect(searches[1].error).toBeTruthy();
      expect(vi.mocked(saveWorkspace).mock.calls.at(-1)?.[0].requests[request.id].researchRun?.literatureSearches).toEqual(searches);
    });
  }
  it('合法长摘要及同一传输块中的多个批次不会触发旧 500k 缓冲误报', async () => {
    const searches = Array.from({ length: 3 }, (_, index) => ({ ...searched, id: `batch-${index}`, candidates: Array.from({ length: 10 }, (_, item) => ({ ...candidate, id: `openalex-W${index}${item}`, providerId: `W${index}${item}`, abstract: '摘'.repeat(100000) })) }));
    vi.stubGlobal('fetch', mockRun([...searches.map(search => ({ type: 'literature', search })), { type: 'delta', text: '三组候选已完成。' }, done]));
    const id = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[id].status).toBe('done'); expect(state().requests[id].researchRun?.literatureSearches).toEqual(searches);
  });
  it('单条超限事件仍明确拒绝，不能因为支持多个合法批次取消事件保护', async () => {
    vi.stubGlobal('fetch', mockRun([{ type: 'delta', text: 'x'.repeat(2100000) }, done]));
    const id = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[id].status).toBe('error'); expect(state().requests[id].error).toContain('事件过大');
    expect(state().requests[id].body).toBe(''); expect(state().conversations[conversationId].input).toBe('整理研究资料');
  });
  it('损坏候选在写入之前被拒绝，前三个有效批次也不会被第四批覆盖', async () => {
    vi.stubGlobal('fetch', mockRun([{ type: 'literature', search: { ...searched, candidates: [{ ...candidate, url: 'javascript:alert(1)' }] } }, done]));
    let id = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[id].status).toBe('error'); expect(state().requests[id].researchRun?.literatureSearches).toBeUndefined();
    const valid = [0, 1, 2].map(index => ({ ...searched, id: `batch-${index}` }));
    vi.stubGlobal('fetch', mockRun([...valid.map(search => ({ type: 'literature', search })), { type: 'literature', search: { ...searched, id: 'batch-4' } }, done]));
    id = await submitResearchRun(researchId, '整理研究资料');
    expect(state().requests[id].status).toBe('error'); expect(state().requests[id].error).toContain('次数异常');
    expect(state().requests[id].researchRun?.literatureSearches).toEqual(valid);
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
