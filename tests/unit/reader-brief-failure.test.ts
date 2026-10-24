import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { getAsset, loadWorkspace, saveWorkspace } from '../../src/data/storage';
import type { AIRequest } from '../../src/domain/types';
import { liveResponder, retryAI, stopAI, submitAI } from '../../src/services/ai';
import { createInlineConversation } from '../../src/services/inline-ai';
import { stopPaperBriefs } from '../../src/services/paper-brief';
import { loadPdfDocument } from '../../src/services/pdf';
import { workspace } from '../../src/services/workspace';
import { drawingDigest, drawingPng } from '../fixtures/drawing-question';

vi.mock('../../src/data/storage', async importOriginal => ({ ...await importOriginal<typeof import('../../src/data/storage')>(),
  loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn().mockResolvedValue(undefined), getAsset: vi.fn() }));
vi.mock('../../src/services/pdf', () => ({ loadPdfDocument: vi.fn() }));
const state = () => workspace.getState().data;
const legacyError = '卡片标题、正文或来源格式不正确，请重试。';
type Payload = { requestId: string; purpose: string; messages: { role: string; content: unknown }[] };
const output = (body: string) => new Response(JSON.stringify({ type: 'delta', text: body }) + '\n' + JSON.stringify({ type: 'done', model: 'brief-failure-fixture' }) + '\n');
const failure = (error = legacyError) => new Response(JSON.stringify({ type: 'error', error }) + '\n');
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function network(answer: (payload: Payload) => Response | Promise<Response>) {
  const calls: Payload[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === '/api/ai/config') return Response.json({ configured: true, runtime: 'pi', provider: '测试', model: 'brief-failure-fixture', images: true, mode: 'live' });
    if (String(url) !== '/api/ai/chat') throw new Error(`未授权测试端点 ${String(url)}`);
    const payload = JSON.parse(String(init?.body)) as Payload; calls.push(payload); return answer(payload);
  }));
  return calls;
}
async function local(kind: 'text' | 'region' = 'text') {
  const imageHash = drawingDigest(await drawingPng.arrayBuffer());
  const id = createInlineConversation('research-a', { documentId: 'paper-a', pageIndex: 0,
    quote: kind === 'text' ? 'Selected original formula and its explicit assumptions.' : '', kind,
    ...(kind === 'region' ? { region: { assetId: 'brief-region', hash: imageHash, rect: { x: .1, y: .1, width: .5, height: .2 }, rotation: 0, width: 1, height: 1 } } : {}) });
  workspace.updateData(data => { data.conversations[id].input = '解释选中公式的假设'; }); return id;
}

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.stubGlobal('FileReader', class { result: string | null = null; onload?: () => void;
    readAsDataURL(blob: Blob) { void blob.arrayBuffer().then(bytes => { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload?.(); }); } });
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  vi.mocked(getAsset).mockReset().mockImplementation(async id => id === 'brief-region' ? drawingPng : new Blob(['synthetic PDF']));
  const seed = createSeed(); seed.documents['paper-a'].hash = 'a'.repeat(64); seed.conversations['conversation-research-a'].connectionId = 'model';
  seed.conversations['conversation-research-a'].input = '主会话的独立草稿';
  seed.researches['research-a'].directory = { id: 'before', projectId: 'before', path: '/fixture/before' };
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(seed); await workspace.load();
  vi.mocked(loadPdfDocument).mockReset().mockResolvedValue({ hash: 'a'.repeat(64), pdf: { numPages: 1,
    getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'Synthetic paper text for the shared background.' }] }) }) } } as never);
});
afterEach(async () => { await stopPaperBriefs(); await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('文章简要不能阻断普通选区提问', () => {
  it('实际模型解析使用独立brief Markdown协议，普通提问不要求卡片JSON', async () => {
    const calls = network(payload => output(payload.purpose === 'brief' ? '## 研究问题\n仅根据本篇提取文字形成背景；未知部分保留。' : '公式的条件需要结合所选原文理解。[1]'));
    const id = await local(), requestId = await submitAI('research-a', id, '解释选中公式的假设');
    expect(calls.map(call => call.purpose)).toEqual(['brief', 'chat']);
    expect(state().requests[requestId]).toMatchObject({ status: 'done', body: '公式的条件需要结合所选原文理解。[1]' });
    expect(state().requests[requestId].paperBrief?.body).toContain('研究问题');
    expect(state().requests[requestId].result).toBeUndefined(); expect(Object.keys(state().cardDrafts)).toHaveLength(0);
  });

  it.each(['text', 'region'] as const)('%s选区遇到原卡片格式错误仍只发送一次真正问题，保留显式上下文', async kind => {
    const calls = network(payload => payload.purpose === 'brief' ? failure() : output('按当前选区回答，不扩大资料范围。[1]'));
    const id = await local(kind), evidenceId = state().conversations[id].inlineSource!.evidenceId;
    const evidence = structuredClone(state().evidence[evidenceId]);
    const requestId = await submitAI('research-a', id, '解释选中公式的假设');
    expect(calls.map(call => call.purpose)).toEqual(['brief', 'chat']);
    expect(state().requests[requestId]).toMatchObject({ status: 'done', paperBriefState: 'error' });
    expect(state().requests[requestId].paperBrief).toBeUndefined();
    expect(state().requests[requestId].materials?.some(item => item.id.startsWith('paper-brief:')) ?? false).toBe(false);
    expect(state().requests[requestId].context).toHaveLength(1);
    expect(state().requests[requestId].context[0]).toMatchObject({ evidenceId, documentId: 'paper-a', pageIndex: 0 });
    expect(state().requests[requestId].context[0].kind ?? 'text').toBe(kind);
    expect(state().evidence[evidenceId]).toEqual(evidence);
    if (kind === 'region') expect(JSON.stringify(calls[1].messages)).toContain(`data:image/png;base64,${Buffer.from(await drawingPng.arrayBuffer()).toString('base64')}`);
    expect(state().conversations['conversation-research-a'].input).toBe('主会话的独立草稿');
    expect(Object.keys(state().cardDrafts)).toHaveLength(0);
  });

  it('真正问题失败后保留输入，按原快照重试只增加一轮实际问题', async () => {
    let chats = 0;
    const calls = network(payload => payload.purpose === 'brief' ? failure('简要服务暂不可用') : ++chats === 1 ? failure('真正问题暂时失败') : output('重试后的选区回答。[1]'));
    const id = await local(), first = await submitAI('research-a', id, '解释选中公式的假设');
    expect(state().requests[first]).toMatchObject({ status: 'error', error: '真正问题暂时失败' });
    expect(state().conversations[id].input).toBe('解释选中公式的假设');
    const snapshot = structuredClone(state().requests[first].context), next = await retryAI(first);
    expect(state().requests[next]).toMatchObject({ status: 'done', retryOf: first, context: snapshot });
    expect(calls.filter(call => call.purpose === 'chat')).toHaveLength(2);
    expect(state().conversations[id].requestIds).toEqual([first, next]);
  });

  it.each(['', '等待时新写的后续草稿'])('等待简要时停止，原输入恢复且不覆盖新草稿：%s', async laterDraft => {
    const waiting = deferred<Response>(); const calls = network(payload => payload.purpose === 'brief' ? waiting.promise : output('不应发送'));
    const id = await local(), pending = submitAI('research-a', id, '解释选中公式的假设');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    if (laterDraft) workspace.updateData(data => { data.conversations[id].input = laterDraft; });
    const requestId = state().conversations[id].requestIds[0]; stopAI(requestId);
    waiting.resolve(failure()); await pending;
    expect(state().requests[requestId].status).toBe('stopped'); expect(calls.map(call => call.purpose)).toEqual(['brief']);
    expect(state().conversations[id].input).toBe(laterDraft || '解释选中公式的假设');
  });

  it.each(['directory', 'connection', 'document'] as const)('等待简要时%s改变，硬边界错误不得退到选区后迟到发送', async boundary => {
    const waiting = deferred<Response>(); const calls = network(payload => payload.purpose === 'brief' ? waiting.promise : output('不应发送'));
    const id = await local(), pending = submitAI('research-a', id, '解释选中公式的假设');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    workspace.updateData(data => {
      if (boundary === 'directory') data.researches['research-a'].directory = { id: 'after', projectId: 'after', path: '/fixture/after' };
      else if (boundary === 'connection') data.conversations[id].connectionId = 'claude';
      else data.documents['paper-a'].hash = 'b'.repeat(64);
    });
    waiting.resolve(output('迟到的文章简要')); const requestId = await pending;
    expect(state().requests[requestId].status).toBe('error'); expect(state().requests[requestId].error).toMatch(/目录|工作区|论文|文件/);
    expect(calls.map(call => call.purpose)).toEqual(['brief']);
  });

  it('内部简要超时可退到选区，外层问题仍只发送一次', async () => {
    const waiting = deferred<Response>(); const calls = network(payload => payload.purpose === 'brief' ? waiting.promise : output('简要超时后的选区回答。[1]'));
    const id = await local(), pending = submitAI('research-a', id, '解释选中公式的假设');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(120001); const requestId = await pending;
    waiting.resolve(output('已过时的简要'));
    expect(state().requests[requestId]).toMatchObject({ status: 'done', paperBriefState: 'error' });
    expect(calls.map(call => call.purpose)).toEqual(['brief', 'chat']);
  });

  it('简要模型失败与原文hash变化同时发生仍是硬边界，不能误降级发送', async () => {
    const waiting = deferred<Response>(); const calls = network(payload => payload.purpose === 'brief' ? waiting.promise : output('不应发送'));
    const id = await local(), pending = submitAI('research-a', id, '解释选中公式的假设');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    workspace.updateData(data => { data.documents['paper-a'].hash = 'b'.repeat(64); });
    waiting.resolve(failure('简要模型与源文件同时失效')); const requestId = await pending;
    expect(state().requests[requestId].status).toBe('error');
    expect(state().requests[requestId].error).toMatch(/目录|连接|论文|文件/);
    expect(calls.map(call => call.purpose)).toEqual(['brief']);
    expect(state().conversations[id].input).toBe('解释选中公式的假设');
  });

  it('PDF loader直接拒绝原文件hash校验时不发送简要或问题，保留问题与选区', async () => {
    const calls = network(() => output('不应发送'));
    const id = await local(), evidenceId = state().conversations[id].inlineSource!.evidenceId;
    const hashError = '原文件内容与保存的来源不一致，请导入为新论文后建立新的引用。';
    vi.mocked(loadPdfDocument).mockRejectedValueOnce(new Error(hashError));
    const requestId = await submitAI('research-a', id, '解释选中公式的假设');
    expect(calls).toEqual([]);
    expect(state().requests[requestId]).toMatchObject({ status: 'error', paperBriefState: 'error' });
    expect(state().requests[requestId].error).toBe(hashError);
    expect(state().requests[requestId].context[0].evidenceId).toBe(evidenceId);
    expect(state().requests[requestId].paperBrief).toBeUndefined();
    expect(state().conversations[id].input).toBe('解释选中公式的假设');
    expect(state().documents['paper-a'].hash).toBe('a'.repeat(64));
  });

  it('PDF已成功加载后普通文字提取失败允许仅选区提问，不误判原文件失效', async () => {
    const calls = network(() => output('仅根据当前选区解释。[1]'));
    vi.mocked(loadPdfDocument).mockResolvedValueOnce({ hash: 'a'.repeat(64), pdf: { numPages: 1,
      getPage: async () => ({ getTextContent: async () => { throw new Error('页面文字提取失败'); } }) } } as never);
    const id = await local(), evidenceId = state().conversations[id].inlineSource!.evidenceId;
    const requestId = await submitAI('research-a', id, '解释选中公式的假设');
    expect(calls.map(call => call.purpose)).toEqual(['chat']);
    expect(state().requests[requestId]).toMatchObject({ status: 'done', paperBriefState: 'error', body: '仅根据当前选区解释。[1]' });
    expect(state().requests[requestId].context).toHaveLength(1);
    expect(state().requests[requestId].context[0].evidenceId).toBe(evidenceId);
    expect(state().requests[requestId].paperBrief).toBeUndefined();
    expect(state().requests[requestId].materials?.some(item => item.id.startsWith('paper-brief:')) ?? false).toBe(false);
    expect(state().documents['paper-a'].paperBrief).toMatchObject({ status: 'error', error: '页面文字提取失败' });
  });

  it('工作区重新加载后，旧简要失败不能触发迟到问题或改写新草稿', async () => {
    const waiting = deferred<Response>(); const calls = network(payload => payload.purpose === 'brief' ? waiting.promise : output('不应发送'));
    const id = await local(), pending = submitAI('research-a', id, '解释选中公式的假设');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const replacement = createSeed(); replacement.conversations['conversation-research-a'].input = '重新加载后的草稿';
    for (const key of ['papertrail-recovery-v3', 'papertrail-recovery-v2', 'papertrail-recovery-v1']) localStorage.removeItem(key);
    vi.mocked(loadWorkspace).mockResolvedValue(replacement); await workspace.load();
    waiting.resolve(failure()); await pending;
    expect(calls.map(call => call.purpose)).toEqual(['brief']);
    expect(state().conversations['conversation-research-a'].input).toBe('重新加载后的草稿');
    expect(state().requests).toEqual({});
  });

  it('只切换当前研究仍归原研究完成，不污染新研究或新输入', async () => {
    const waiting = deferred<Response>(); const calls = network(payload => payload.purpose === 'brief' ? waiting.promise : output('原研究选区的回答。[1]'));
    const id = await local(), pending = submitAI('research-a', id, '解释选中公式的假设');
    await vi.waitFor(() => expect(calls).toHaveLength(1)); workspace.switchResearch('research-b');
    workspace.updateData(data => { data.conversations['conversation-research-b'].input = '新研究的独立输入'; });
    waiting.resolve(failure()); const requestId = await pending;
    expect(state().requests[requestId]).toMatchObject({ status: 'done', researchId: 'research-a', conversationId: id });
    expect(state().scope).toEqual({ kind: 'research', researchId: 'research-b' });
    expect(state().conversations['conversation-research-b'].input).toBe('新研究的独立输入');
    expect(state().conversations['conversation-research-b'].requestIds).toEqual([]);
  });

  it('卡片与revision仍严格校验JSON，独立brief协议不放宽卡片来源', async () => {
    network(() => output(JSON.stringify({ title: '错误卡片', body: '正文', evidenceIds: ['未提供的证据'] })));
    const id = await local();
    for (const purpose of ['card', 'revision'] as const) {
      const request: AIRequest = { id: `strict-${purpose}`, researchId: 'research-a', conversationId: id, purpose, prompt: '生成卡片', context: [], body: '', evidenceIds: [], status: 'generating', createdAt: new Date().toISOString(), connectionId: 'model' };
      await expect(liveResponder(request)).rejects.toThrow(/卡片标题、正文或来源格式不正确/);
    }
  });
});
