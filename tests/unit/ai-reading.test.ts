import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { getAsset, loadWorkspace, saveMigrationBackup, saveWorkspace } from '../../src/data/storage';
import type { AIRequest, ContextSnapshot, WorkspaceData } from '../../src/domain/types';
import {
  applyCardRevision, commitCardDraft, createManualCardDraft, discardCardDraft, generateCardDraft, generateCardDraftFromExcerpts,
  buildRequestScope, historyForConversation, retryAI, reviseCardDraft, stopAI, submitAI, undoCardRevision,
  type AIResponder,
} from '../../src/services/ai';
import { workspace } from '../../src/services/workspace';
import { hasFullText } from '../../src/domain/knowledge';

vi.mock('../../src/data/storage', () => ({
  loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn(), contentHash: vi.fn(),
}));
const memory = new Map<string, string>();
const conversationId = 'conversation-research-a';
const data = () => workspace.getState().data;

function snapshot(evidenceId: string): ContextSnapshot {
  const evidence = data().evidence[evidenceId], document = data().documents[evidence.documentId];
  return { evidenceId, documentId: document.id, documentHash: document.hash ?? '', title: document.title, pageIndex: evidence.pageIndex, quote: evidence.quote };
}
function oldRequest(id: string, overrides: Partial<AIRequest> = {}): AIRequest {
  return {
    id, researchId: 'research-a', conversationId, prompt: '此前的问题', body: '此前回答 [1]',
    context: [snapshot('evidence-a')], evidenceIds: ['evidence-a'], createdAt: '2026-10-16T00:00:00.000Z',
    status: 'done', purpose: 'chat', mode: 'live', history: [], ...overrides,
  };
}
function addContext(evidenceIds = ['evidence-b']) {
  workspace.addContext({ researchId: 'research-a', conversationId, evidenceIds });
}
async function answer(body = '这是原始回答，可提炼为独立知识点。 [1]') {
  addContext();
  return submitAI('research-a', conversationId, '什么条件下成立？', async () => ({ body, evidenceIds: ['evidence-b'] }));
}
const card = { title: '相关证据的作用', body: '证据有效性受到相关性约束。 [1]', evidenceIds: ['evidence-b'] };
const cardResponder: AIResponder = async () => ({ body: JSON.stringify(card), evidenceIds: card.evidenceIds, result: card });

