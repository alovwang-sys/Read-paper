import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { getAsset, loadWorkspace, saveWorkspace } from '../../src/data/storage';
import type { AIRequest, BoardContext } from '../../src/domain/types';
import { refreshProjectConversation, selectAgent } from '../../src/services/agents';
import { demoResponder, regenerateAI, resumeNativeRuns, retryAI, stopAI, submitAI, type AIResponder } from '../../src/services/ai';
import { applyBoardProposal, captureBoardContext, createChatBoardContext } from '../../src/services/board-history';
import { boardSkillPrompt, boardSkillResult, demoBoardPlan, reparseBoardProposal } from '../../src/services/board-skill';
import { workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn(), contentHash: vi.fn() }));
vi.mock('../../src/services/project-files', () => ({ syncResearchFiles: vi.fn(async () => {}) }));
const data = () => workspace.getState().data;
const cid = 'conversation-research-a';
const frames = (text: string) => new Response([{ type: 'delta', text }, { type: 'done', model: 'fixture-model' }].map(event => JSON.stringify(event)).join('\n') + '\n');
const planFor = (context: BoardContext) => JSON.stringify(demoBoardPlan(context));
const enable = (conversationId = cid, scope: 'board' | 'research' = 'board') => workspace.updateData(next => { next.conversations[conversationId].boardSkill = { boardId: 'board-a', scope }; });

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  const seed = createSeed();
  Object.values(seed.researches).forEach(research => { research.directory = { id: `binding-${research.id}`, projectId: `project-${research.id}`, path: `/fixture/${research.id}` }; });
  vi.mocked(loadWorkspace).mockResolvedValue(seed); vi.mocked(saveWorkspace).mockResolvedValue(undefined);
  vi.mocked(getAsset).mockResolvedValue(new Blob(['fixture']));
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('内置白板 Skill 与现有聊天管道', () => {
  it('重新生成使用重新选择的补卡授权与本轮证据，空板也能重新起草', async () => {
    const boardId = 'empty-board';
    workspace.updateData(next => {
      next.boards[boardId] = { id: boardId, researchId: 'research-a', title: '空的研究图' };
      next.conversations[cid].boardSkill = { boardId, scope: 'board', allowNewCards: true };
      next.documents['paper-a'].hash = 'a'.repeat(64);
    });
    workspace.addContext({ researchId: 'research-a', conversationId: cid, evidenceIds: ['evidence-a'] });
    const id = await submitAI('research-a', cid, '补充待验证的方法', async () => ({ body: JSON.stringify({ summary: '待确认的建议', title: '空的研究图', layout: 'tree', nodes: [{ card: { title: '验证计划', body: '建议：先确定实验条件。', evidenceIds: [] }, group: '', parent: null }], edges: [] }), evidenceIds: [] }));
    workspace.updateData(next => { next.conversations[cid].boardSkill = { boardId, scope: 'board', allowNewCards: true }; });
    const pending = regenerateAI(id, 'demo'); await vi.runAllTimersAsync(); const regenerated = await pending;
    expect(data().requests[regenerated].boardContext).toMatchObject({ boardId, allowNewCards: true, allowedEvidenceIds: ['evidence-a'], resources: [] });
    expect(data().conversations[cid].boardSkill).toBeUndefined();
  });
  it('已有白板补卡只取本轮明确原文，保存前等待确认，下一轮不沿用修改目标', async () => {
    enable();
    workspace.updateData(next => { next.conversations[cid].boardSkill!.allowNewCards = true; next.documents['paper-a'].hash = 'a'.repeat(64); });
    workspace.addContext({ researchId: 'research-a', conversationId: cid, evidenceIds: ['evidence-a'] });
    const oldCards = structuredClone(data().cards), oldPlacements = structuredClone(data().placements);
    const requestId = await submitAI('research-a', cid, '在这张图补上可行的方法和评估计划', async request => {
      const context = request.boardContext!;
      expect(context.allowNewCards).toBe(true);
      expect(context.allowedEvidenceIds).toEqual(['evidence-a']);
      expect(request.context.map(c => c.evidenceId)).toEqual(['evidence-a']);
      const plan = demoBoardPlan(context);
      plan.layout = 'tree';
      plan.nodes.forEach((n, i) => { n.parent = i === 0 ? null : 0; n.order = i; });
      plan.nodes.push({ card: { title: '建议：验证计划', body: '建议：保持输入一致，比较结果并记录条件；尚未执行。', evidenceIds: [] }, group: '计划', parent: 0, order: plan.nodes.length });
      return { body: JSON.stringify(plan), evidenceIds: [] };
    });
    expect(data().requests[requestId].status).toBe('done');
    expect(data().cards).toEqual(oldCards); expect(data().placements).toEqual(oldPlacements);
    expect(data().conversations[cid].boardSkill).toBeUndefined();
    await applyBoardProposal(requestId);
    const cards = Object.values(data().cards).filter(c => !oldCards[c.id]);
    expect(cards).toHaveLength(1); expect(cards[0].needsReview).toBe(true);
    expect(cards[0].provenance?.requestId).toBe(requestId);
    for (const card of Object.values(oldCards)) expect(data().cards[card.id]).toEqual(card);
    await submitAI('research-a', cid, '说明这个建议的理由', async request => {
      expect(request.boardContext).toBeUndefined(); return { body: '普通后续讨论。', evidenceIds: [] };
    });
  });
  it('本地重新解析已完成的无标签连线回答，原文保留且不再次请求模型', async () => {
    const boardContext = createChatBoardContext(data(), 'research-a', []);
    const plan = demoBoardPlan(boardContext);
    const rawBody = JSON.stringify({ ...plan, edges: plan.edges.map(({ from, to }) => ({ from, to })) });
    workspace.updateData(next => {
      next.requests['unparsed-board'] = { id: 'unparsed-board', researchId: 'research-a', conversationId: cid, connectionId: 'codex', purpose: 'chat', prompt: '生成流程图', context: [], status: 'done', body: rawBody, rawBody, evidenceIds: [], createdAt: new Date().toISOString(), boardContext, validationError: '白板连线端点或说明无效。' };
      next.conversations[cid].requestIds.push('unparsed-board');
    });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await reparseBoardProposal('unparsed-board');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(data().requests['unparsed-board']).toMatchObject({ status: 'done', body: rawBody, rawBody, boardContext, boardProposal: { edges: plan.edges.map(({ from, to }) => ({ from, to, label: '' })) } });
    expect(data().requests['unparsed-board'].validationError).toBeUndefined();
    expect(data().boards[boardContext.boardId]).toBeDefined();
    expect(Object.values(data().boardChanges ?? {}).filter(change => change.requestId === 'unparsed-board')).toHaveLength(1);
    await expect(reparseBoardProposal('unparsed-board')).rejects.toThrow(/已完成但未解析/);
    expect(Object.values(data().boardChanges ?? {}).filter(change => change.requestId === 'unparsed-board')).toHaveLength(1);
  });

  it('重新解析仍拒绝越界材料，失败时保留完整回答与原有白板', async () => {
    const boardContext = createChatBoardContext(data(), 'research-a', []);
    const plan = demoBoardPlan(boardContext);
    plan.nodes[0].card!.evidenceIds = ['outside-evidence'];
    workspace.updateData(next => {
      next.requests['invalid-board'] = { id: 'invalid-board', researchId: 'research-a', conversationId: cid, connectionId: 'codex', prompt: '生成流程图', context: [], status: 'done', body: JSON.stringify(plan), evidenceIds: [], createdAt: new Date().toISOString(), boardContext, validationError: '白板方案无效。' };
    });
    const before = structuredClone(data());
    await expect(reparseBoardProposal('invalid-board')).rejects.toThrow();
    expect(data()).toEqual(before);
  });
  it.each(['codex', 'claude', 'opencode'] as const)('使用已选 %s 会话，用户文字和原生设置保持独立', async connection => {
    const id = selectAgent('research-a', connection); enable(id);
    workspace.updateData(next => { next.conversations[id].nativeSessionId = 'native-existing'; next.conversations[id].nativeSessionRef = 'ref-existing'; });
    const context = captureBoardContext(data(), 'research-a', 'board-a', 'board');
    const fetchMock = vi.fn(async () => frames(planFor(context))); vi.stubGlobal('fetch', fetchMock);
    const requestId = await submitAI('research-a', id, '按现有对象整理架构');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(url).toBe('/api/ai/agents/run');
    expect(sent).toMatchObject({ connectionId: connection, conversationId: id, purpose: 'chat', prompt: '按现有对象整理架构', sessionRef: 'ref-existing', boardContext: context });
    expect(sent.skillIds ?? []).not.toContain('papertrail-board');
    expect(data().requests[requestId]).toMatchObject({ status: 'done', body: demoBoardPlan(context).summary, rawBody: planFor(context), evidenceIds: [], boardProposal: demoBoardPlan(context) });
  });

  it('模型直连收到同源 Skill 与冻结快照，历史不被拼接规则污染', async () => {
    enable();
    const context = captureBoardContext(data(), 'research-a', 'board-a', 'board');
    const fetchMock = vi.fn(async (url: string) => url.endsWith('/config') ? Response.json({ configured: true, images: false, model: 'fixture' }) : frames(planFor(context)));
    vi.stubGlobal('fetch', fetchMock);
    const id = await submitAI('research-a', cid, '整理这个白板');
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent.messages[0].content).toContain(boardSkillPrompt(context));
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: '整理这个白板' });
    expect(data().requests[id].prompt).toBe('整理这个白板');
    expect(data().requests[id].boardContext).toEqual(context);
  });

  it('最终校验拒绝伪造对象或仅伪造已解析 proposal，白板保持不变', async () => {
    enable(); const before = structuredClone(data().placements);
    const id = await submitAI('research-a', cid, '整理', async request => {
      const proposal = demoBoardPlan(request.boardContext!);
      proposal.nodes[0].resourceRef!.id = 'outside-scope';
      return { body: JSON.stringify(proposal), evidenceIds: [], boardProposal: demoBoardPlan(request.boardContext!) };
    });
    expect(data().requests[id]).toMatchObject({ status: 'error' });
    expect(data().requests[id].boardProposal).toBeUndefined();
    expect(data().placements).toEqual(before);
  });

  it('无效 JSON 保留错误并允许按同一冻结范围重试', async () => {
    enable();
    const id = await submitAI('research-a', cid, '整理', async () => ({ body: '无法解析', evidenceIds: [] }));
    const snapshot = structuredClone(data().requests[id].boardContext);
    expect(data().requests[id].status).toBe('error');
    workspace.updateData(next => { next.conversations[cid].boardSkill = { boardId: 'board-a2', scope: 'research' }; next.cards['card-a'].body = '提交以后修改的正文'; });
    const pending = retryAI(id, 'demo'); await vi.runAllTimersAsync(); const retried = await pending;
    expect(data().requests[retried].boardContext).toEqual(snapshot);
    expect(data().requests[retried]).toMatchObject({ status: 'done', retryOf: id });
  });

  it('停止后忽略迟到的白板方案，切换研究也不会将结果写入新研究', async () => {
    enable(); let finish!: (value: Awaited<ReturnType<AIResponder>>) => void; let sent!: AIRequest;
    const pending = submitAI('research-a', cid, '整理', async request => { sent = request; return new Promise(resolve => { finish = resolve; }); });
    await vi.waitFor(() => expect(finish).toBeDefined());
    stopAI(sent.id); workspace.switchResearch('research-b');
    finish({ body: planFor(sent.boardContext!), evidenceIds: [] }); await pending;
    expect(data().requests[sent.id]).toMatchObject({ status: 'stopped', researchId: 'research-a' });
    expect(data().requests[sent.id].boardProposal).toBeUndefined();
  });

  it('演示、重新生成与普通问答都保留各自语义', async () => {
    enable();
    const pending = submitAI('research-a', cid, '演示整理', demoResponder); await vi.runAllTimersAsync(); const id = await pending;
    expect(data().requests[id]).toMatchObject({ status: 'done', mode: 'demo' });
    expect(data().requests[id].body).toContain('未调用真实模型');
    const revision = data().boardRevisions?.['board-a'] ?? 0;
    workspace.updateData(next => { next.placements['placement-a'].x += 20; });
    const movedX = data().placements['placement-a'].x;
    enable();
    const regen = regenerateAI(id, 'demo'); await vi.runAllTimersAsync(); const second = await regen;
    expect(data().requests[second].boardContext!.revision).toBe(revision + 1);
    expect(data().requests[second].boardContext!.snapshot.placements.find(p => p.id === 'placement-a')!.x).toBe(movedX);
    await applyBoardProposal(second);
    expect(Object.values(data().boardChanges ?? {}).some(change => change.requestId === second)).toBe(true);
    workspace.updateData(next => { next.conversations[cid].boardSkill = undefined; });
    const chat = await submitAI('research-a', cid, '普通问题', async request => {
      expect(request.boardContext).toBeUndefined(); return { body: '普通回答', evidenceIds: [] };
    });
    expect(data().requests[chat]).toMatchObject({ status: 'done', body: '普通回答' });
    expect(data().requests[chat].boardProposal).toBeUndefined();
  });

  it('明确画图在完成后创建卡片与白板，下一轮普通问答不继承动作或切换导航', async () => {
    const before = { boards: Object.keys(data().boards).length, cards: Object.keys(data().cards).length, active: structuredClone(data().sessions['research-a'].active) };
    const pending = submitAI('research-a', cid, '把讨论画成流程图', demoResponder); await vi.runAllTimersAsync(); const id = await pending;
    const request = data().requests[id], boardId = request.boardContext!.boardId;
    expect(request).toMatchObject({ status: 'done', boardContext: { intent: 'create', resources: [], allowedEvidenceIds: [] } });
    expect(data().boards[boardId]).toBeDefined();
    expect(Object.keys(data().boards)).toHaveLength(before.boards + 1);
    expect(Object.keys(data().cards)).toHaveLength(before.cards + 3);
    expect(data().sessions['research-a'].active).toEqual(before.active);
    const placements = Object.values(data().placements).filter(p => p.boardId === boardId);
    expect(placements).toHaveLength(3);
    expect(placements.every(p => data().cards[p.resourceRef.id].needsReview && data().cards[p.resourceRef.id].provenance?.requestId === id)).toBe(true);
    const next = await submitAI('research-a', cid, '这些内容的局限是什么', async request => {
      expect(request.boardContext).toBeUndefined(); return { body: '还有待补充原文证据。', evidenceIds: [] };
    });
    expect(data().requests[next].boardContext).toBeUndefined();
    expect(Object.keys(data().boards)).toHaveLength(before.boards + 1);
  });

  it('普通追问收到冻结方案的节点正文与局部引用，缩小历史后不再发送', async () => {
    const id = selectAgent('research-a', 'claude');
    workspace.updateData(next => {
      next.documents[next.evidence['evidence-a'].documentId].hash = 'a'.repeat(64);
      next.documents[next.evidence['evidence-b'].documentId].hash = 'b'.repeat(64);
      next.conversations[id].contextIds = ['evidence-a', 'evidence-b'];
    });
    let savedPlan: ReturnType<typeof demoBoardPlan>;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(init.body as string);
      if (sent.boardContext) {
        savedPlan = demoBoardPlan(sent.boardContext, sent.prompt);
        savedPlan.nodes[1].card = { title: '第二步：独立核对', body: '第二步先独立核对来源，避免重复放大误差。 [1]', evidenceIds: ['evidence-b'] };
        return frames(JSON.stringify(savedPlan));
      }
      return frames('第二步将核对过程与组织结论分开。');
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = await submitAI('research-a', id, '生成流程图');
    expect(data().requests[first].status).toBe('done');
    workspace.updateData(next => { next.conversations[id].contextIds = []; });
    await submitAI('research-a', id, '第二步为什么这样设计');
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(second.boardContext).toBeUndefined();
    const historicalPlan = JSON.parse(second.history[0].sentBody);
    expect(historicalPlan.nodes[1].card).toEqual(savedPlan!.nodes[1].card);
    expect(historicalPlan.edges).toEqual(savedPlan!.edges);
    expect(second.context.map((source: { evidenceId: string }) => source.evidenceId)).toEqual(['evidence-b']);
    expect(second.history[0].context.map((source: { evidenceId: string }) => source.evidenceId)).toEqual(['evidence-b']);
    expect(second.history[0].sentBody).not.toContain('name: papertrail-board');
    workspace.updateData(next => { next.conversations[id].historyRange = 'none'; });
    await submitAI('research-a', id, '继续普通讨论');
    const narrowed = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(narrowed.history).toEqual([]); expect(narrowed.context).toEqual([]); expect(narrowed.boardContext).toBeUndefined();
  });

  it('托管 Codex 只解析最终正文，白板后续问答沿用原线程和已发送材料', async () => {
    const id = selectAgent('research-a', 'codex');
    workspace.updateData(next => {
      next.documents[next.evidence['evidence-a'].documentId].hash = 'a'.repeat(64);
      next.conversations[id].contextIds = ['evidence-a'];
    });
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(init.body as string);
      const body = sent.boardContext ? planFor(sent.boardContext) : '第二步使用上轮方案中的分析步骤。';
      return new Response([
        { type: 'session', seq: 1, nativeSessionId: 'same-thread', nativeSessionRef: 'same-ref', nativeTurnId: sent.requestId },
        { type: 'delta', seq: 2, text: '这里是过程说明，不是最终 JSON。' },
        { type: 'done', seq: 3, body, model: 'fixture-model' },
      ].map(event => JSON.stringify(event)).join('\n') + '\n');
    });
    vi.stubGlobal('fetch', mock);
    const first = await submitAI('research-a', id, '生成流程图');
    const saved = data().requests[first];
    expect(saved).toMatchObject({ status: 'done', nativeRun: { managed: true, state: 'completed' }, boardProposal: { nodes: expect.any(Array) } });
    expect(saved.validationError).toBeUndefined();
    expect(saved.rawBody).toBe(planFor(saved.boardContext!));
    expect(data().boards[saved.boardContext!.boardId]).toBeDefined();
    workspace.updateData(next => { next.conversations[id].contextIds = []; });
    await submitAI('research-a', id, '第二步为什么这样设计');
    const second = JSON.parse(mock.mock.calls[1][1].body as string);
    expect(second).toMatchObject({ managed: true, reset: false, sessionRef: 'same-ref', history: [] });
    expect(second.boardContext).toBeUndefined();
    expect(second.context.map((source: { evidenceId: string }) => source.evidenceId)).toEqual(['evidence-a']);
    expect(data().conversations[id].nativeSessionId).toBe('same-thread');
  });

  it.each(['completed', 'interrupted', 'failed', 'invalid'] as const)('恢复托管白板回合只在有效完成时保存：%s', async state => {
    const id = selectAgent('research-a', 'codex'), boardContext = createChatBoardContext(data(), 'research-a', []);
    const requestId = 'restored-board';
    workspace.updateData(next => {
      next.conversations[id].requestIds.push(requestId);
      next.requests[requestId] = { id: requestId, researchId: 'research-a', conversationId: id, connectionId: 'codex', purpose: 'chat', prompt: '生成流程图', context: [], history: [], status: 'generating', body: '', evidenceIds: [], createdAt: new Date().toISOString(), boardContext,
        nativeRun: { managed: true, cursor: 2, delivery: 'accepted', state: 'unknown', transport: 'offline', items: [] } };
    });
    const mock = vi.fn(async () => new Response(JSON.stringify({ type: 'snapshot', seq: 3,
      state: state === 'invalid' ? 'completed' : state, body: state === 'invalid' ? '无效 JSON' : planFor(boardContext), nativeSessionId: 'same-thread' }) + '\n'));
    vi.stubGlobal('fetch', mock);
    await resumeNativeRuns(requestId);
    expect(mock.mock.calls).toHaveLength(1);
    expect((mock.mock.calls[0] as unknown as [string])[0]).toBe('/api/ai/agents/observe');
    if (state === 'completed') {
      expect(data().requests[requestId].boardProposal).toBeDefined();
      expect(data().boards[boardContext.boardId]).toBeDefined();
      await resumeNativeRuns(requestId);
      expect(Object.values(data().boardChanges ?? {}).filter(change => change.requestId === requestId)).toHaveLength(1);
    } else {
      expect(data().requests[requestId].boardProposal).toBeUndefined();
      expect(data().boards[boardContext.boardId]).toBeUndefined();
      if (state === 'invalid') expect(data().requests[requestId].validationError).toBeTruthy();
    }
  });

  it.each(['completed', 'interrupted', 'truncated'] as const)('原生历史回读也校验白板并保持终态限制：%s', async result => {
    const id = selectAgent('research-a', 'codex'), boardContext = createChatBoardContext(data(), 'research-a', []);
    const requestId = 'history-board', rawBody = planFor(boardContext);
    workspace.updateData(next => {
      Object.assign(next.conversations[id], { nativeSessionId: 'same-thread', nativeSessionRef: 'same-ref', requestIds: [requestId] });
      next.requests[requestId] = { id: requestId, researchId: 'research-a', conversationId: id, connectionId: 'codex', purpose: 'chat', prompt: '生成流程图', context: [], history: [], status: 'generating', body: '', evidenceIds: [], createdAt: new Date().toISOString(), boardContext, nativeSessionId: 'same-thread', nativeTurnId: 'same-turn',
        nativeRun: { managed: true, cursor: 2, delivery: 'accepted', state: 'unknown', transport: 'offline', items: [] } };
    });
    const turnStatus = result === 'interrupted' ? 'interrupted' : 'completed';
    const mock = vi.fn(async () => Response.json({ id: 'same-ref', agentId: 'codex', nativeSessionId: 'same-thread', state: 'idle', canResume: true, title: '原生记录', messages: [
      { id: 'user', role: 'user', text: '生成流程图', requestId, turnId: 'same-turn', turnStatus, answerComplete: result !== 'truncated' },
      { id: 'answer', role: 'assistant', text: '过程说明', turnId: 'same-turn', turnStatus, answerComplete: result !== 'truncated', items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', status: 'done', text: rawBody }] },
    ] }));
    vi.stubGlobal('fetch', mock);
    await refreshProjectConversation('research-a', id);
    expect((mock.mock.calls[0] as unknown as [string])[0]).toBe('/api/ai/agents/projects/read');
    if (result === 'completed') {
      expect(data().requests[requestId]).toMatchObject({ status: 'done', rawBody, body: demoBoardPlan(boardContext).summary, boardProposal: demoBoardPlan(boardContext) });
      expect(data().boards[boardContext.boardId]).toBeDefined();
    } else {
      expect(data().requests[requestId].boardProposal).toBeUndefined();
      expect(data().boards[boardContext.boardId]).toBeUndefined();
      expect(data().requests[requestId].status).toBe(result === 'interrupted' ? 'stopped' : 'generating');
    }
  });

  it('按钮可单次创建，显式none可覆盖检测与旧目标；旧目标只消费一次', async () => {
    enable();
    const plain = await submitAI('research-a', cid, '生成架构图', async request => {
      expect(request.boardContext).toBeUndefined(); return { body: '仍按普通问题回答', evidenceIds: [] };
    }, { board: 'none' });
    expect(data().requests[plain].boardProposal).toBeUndefined();
    expect(data().conversations[cid].boardSkill).toBeUndefined();
    const pending = submitAI('research-a', cid, '只解释当前内容', demoResponder, { board: 'create' }); await vi.runAllTimersAsync(); const created = await pending;
    expect(data().requests[created].boardContext?.intent).toBe('create');
    expect(data().boards[data().requests[created].boardContext!.boardId]).toBeDefined();
  });

  it('最新明确新建请求覆盖已选择的旧白板目标', async () => {
    enable(); const old = structuredClone(data().boards['board-a']), placements = structuredClone(data().placements);
    const pending = submitAI('research-a', cid, '生成一张新白板', demoResponder); await vi.runAllTimersAsync(); const id = await pending;
    expect(data().requests[id].boardContext?.intent).toBe('create');
    expect(data().requests[id].boardContext?.boardId).not.toBe('board-a');
    expect(data().boards['board-a']).toEqual(old);
    for (const [id, placement] of Object.entries(placements)) expect(data().placements[id]).toEqual(placement);
  });

  it.each(['不要整理白板，只解释流程', '请检查这句话有没有语病：生成一张流程图', 'Please translate: draw a flowchart', 'I already created a whiteboard', 'I will create a whiteboard later', '我已经画好了流程图'])('非执行主句覆盖已选择旧目标：%s', async prompt => {
    enable(); const boards = structuredClone(data().boards), placements = structuredClone(data().placements);
    const id = await submitAI('research-a', cid, prompt, async request => {
      expect(request.boardContext).toBeUndefined(); return { body: '仅按本轮问题回答。', evidenceIds: [] };
    });
    expect(data().requests[id].boardProposal).toBeUndefined();
    expect(data().boards).toEqual(boards); expect(data().placements).toEqual(placements);
    expect(data().conversations[cid].boardSkill).toBeUndefined();
  });

  it('没有明确目标的编辑请求报错，不猜测当前研究的白板', async () => {
    const responder = vi.fn();
    await expect(submitAI('research-a', cid, '调整当前白板的布局', responder)).rejects.toThrow('选择要修改的白板');
    expect(responder).not.toHaveBeenCalled();
    expect(data().conversations[cid].requestIds).toEqual([]);
  });

  it('新建失败或停止不留空白板，重试保持同一未应用目标', async () => {
    const before = Object.keys(data().boards);
    const id = await submitAI('research-a', cid, '生成一张架构图', async () => ({ body: '无效方案', evidenceIds: [] }));
    expect(data().requests[id].status).toBe('error'); expect(Object.keys(data().boards)).toEqual(before);
    const target = data().requests[id].boardContext!.boardId;
    const retried = retryAI(id, 'demo'); await vi.runAllTimersAsync(); const retryId = await retried;
    expect(data().requests[retryId].boardContext!.boardId).toBe(target); expect(data().boards[target]).toBeDefined();
    let finish!: (value: Awaited<ReturnType<AIResponder>>) => void; let sent!: AIRequest;
    const stopped = submitAI('research-a', cid, '再生成一张流程图', async request => { sent = request; return new Promise(resolve => { finish = resolve; }); });
    await vi.waitFor(() => expect(finish).toBeDefined()); stopAI(sent.id);
    finish({ body: JSON.stringify(demoBoardPlan(sent.boardContext!)), evidenceIds: [] }); await stopped;
    expect(data().requests[sent.id].status).toBe('stopped'); expect(data().boards[sent.boardContext!.boardId]).toBeUndefined();
  });

  it('新建方案重新生成使用新的目标，已创建白板不被覆盖', async () => {
    const first = submitAI('research-a', cid, '生成架构图', demoResponder); await vi.runAllTimersAsync(); const id = await first;
    const oldBoardId = data().requests[id].boardContext!.boardId, oldBoard = structuredClone(data().boards[oldBoardId]);
    const pending = regenerateAI(id, 'demo'); await vi.runAllTimersAsync(); const next = await pending;
    expect(data().requests[next].boardContext!.boardId).not.toBe(oldBoardId);
    expect(data().boards[oldBoardId]).toEqual(oldBoard);
    expect(data().boards[data().requests[next].boardContext!.boardId]).toBeDefined();
  });

  it('切换研究后的迟到成功结果保存在原研究，不改变当前导航', async () => {
    let finish!: (value: Awaited<ReturnType<AIResponder>>) => void; let sent!: AIRequest;
    const pending = submitAI('research-a', cid, '生成流程图', async request => { sent = request; return new Promise(resolve => { finish = resolve; }); });
    await vi.waitFor(() => expect(finish).toBeDefined());
    workspace.switchResearch('research-b'); const active = structuredClone(data().sessions['research-b'].active);
    finish({ body: JSON.stringify(demoBoardPlan(sent.boardContext!)), evidenceIds: [] }); await pending;
    expect(data().requests[sent.id].status).toBe('done');
    expect(data().boards[sent.boardContext!.boardId].researchId).toBe('research-a');
    expect(data().scope).toEqual({ kind: 'research', researchId: 'research-b' });
    expect(data().sessions['research-b'].active).toEqual(active);
  });

  it('保存失败保留完成方案和独立错误，重试保存不再创建一份', async () => {
    vi.mocked(saveWorkspace).mockRejectedValue(new Error('disk-full'));
    const pending = submitAI('research-a', cid, '生成架构图', demoResponder); await vi.runAllTimersAsync(); const id = await pending;
    expect(data().requests[id]).toMatchObject({ status: 'done', boardApplyError: expect.stringContaining('disk-full') });
    const before = Object.keys(data().boards), count = Object.keys(data().cards).length;
    vi.mocked(saveWorkspace).mockResolvedValue(undefined);
    await applyBoardProposal(id);
    expect(data().requests[id].boardApplyError).toBeUndefined();
    expect(Object.keys(data().boards)).toEqual(before); expect(Object.keys(data().cards)).toHaveLength(count);
  });

  it('编辑方案要移出已有节点时保留预览，等待确认', async () => {
    enable(); const before = structuredClone(data().placements);
    const id = await submitAI('research-a', cid, '移出部分节点', async request => {
      const plan = demoBoardPlan(request.boardContext!); plan.nodes = plan.nodes.slice(0, 1); plan.edges = [];
      return { body: JSON.stringify(plan), evidenceIds: [] };
    });
    expect(data().requests[id]).toMatchObject({ status: 'done' });
    expect(data().requests[id].boardProposal).toBeDefined();
    expect(data().placements).toEqual(before);
    expect(Object.values(data().boardChanges ?? {}).some(change => change.requestId === id)).toBe(false);
    expect(data().conversations[cid].boardSkill).toBeUndefined();
  });

  it('重新生成要求仍显式选择原白板，不会静默切换目标或继续已停用技能', async () => {
    enable();
    const pending = submitAI('research-a', cid, '演示整理', demoResponder); await vi.runAllTimersAsync(); const id = await pending;
    workspace.updateData(next => { next.conversations[cid].boardSkill = { boardId: 'board-a2', scope: 'research' }; });
    await expect(regenerateAI(id, 'demo')).rejects.toThrow('原目标');
    workspace.updateData(next => { next.conversations[cid].boardSkill = undefined; });
    await expect(regenerateAI(id, 'demo')).rejects.toThrow('原目标');
    expect(data().conversations[cid].requestIds).toEqual([id]);
  });

  it('JSON 数组索引不经过论文编号映射', () => {
    const context = captureBoardContext(data(), 'research-a', 'board-a', 'board');
    const plan = demoBoardPlan(context); plan.summary = '分组 [1] 为输入，分组 [2] 为输出';
    expect(boardSkillResult(JSON.stringify(plan), context)).toMatchObject({ body: plan.summary, evidenceIds: [], boardProposal: plan });
  });
});