beforeEach(async () => {
  vi.useFakeTimers();
  memory.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  });
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  vi.mocked(saveMigrationBackup).mockReset().mockResolvedValue(undefined);
  vi.mocked(getAsset).mockReset().mockResolvedValue(new Blob(['local PDF fixture']));
  const seed = createSeed();
  Object.values(seed.documents).filter(hasFullText).forEach(document => { document.hash = 'a'.repeat(64); });
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(seed);
  await workspace.load();
});
afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('多轮聊天、停止和原始问答', () => {
  it('超过4000字的问题完整提交，不在页面额外截断或拒绝', async () => {
    const prompt = '这是需要完整发送的研究问题。'.repeat(500);
    workspace.updateData(next => { next.conversations[conversationId].input = prompt; });
    const responder = vi.fn(async (_request: AIRequest) => ({ body: '已收到完整问题', evidenceIds: [] }));
    const id = await submitAI('research-a', conversationId, prompt, responder);
    expect(responder.mock.calls[0][0].prompt).toBe(prompt);
    expect(data().requests[id].status).toBe('done');
    expect(data().conversations[conversationId].input).toBe('');
  });

  it.each(['done', 'error'] as const)('请求进入会话即清空输入，%s 后不覆盖下一条草稿', async status => {
    const prompt = '本次提交的问题';
    workspace.updateData(next => { next.conversations[conversationId].input = prompt; });
    let finish!: () => void;
    const pending = submitAI('research-a', conversationId, prompt, () => new Promise((resolve, reject) => {
      finish = () => status === 'done' ? resolve({ body: '回答已完成', evidenceIds: [] }) : reject(new Error('连接中断'));
    }));
    try {
      await vi.waitFor(() => expect(finish).toBeDefined());
      expect(data().conversations[conversationId].input).toBe('');
      // Repeating the same question is also a new draft, so completion must not clear it again.
      workspace.updateData(next => { next.conversations[conversationId].input = prompt; });
    } finally { finish?.(); await pending; }
    expect(data().conversations[conversationId].input).toBe(prompt);
  });

  it('发送失败且没有新草稿时恢复原输入，包括首尾空白', async () => {
    const prompt = '  请保留完整的输入  ';
    workspace.updateData(next => { next.conversations[conversationId].input = prompt; });
    const id = await submitAI('research-a', conversationId, prompt, async () => { throw new Error('连接失败'); });
    expect(data().requests[id].status).toBe('error');
    expect(data().conversations[conversationId].input).toBe(prompt);
  });

  it('已收到部分回答后失败，保留问答和重试入口，不回填已发送问题', async () => {
    const prompt = '这段原文的适用条件是什么？';
    workspace.updateData(next => { next.conversations[conversationId].input = prompt; });
    const id = await submitAI('research-a', conversationId, prompt, async (_request, options) => {
      options?.onDelta('已收到问题，正在核对研究条件。');
      throw new Error('回答期间连接中断');
    });
    expect(data().requests[id]).toMatchObject({ status: 'error', prompt, body: '已收到问题，正在核对研究条件。' });
    expect(data().conversations[conversationId].input).toBe('');
    const retry = retryAI(id, 'demo');
    await vi.runAllTimersAsync();
    const retried = await retry;
    expect(data().requests[retried]).toMatchObject({ status: 'done', retryOf: id, prompt });
    expect(data().conversations[conversationId].input).toBe('');
  });

  it('资产准备期间恢复工作区，不提交旧请求或清空导入的输入', async () => {
    const prompt = '恢复后继续保留的研究问题';
    addContext();
    workspace.updateData(next => { next.conversations[conversationId].input = prompt; });
    let ready!: (asset: Blob) => void;
    vi.mocked(getAsset).mockReturnValueOnce(new Promise(resolve => { ready = resolve; }));
    const responder = vi.fn(async () => ({ body: '不应执行', evidenceIds: [] }));
    const pending = submitAI('research-a', conversationId, prompt, responder).catch(error => error);
    try {
      await vi.waitFor(() => expect(getAsset).toHaveBeenCalled());
      vi.mocked(loadWorkspace).mockResolvedValue(structuredClone(data()));
      await workspace.load();
    } finally { ready(new Blob(['local PDF fixture'])); }
    expect(await pending).toMatchObject({ message: expect.stringContaining('工作区已改变') });
    expect(responder).not.toHaveBeenCalled();
    expect(data().conversations[conversationId].requestIds).toEqual([]);
    expect(data().conversations[conversationId].input).toBe(prompt);
  });

  it('旧版曾允许编辑的完成回答转为卡片时保留不完整来源标记', () => {
    const legacy = oldRequest('legacy-saved', { legacy: true });
    workspace.updateData(next => { next.requests[legacy.id] = legacy; });
    const draftId = createManualCardDraft(legacy.id);
    expect(data().cardDrafts[draftId].source).toMatchObject({ answer: legacy.body, incomplete: true });
    expect(data().requests[legacy.id].body).toBe(legacy.body);
  });
  it('默认历史仅含完成且有效的聊天，排除中断、旧版本、旧演示和整理请求', () => {
    const requests = [
      oldRequest('good-first'), oldRequest('partial', { status: 'stopped' }),
      oldRequest('interrupted', { status: 'interrupted' }), oldRequest('failed', { status: 'error' }),
      oldRequest('invalid-citation', { validationError: '引用不存在' }),
      oldRequest('old-version', { superseded: true }), oldRequest('legacy', { legacy: true }),
      oldRequest('card-generation', { purpose: 'card' }), oldRequest('revision', { purpose: 'revision' }),
      oldRequest('good-latest', { body: '最新有效回答 [1]' }),
    ];
    workspace.updateData(next => {
      requests.forEach(request => { next.requests[request.id] = request; });
      next.conversations[conversationId].requestIds = requests.map(request => request.id);
    });
    const history = historyForConversation(data(), conversationId);
    expect(history.map(turn => turn.requestId)).toEqual(['good-first', 'good-latest']);
    history[0].context[0].quote = '修改返回副本';
    history[0].evidenceIds.push('other');
    expect(data().requests['good-first'].context[0].quote).not.toBe('修改返回副本');
    expect(data().requests['good-first'].evidenceIds).toEqual(['evidence-a']);
    workspace.updateData(next => { next.conversations[conversationId].historyRange = 'latest'; });
    expect(historyForConversation(data(), conversationId).map(turn => turn.requestId)).toEqual(['good-latest']);
    workspace.updateData(next => { next.conversations[conversationId].historyRange = 'none'; });
    expect(historyForConversation(data(), conversationId)).toEqual([]);
  });

  it('实际发送历史按本次材料顺序重映射引用编号，同时保留原始回答和编号', async () => {
    const old = oldRequest('old', {
      body: '依据论文 B [2]', evidenceIds: ['evidence-a', 'evidence-b'],
      context: [snapshot('evidence-b'), snapshot('evidence-a')],
    });
    workspace.updateData(next => { next.requests.old = old; next.conversations[conversationId].requestIds = ['old']; });
    let submitted!: AIRequest;
    const id = await submitAI('research-a', conversationId, '继续比较', async request => {
      submitted = request;
      return { body: '根据讨论继续分析。', evidenceIds: [] };
    });
    expect(submitted.context.map(item => item.evidenceId)).toEqual(['evidence-b', 'evidence-a']);
    expect(submitted.history?.[0]).toMatchObject({ body: '依据论文 B [2]', sentBody: '依据论文 B [1]' });
    expect(data().requests[id].history?.[0].sentBody).toBe('依据论文 B [1]');
    expect(data().requests.old.body).toBe('依据论文 B [2]');
  });

  it('停止先保存已收到的部分，忽略迟到增量和成功结果', async () => {
    addContext();
    let complete!: (result: { body: string; evidenceIds: string[] }) => void;
    let submitted!: AIRequest;
    let options!: Parameters<AIResponder>[1];
    const pending = submitAI('research-a', conversationId, '解释', (request, stream) => {
      submitted = request; options = stream; stream?.onDelta('已收到的一部分');
      return new Promise(resolve => { complete = resolve; });
    });
    await vi.waitFor(() => expect(complete).toBeDefined());
    stopAI(submitted.id);
    expect(options?.signal.aborted).toBe(true);
    options?.onDelta('迟到增量');
    complete({ body: '迟到的完整回答 [1]', evidenceIds: ['evidence-b'] });
    await pending;
    expect(data().requests[submitted.id]).toMatchObject({ status: 'stopped', body: '已收到的一部分' });
    expect(historyForConversation(data(), conversationId)).toEqual([]);
  });

  it('重试复制原问题、证据和历史快照，不使用当前新增上下文或历史设置', async () => {
    const old = oldRequest('before-failure');
    workspace.updateData(next => { next.requests[old.id] = old; next.conversations[conversationId].requestIds = [old.id]; });
    addContext();
    const failed = await submitAI('research-a', conversationId, '失败时的问题', async (_request, options) => {
      options?.onDelta('断流之前的部分');
      throw new Error('network interrupted');
    });
    const original = structuredClone(data().requests[failed]);
    workspace.updateData(next => {
      next.conversations[conversationId].contextIds = ['evidence-c'];
      next.conversations[conversationId].historyRange = 'none';
    });
    let sent!: { messages: { role: string; content: string }[] };
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/ai/config') return Response.json({ configured: true, model: 'test-model', images: false });
      expect(url).toBe('/api/ai/chat');
      sent = JSON.parse(String(options?.body));
      return new Response(`${JSON.stringify({ type: 'delta', text: '恢复回答 [2]' })}\n${JSON.stringify({ type: 'done', model: 'test-model' })}\n`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const retried = await retryAI(failed, 'live');

    expect(retried).not.toBe(failed);
    expect(data().requests[retried]).toMatchObject({ status: 'done', retryOf: failed, prompt: original.prompt });
    expect(data().requests[retried].context).toEqual(original.context);
    expect(data().requests[retried].history).toEqual(original.history);
    expect(data().requests[failed]).toEqual(original);
    expect(sent.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent.messages.at(-1)?.content).toBe('失败时的问题');
    expect(sent.messages[2].content).toBe(old.body);
    expect(sent.messages[0].content).toContain('evidenceId=evidence-b');
    expect(sent.messages[0].content).not.toContain('evidenceId=evidence-c');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('完成后的原始回答不可改写，独立编辑卡片不会影响聊天', async () => {
    const id = await answer();
    const original = data().requests[id].body;
    expect(() => workspace.updateData(next => { next.requests[id].body = '用户直接替换聊天'; })).toThrow(/原始问答/);
    expect(data().requests[id].body).toBe(original);
    const draftId = createManualCardDraft(id);
    workspace.updateData(next => { next.cardDrafts[draftId].body = '卡片中的新理解'; next.cardDrafts[draftId].revision++; });
    expect(data().cardDrafts[draftId].body).toBe('卡片中的新理解');
    expect(data().requests[id].body).toBe(original);
  });

  it('范围外引用阻止成功和 AI 建卡，但保留模型原始输出供人工核查', async () => {
    addContext();
    const raw = '模型原始输出，包含未经允许的引用 [1]';
    const id = await submitAI('research-a', conversationId, '核查', async () => ({
      body: raw, rawBody: raw, evidenceIds: ['evidence-a'],
    }));
    expect(data().requests[id]).toMatchObject({ status: 'error', body: raw });
    expect(data().requests[id].validationError).toMatch(/上下文之外/);
    await expect(generateCardDraft(id, undefined, cardResponder)).rejects.toThrow(/引用有效/);
    expect(Object.keys(data().cardDrafts)).toEqual([]);
    const manual = createManualCardDraft(id);
    expect(data().cardDrafts[manual]).toMatchObject({ needsReview: true, evidenceIds: [], source: { incomplete: true, answer: raw } });
  });

  it('真实传输适配器也会拒绝非法正文编号，保留流式原文', async () => {
    addContext();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/ai/config'
      ? Response.json({ configured: true, model: 'test-model', images: false })
      : new Response(`${JSON.stringify({ type: 'delta', text: '来源编号越界 [99]' })}\n${JSON.stringify({ type: 'done' })}\n`)));
    const id = await submitAI('research-a', conversationId, '核查正文');
    expect(data().requests[id]).toMatchObject({ status: 'error', body: '来源编号越界 [99]' });
    expect(data().requests[id].validationError).toContain('[99]');
    expect(historyForConversation(data(), conversationId)).toEqual([]);
  });

  it('同一会话已有回答时拒绝重试，避免并行请求收费与历史混排', async () => {
    const failed = oldRequest('failed-retry', { status: 'error' });
    workspace.updateData(next => { next.requests[failed.id] = failed; next.conversations[conversationId].requestIds = [failed.id]; });
    let complete!: (value: { body: string; evidenceIds: string[] }) => void;
    const pending = submitAI('research-a', conversationId, '正在生成的新问题', () => new Promise(resolve => { complete = resolve; }));
    await vi.waitFor(() => expect(complete).toBeDefined());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const rejected = retryAI(failed.id, 'live');
    complete({ body: '新问题的完整回答', evidenceIds: [] });
    await expect(rejected).rejects.toThrow(/正在回答|停止|等待/);
    await pending;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(data().conversations[conversationId].requestIds).toHaveLength(2);
    expect(data().requests[failed.id].status).toBe('error');
  });

  it('未来数据库版本存在时，即使有旧恢复缓冲也禁止自动覆盖', async () => {
    const recovery = JSON.stringify(createSeed());
    memory.set('papertrail-recovery-v2', recovery);
    const future = { ...createSeed(), schemaVersion: 4 } as unknown as WorkspaceData;
    vi.mocked(loadWorkspace).mockResolvedValue(future);
    vi.mocked(saveWorkspace).mockClear();
    await workspace.load();
    await vi.advanceTimersByTimeAsync(400);
    expect(workspace.getState().loadError).toMatch(/版本/);
    expect(saveWorkspace).not.toHaveBeenCalled();
    expect(memory.get('papertrail-recovery-v2')).toBe(recovery);
    expect(future.schemaVersion).toBe(4);
  });
});

describe('白板局部研究的统一发送范围', () => {
  function enableResearch() {
    workspace.updateData(next => {
      next.conversations[conversationId].historyRange = 'guided';
      next.conversations[conversationId].contextIds = [];
      next.conversations[conversationId].boardResearch = {
        origin: { boardId: 'board-a', rootTitle: '研究问题', rootRef: { kind: 'card', id: 'card-a' }, rootPlacementId: 'placement-a' },
        focus: [{ kind: 'card', id: 'card-a' }], automatic: [{ id: 'card:card-a', kind: 'card_note', title: '卡片', text: '待刷新', version: '1', resourceRef: { kind: 'card', id: 'card-a' } }],
        pinned: [], excludedSourceIds: [], includeBackground: true,
      };
    });
  }
  it('默认只选上一完成轮和最近原问题轮，逐轮选择不改变原记录', () => {
    enableResearch();
    const board = data().conversations[conversationId].boardResearch!;
    const root = oldRequest('root', { boardResearch: { ...board.origin, focus: [{ kind: 'card', id: 'card-a' }] } });
    const paper = oldRequest('paper', { boardResearch: { ...board.origin, focus: [{ kind: 'document', id: 'paper-a' }] } });
    const last = oldRequest('last', { boardResearch: { ...board.origin, focus: [{ kind: 'document', id: 'paper-a' }] } });
    workspace.updateData(next => { for (const request of [root, paper, last]) next.requests[request.id] = request; next.conversations[conversationId].requestIds = ['root', 'paper', 'last']; });
    expect(buildRequestScope(data(), 'research-a', conversationId).history.map(turn => turn.requestId)).toEqual(['root', 'last']);
    expect(buildRequestScope(data(), 'research-a', conversationId, 'last').history.map(turn => turn.requestId)).toEqual(['root', 'paper']);
    workspace.updateData(next => { next.conversations[conversationId].historyRange = 'selected'; next.conversations[conversationId].historyRequestIds = ['paper']; });
    expect(buildRequestScope(data(), 'research-a', conversationId).history.map(turn => turn.requestId)).toEqual(['paper']);
    expect(data().requests.root.body).toBe(root.body);
  });
  it('移除来源过滤历史原文副本，旧编号降级，原始回答与其他证据仍保留', async () => {
    enableResearch();
    const old = oldRequest('old-source', { body: 'A [1]，B [2]', evidenceIds: ['evidence-a', 'evidence-b'], context: [snapshot('evidence-a'), snapshot('evidence-b')] });
    workspace.updateData(next => {
      next.requests[old.id] = old; next.conversations[conversationId].requestIds = [old.id];
      next.conversations[conversationId].contextIds = ['evidence-a', 'evidence-b'];
      next.conversations[conversationId].boardResearch!.excludedSourceIds = ['evidence:evidence-a'];
    });
    let submitted!: AIRequest;
    await submitAI('research-a', conversationId, '继续问', async request => { submitted = request; return { body: '继续回答', evidenceIds: [] }; });
    expect(submitted.context.map(item => item.evidenceId)).toEqual(['evidence-b']);
    expect(submitted.history?.[0]).toMatchObject({ body: 'A （历史引用，原文未附送），B [1]', sentBody: 'A （历史引用，原文未附送），B [1]', evidenceIds: ['evidence-b'] });
    expect(submitted.history?.[0].context.map(item => item.evidenceId)).toEqual(['evidence-b']);
    expect(data().requests[old.id].body).toBe('A [1]，B [2]');
  });
  it('材料正文冻结，摘要经整理请求与确认卡片保留来路，不生成 PDF 依据', async () => {
    enableResearch();
    workspace.updateData(next => { next.conversations[conversationId].boardResearch!.pinned.push({ id: 'openalex:W1', kind: 'abstract', title: '候选论文', text: '仅摘要', version: '1', url: 'https://openalex.org/W1', provider: 'openalex', providerId: 'https://openalex.org/W1' }); });
    const id = await submitAI('research-a', conversationId, '解释摘要', async () => ({ body: '根据摘要提出待核查理解', evidenceIds: [] }));
    const original = data().requests[id].materials?.find(item => item.id === 'card:card-a')?.text;
    workspace.updateData(next => { next.cards['card-a'].body = '发送后的修改'; });
    expect(data().requests[id].materials?.find(item => item.id === 'card:card-a')?.text).toBe(original);
    const draftId = await generateCardDraft(id, undefined, async request => {
      expect(request.materials?.find(item => item.id === 'openalex:W1')?.text).toBe('仅摘要');
      const result = { title: '待核查理解', body: '需要阅读原文。', evidenceIds: [] };
      return { body: JSON.stringify(result), evidenceIds: [], result };
    });
    const cardId = commitCardDraft(draftId);
    const saved = data().cards[cardId];
    expect(saved.evidenceIds).toEqual([]);
    expect(saved.provenance?.materials?.find(item => item.id === 'openalex:W1')?.url).toBe('https://openalex.org/W1');
    expect(saved.provenance?.derivedFrom).toMatchObject({ sourceIds: expect.arrayContaining(['card:card-a', 'openalex:W1']), requestIds: expect.arrayContaining([id]) });
  });
  it('卡片与摘要计入统一保护阈值，在发送前拒绝超量', async () => {
    enableResearch();
    workspace.updateData(next => { next.conversations[conversationId].boardResearch!.pinned.push({ id: 'large', kind: 'abstract', title: '长摘要', text: '文'.repeat(120000), version: '1' }); });
    const responder = vi.fn(async () => ({ body: '不能调用', evidenceIds: [] }));
    await expect(submitAI('research-a', conversationId, '解释', responder)).rejects.toThrow(/120,000/);
    expect(responder).not.toHaveBeenCalled();
  });
  it('当前与历史材料一起计数，避免收为卡片后超过可持久化数量', () => {
    enableResearch();
    workspace.updateData(next => {
      const state = next.conversations[conversationId].boardResearch!;
      state.includeBackground = false; state.automatic = [];
      state.pinned = Array.from({ length: 100 }, (_, index) => ({ id: `abstract:${index}`, kind: 'abstract', title: `题录${index}`, text: '摘要', version: '1' }));
      next.requests.counted = oldRequest('counted', { context: [], evidenceIds: [], materials: structuredClone(state.pinned) });
      next.conversations[conversationId].requestIds = ['counted'];
    });
    expect(buildRequestScope(data(), 'research-a', conversationId).materials).toHaveLength(100);
    workspace.updateData(next => { next.requests.counted.materials![0].id = 'abstract:another'; });
    expect(() => buildRequestScope(data(), 'research-a', conversationId)).toThrow(/合计超过 100 项/);
  });
  it('历史派生来路仍可提示已排除来源，但不会重新赋予 PDF 引用资格', async () => {
    enableResearch();
    const old = oldRequest('old-derived', { materials: [{ id: 'historical-abstract', kind: 'abstract', title: '历史摘要', text: '原摘要快照', version: 'old', url: 'https://example.org/source' }] });
    workspace.updateData(next => {
      next.requests[old.id] = old; next.conversations[conversationId].requestIds = [old.id];
      next.conversations[conversationId].boardResearch!.excludedSourceIds = ['evidence:evidence-a'];
    });
    const id = await submitAI('research-a', conversationId, '继续解释旧回答', async () => ({ body: '对旧回答的进一步理解，仍待原文核查。', evidenceIds: [] }));
    const draftId = createManualCardDraft(id);
    const source = data().cardDrafts[draftId].source;
    expect(source.context).toEqual([]);
    expect(source.answerEvidenceIds).toEqual([]);
    expect(source.derivedFrom?.sourceIds).toContain('evidence:evidence-a');
    expect(source.materials?.find(material => material.id === 'historical-abstract')?.url).toBe('https://example.org/source');
    expect(source.derivedFrom?.requestIds).toContain(old.id);
  });
  it('模型直连实际发送背景和卡片正文，卡片内编号不能冒充本轮 PDF 原文', async () => {
    enableResearch();
    const old = oldRequest('history-materials', { context: [], evidenceIds: [], body: '旧解释', materials: [
      { id: 'allowed-history', kind: 'abstract', title: '允许的摘要', text: '历史摘要保留内容 [8]', version: '1' },
      { id: 'excluded-history', kind: 'abstract', title: '排除的摘要', text: '已排除摘要完整正文不得回流', version: '1' },
    ] });
    workspace.updateData(next => {
      next.cards['card-a'].body = '需要核查的观点 [7]';
      next.requests[old.id] = old; next.conversations[conversationId].requestIds = [old.id];
      next.conversations[conversationId].boardResearch!.excludedSourceIds = ['excluded-history'];
    });
    let messages!: { role: string; content: string }[];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/ai/config') return Response.json({ configured: true, model: 'test-model', images: false });
      messages = JSON.parse(String(init?.body)).messages;
      return new Response(`${JSON.stringify({ type: 'delta', text: '这里只能提出待核查解释。' })}\n${JSON.stringify({ type: 'done' })}\n`);
    }));
    const id = await submitAI('research-a', conversationId, '解释这个观点');
    expect(data().requests[id].status).toBe('done');
    expect(data().requests[id].context).toEqual([]);
    expect(messages[0].content).toContain('card_note');
    expect(messages[0].content).toContain('需要核查的观点');
    expect(messages[0].content).toContain('材料内引用 7，非本轮原文编号');
    expect(messages[0].content).toContain('不自行查找未附送材料');
    expect(messages[1].content).toContain('历史摘要保留内容');
    expect(messages[1].content).toContain('材料内引用 8，非本轮原文编号');
    expect(JSON.stringify(messages)).not.toContain('已排除摘要完整正文不得回流');
    expect(data().requests[old.id].materials).toHaveLength(2);
  });
});

describe('独立卡片草稿与来源', () => {
  it('仅引用第二份材料时保存原答的局部引用映射，卡片请求统一改用材料编号', async () => {
    addContext(['evidence-a', 'evidence-b']);
    const body = '论文 B 的结论 [1]';
    const requestId = await submitAI('research-a', conversationId, '解释第二份材料', async () => ({ body, evidenceIds: ['evidence-b'] }));
    const responder = vi.fn(cardResponder);
    const draftId = await generateCardDraft(requestId, body, responder);
    expect(data().cardDrafts[draftId].source).toMatchObject({
      answer: body, selection: body, answerEvidenceIds: ['evidence-b'],
    });
    const generation = responder.mock.calls[0][0];
    expect(generation.context.map(item => item.evidenceId)).toEqual(['evidence-a', 'evidence-b']);
    expect(generation.prompt).toContain('选中内容：\n论文 B 的结论 [2]');
    expect(generation.prompt).toContain('完整原始回答（辅助理解，围绕选中内容整理）：\n论文 B 的结论 [2]');
    expect(data().requests[requestId].body).toBe(body);
  });

  it('资产校验未结束时放弃草稿，不再启动模型或登记孤立的生成请求', async () => {
    const requestId = await answer();
    const requestIds = Object.keys(data().requests);
    let releaseAsset!: (blob: Blob) => void;
    vi.mocked(getAsset).mockImplementationOnce(() => new Promise(resolve => { releaseAsset = resolve; }));
    const responder = vi.fn(cardResponder);
    const pending = generateCardDraft(requestId, undefined, responder).catch(() => undefined);
    await vi.waitFor(() => expect(releaseAsset).toBeDefined());
    const draftId = Object.keys(data().cardDrafts)[0];
    expect(draftId).toBeDefined();
    discardCardDraft(draftId);
    releaseAsset(new Blob(['local PDF fixture']));
    await pending;
    expect(responder).not.toHaveBeenCalled();
    expect(Object.keys(data().requests)).toEqual(requestIds);
    expect(data().cardDrafts[draftId]).toBeUndefined();
  });

  it('AI 整理选中片段，人工修改后幂等入库，同时保留论文与原始问答来源', async () => {
    const requestId = await answer();
    const original = structuredClone(data().requests[requestId]);
    const responder = vi.fn(cardResponder);
    const draftId = await generateCardDraft(requestId, '可提炼为独立知识点。', responder);
    const draft = data().cardDrafts[draftId];
    expect(draft).toMatchObject({ status: 'editing', title: card.title, body: card.body, evidenceIds: ['evidence-b'] });
    expect(draft.source).toMatchObject({
      researchId: 'research-a', conversationId, requestId, prompt: original.prompt, answer: original.body,
      selection: '可提炼为独立知识点。', incomplete: false,
    });
    expect(draft.source.context).toEqual(original.context);
    expect(draft.source.generationRequestIds).toHaveLength(1);
    const generationId = draft.source.generationRequestIds[0];
    expect(data().requests[generationId]).toMatchObject({ purpose: 'card', draftId, status: 'done' });
    expect(responder.mock.calls[0][0].prompt).toContain('选中内容：\n可提炼为独立知识点。');
    workspace.updateData(next => { next.cardDrafts[draftId].title = '人工修改标题'; next.cardDrafts[draftId].body = '人工补充适用条件。 [1]'; next.cardDrafts[draftId].revision++; });
    const count = Object.keys(data().cards).length;
    const cardId = commitCardDraft(draftId);
    expect(commitCardDraft(draftId)).toBe(cardId);
    expect(Object.keys(data().cards)).toHaveLength(count + 1);
    expect(data().cards[cardId]).toMatchObject({ title: '人工修改标题', body: '人工补充适用条件。 [1]', provenance: draft.source });
    expect(data().researches['research-a'].cardIds.filter(id => id === cardId)).toHaveLength(1);
    expect(data().cardDrafts[draftId]).toMatchObject({ status: 'saved', cardId });
    expect(data().requests[requestId]).toEqual(original);

    workspace.associateCard('research-b', cardId);
    expect(data().researches['research-b'].documentIds).toContain('paper-b');
    expect(data().cards[cardId].provenance?.researchId).toBe('research-a');
  });

  it('生成期间的人工修改保留，迟到修订只提供建议，版本冲突禁止覆盖', async () => {
    const requestId = await answer();
    const original = structuredClone(data().requests[requestId]);
    const draftId = await generateCardDraft(requestId, undefined, cardResponder);
    workspace.updateData(next => { next.cardDrafts[draftId].body = '发送修订时的正文 [1]'; next.cardDrafts[draftId].revision++; });
    let complete!: (value: Awaited<ReturnType<AIResponder>>) => void;
    const pending = reviseCardDraft(draftId, '补充限制条件', () => new Promise(resolve => { complete = resolve; }));
    await vi.waitFor(() => expect(complete).toBeDefined());
    workspace.updateData(next => { next.cardDrafts[draftId].body = '请求过程中继续手改 [1]'; next.cardDrafts[draftId].revision++; });
    const revision = { ...card, body: '迟到的 AI 修订 [1]' };
    complete({ body: JSON.stringify(revision), evidenceIds: revision.evidenceIds, result: revision });
    await pending;
    expect(data().cardDrafts[draftId].body).toBe('请求过程中继续手改 [1]');
    expect(data().cardDrafts[draftId].suggestion?.body).toBe('迟到的 AI 修订 [1]');
    expect(() => applyCardRevision(draftId)).toThrow(/旧版本/);
    expect(data().cardDrafts[draftId].body).toBe('请求过程中继续手改 [1]');
    expect(data().requests[requestId]).toEqual(original);

    await reviseCardDraft(draftId, '按最新正文修订', cardResponder);
    expect(data().cardDrafts[draftId].body).toBe('请求过程中继续手改 [1]');
    applyCardRevision(draftId);
    expect(data().cardDrafts[draftId].body).toBe(card.body);
    undoCardRevision(draftId);
    expect(data().cardDrafts[draftId].body).toBe('请求过程中继续手改 [1]');
    expect(data().requests[requestId]).toEqual(original);
  });

  it('放弃卡片草稿不清空聊天和整理记录，也不创建卡片', async () => {
    const requestId = await answer();
    const draftId = await generateCardDraft(requestId, undefined, cardResponder);
    const requests = structuredClone(data().requests), count = Object.keys(data().cards).length;
    discardCardDraft(draftId);
    expect(data().cardDrafts[draftId]).toBeUndefined();
    expect(data().requests).toEqual(requests);
    expect(Object.keys(data().cards)).toHaveLength(count);
    expect(data().sessions['research-a'].panel.aiView).toBe('chat');
  });

  it('AI 初次整理期间继续手改草稿，返回结果不会覆盖用户内容', async () => {
    const requestId = await answer();
    let complete!: (value: Awaited<ReturnType<AIResponder>>) => void;
    const pending = generateCardDraft(requestId, undefined, () => new Promise(resolve => { complete = resolve; }));
    await vi.waitFor(() => expect(complete).toBeDefined());
    const draftId = Object.keys(data().cardDrafts)[0];
    workspace.updateData(next => { next.cardDrafts[draftId].title = '生成时手写'; next.cardDrafts[draftId].body = '保留我的文字'; next.cardDrafts[draftId].revision++; });
    complete({ body: JSON.stringify(card), evidenceIds: card.evidenceIds, result: card });
    await pending;
    expect(data().cardDrafts[draftId]).toMatchObject({ title: '生成时手写', body: '保留我的文字', status: 'editing' });
    expect(data().cardDrafts[draftId].suggestion?.body).toBe(card.body);
    expect(() => applyCardRevision(draftId)).toThrow(/旧版本/);
  });
});

describe('从显式摘录起草卡片', () => {
  it('只发送所选摘录，保留摘录来源且不改变对话材料，确认入库仍幂等', async () => {
    addContext(['evidence-a']);
    let submitted!: AIRequest;
    const draftId = await generateCardDraftFromExcerpts('research-a', ['evidence-b', 'evidence-b'], async request => {
      submitted = request;
      return cardResponder(request);
    });
    expect(submitted.context.map(item => item.evidenceId)).toEqual(['evidence-b']);
    expect(submitted.history).toEqual([]);
    expect(data().conversations[conversationId].contextIds).toContain('evidence-a');
    expect(data().conversations[conversationId].contextIds).not.toContain('evidence-b');
    expect(data().cardDrafts[draftId].source).toMatchObject({ origin: 'excerpts', answer: '', answerEvidenceIds: [] });
    expect(data().cardDrafts[draftId].source.context).toEqual(submitted.context);
    const cardId = commitCardDraft(draftId);
    expect(commitCardDraft(draftId)).toBe(cardId);
    expect(data().cards[cardId]).toMatchObject({ needsReview: true, evidenceIds: ['evidence-b'], provenance: { origin: 'excerpts' } });
  });
  it('拒绝选择范围外的引用，并保留可重试草稿', async () => {
    await expect(generateCardDraftFromExcerpts('research-a', ['evidence-a'], cardResponder)).rejects.toThrow(/引用/);
    const draft = Object.values(data().cardDrafts).find(item => item.source.origin === 'excerpts');
    expect(draft).toMatchObject({ status: 'error', evidenceIds: ['evidence-a'] });
  });
  it('切换研究后迟到结果仍归原研究，摘录中的方括号数字不重映射为对话引用', async () => {
    workspace.updateData(next => { next.evidence['evidence-b'].quote = '实验设置 [42] 应逐项核对。'; });
    const draftId = await generateCardDraftFromExcerpts('research-a', ['evidence-b'], async request => {
      expect(request.prompt).toContain('[42]');
      workspace.switchResearch('research-b');
      return cardResponder(request);
    });
    expect(data().scope).toEqual({ kind: 'research', researchId: 'research-b' });
    expect(data().cardDrafts[draftId].researchId).toBe('research-a');
    expect(data().sessions['research-a'].panel.aiDraftId).toBe(draftId);
    expect(data().sessions['research-b'].panel.aiDraftId).not.toBe(draftId);
  });
});
