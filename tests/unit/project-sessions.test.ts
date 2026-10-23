import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasFullText } from '../../src/domain/knowledge';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { getAsset, loadWorkspace, saveMigrationBackup, saveWorkspace } from '../../src/data/storage';
import type { AIRequest, ContextSnapshot, NativeSessionSnapshot, NativeSessionSummary } from '../../src/domain/types';
import { bindResearchDirectory, getResearchDirectory, listProjectSessions, loadOlderProjectConversation, openProjectSession, previewResearchDirectory, refreshProjectConversation } from '../../src/services/agents';
import { createManualCardDraft, regenerateAI, retryAI } from '../../src/services/ai';
import { workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn(), contentHash: vi.fn() }));
const data = () => workspace.getState().data;
const directory = { id: 'binding-a', projectId: 'project-a', path: '/fixture/research-a' };
const summary = (overrides: Partial<NativeSessionSummary> = {}): NativeSessionSummary => ({ id: 'opaque-session-ref', agentId: 'codex', nativeSessionId: 'native-thread', title: 'Native discussion', updatedAt: '2026-10-17T01:00:00.000Z', state: 'unknown', canResume: true, origin: 'native', ...overrides });
const snapshot = (overrides: Partial<NativeSessionSnapshot> = {}): NativeSessionSnapshot => ({ ...summary(), state: 'idle', messages: [{ id: 'native-user-1', role: 'user', text: 'What does this claim mean?', createdAt: '2026-10-17T00:59:00.000Z' }, { id: 'native-answer-1', role: 'assistant', text: 'An external answer cites [1], but its source is not associated.' }], ...overrides });
const mockSnapshot = (value: NativeSessionSnapshot) => { const mock = vi.fn(async () => Response.json(value)); vi.stubGlobal('fetch', mock); return mock; };
function source(): ContextSnapshot {
  const evidence = data().evidence['evidence-a']; const document = data().documents[evidence.documentId];
  return { evidenceId: evidence.id, documentId: document.id, documentHash: document.hash!, title: document.title, pageIndex: evidence.pageIndex, quote: evidence.quote };
}
function ownRequest(conversationId: string): AIRequest {
  return { id: 'own-request', researchId: 'research-a', conversationId, prompt: 'Original app question', body: 'Original app answer [1]', status: 'done', purpose: 'chat', connectionId: 'codex', mode: 'live', context: [source()], evidenceIds: ['evidence-a'], history: [], createdAt: '2026-10-17T00:00:00.000Z' };
}

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined); vi.mocked(saveMigrationBackup).mockReset().mockResolvedValue(undefined); vi.mocked(getAsset).mockReset().mockResolvedValue(new Blob(['fixture']));
  const seed = createSeed(); seed.agentWorkspaceId = 'workspace-existing';
  seed.researches['research-a'].directory = directory;
  Object.values(seed.documents).filter(hasFullText).forEach(document => { document.hash = 'a'.repeat(64); });
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(seed);
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('研究项目原生历史的公开服务路径', () => {
  it('已删除原生会话不能从发现重新打开，刷新和分页不读取；显式恢复才允许继续', async () => {
    const mock = mockSnapshot(snapshot({ nextCursor: 'older-page' }));
    const id = await openProjectSession('research-a', summary());
    const requestId = data().conversations[id].requestIds[0];
    const draftId = createManualCardDraft(requestId);
    workspace.updateData(next => { next.conversations[id].input = '删除后仍保留的原生草稿'; });
    workspace.deleteConversation(id);
    const deleted = structuredClone(data().conversations[id]);
    const requests = structuredClone(data().requests), draft = structuredClone(data().cardDrafts[draftId]);
    const activeId = data().sessions['research-a'].activeConversationId;
    mock.mockClear();

    await refreshProjectConversation('research-a', id);
    await loadOlderProjectConversation('research-a', id);
    expect(mock).not.toHaveBeenCalled();
    await expect(openProjectSession('research-a', summary())).rejects.toThrow(/已在本应用中删除/);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(data().conversations[id]).toEqual(deleted);
    expect(data().requests).toEqual(requests);
    expect(data().cardDrafts[draftId]).toEqual(draft);
    expect(data().sessions['research-a'].activeConversationId).toBe(activeId);
    expect(Object.values(data().conversations).filter(item => item.nativeSessionId === 'native-thread')).toHaveLength(1);

    workspace.restoreDeletedConversation(id);
    expect(await openProjectSession('research-a', summary())).toBe(id);
    expect(data().conversations[id]).toMatchObject({ archived: false, input: '删除后仍保留的原生草稿' });
    expect(data().conversations[id].deletedAt).toBeUndefined();
    expect(data().requests[requestId]).toEqual(requests[requestId]);
    expect(data().cardDrafts[draftId]).toEqual(draft);
  });

  it.each(['open', 'refresh', 'older'] as const)('原生%s读取等待期间删除会话，迟到的正文和新消息不能改写墓碑或来源', async operation => {
    mockSnapshot(snapshot({ nextCursor: 'older-page' }));
    const id = await openProjectSession('research-a', summary());
    workspace.addContext({ researchId: 'research-a', conversationId: id, evidenceIds: ['evidence-a'] });
    workspace.updateData(next => { next.conversations[id].input = '读取中继续写下的私有草稿'; });
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const pending = operation === 'open' ? openProjectSession('research-a', summary())
      : operation === 'refresh' ? refreshProjectConversation('research-a', id) : loadOlderProjectConversation('research-a', id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    workspace.deleteConversation(id);
    const deleted = structuredClone(data().conversations[id]);
    const requests = structuredClone(data().requests), evidence = structuredClone(data().evidence);
    const activeId = data().sessions['research-a'].activeConversationId;
    release(Response.json(snapshot({ title: '不能复活的原生标题', updatedAt: '2026-10-23T12:00:00.000Z', messages: [
      ...snapshot().messages,
      { id: 'late-native-user', role: 'user', text: '删除之后迟到的新问题', turnId: 'late-turn', turnStatus: 'completed' },
      { id: 'late-native-answer', role: 'assistant', text: '不能写入的新回答', turnId: 'late-turn', turnStatus: 'completed' },
    ] })));
    await expect(pending).rejects.toThrow(/已在本应用中删除/);
    expect(data().conversations[id]).toEqual(deleted);
    expect(data().requests).toEqual(requests);
    expect(data().evidence).toEqual(evidence);
    expect(data().sessions['research-a'].activeConversationId).toBe(activeId);
    expect(Object.values(data().conversations).filter(item => item.nativeSessionId === 'native-thread')).toHaveLength(1);
  });

  it('截断的原生预览不能覆盖较长的已接收正文或冻结为完整回答', async () => {
    mockSnapshot(snapshot({ messages: [] }));
    const id = await openProjectSession('research-a', summary());
    const partial = '本地已收到的长正文。'.repeat(8000);
    workspace.updateData(next => {
      next.requests['own-request'] = { ...ownRequest(id), body: partial, status: 'generating', nativeSessionId: 'native-thread', nativeTurnId: 'turn-long',
        nativeRun: { managed: true, cursor: 7, delivery: 'accepted', state: 'unknown', transport: 'offline', turnId: 'turn-long', items: [] } };
      next.conversations[id].requestIds = ['own-request'];
    });
    mockSnapshot(snapshot({ truncated: true, messages: [
      { id: 'u-own', role: 'user', text: 'Original app question', requestId: 'own-request', turnId: 'turn-long', turnStatus: 'completed', answerComplete: false },
      { id: 'a-own', role: 'assistant', text: partial.slice(0, 60000), contentComplete: false, turnId: 'turn-long', turnStatus: 'completed', answerComplete: false },
    ] }));
    await refreshProjectConversation('research-a', id);
    expect(data().requests['own-request']).toMatchObject({ body: partial, status: 'generating', nativeRun: { state: 'unknown' } });
    // An incomplete progress preview does not invalidate a separately complete final answer.
    mockSnapshot(snapshot({ truncated: true, messages: [
      { id: 'u-own', role: 'user', text: 'Original app question', requestId: 'own-request', turnId: 'turn-long', turnStatus: 'completed', answerComplete: true, items: [
        { id: 'progress', type: 'agentMessage', status: 'done', phase: 'commentary', text: '省略的长进展', contentComplete: false },
        { id: 'final', type: 'agentMessage', status: 'done', phase: 'final_answer', text: '完整的最终回答', contentComplete: true },
      ] },
      { id: 'a-progress', role: 'assistant', text: '进展预览', contentComplete: false, turnId: 'turn-long', turnStatus: 'completed', answerComplete: true },
      { id: 'a-final', role: 'assistant', text: '完整的最终回答', contentComplete: true, turnId: 'turn-long', turnStatus: 'completed', answerComplete: true },
    ] }));
    await refreshProjectConversation('research-a', id);
    expect(data().requests['own-request']).toMatchObject({ body: '完整的最终回答', status: 'done' });
  });

  it('运行中补充属于同一个原生回合，完成后只补确认信息且保留后来写下的草稿', async () => {
    mockSnapshot(snapshot({ messages: [] }));
    const id = await openProjectSession('research-a', summary());
    workspace.updateData(next => {
      next.requests['own-request'] = { ...ownRequest(id), nativeSessionId: 'native-thread', nativeTurnId: 'turn-own',
        nativeRun: { managed: true, cursor: 7, delivery: 'accepted', state: 'completed', transport: 'connected', turnId: 'turn-own', items: [],
          pendingSteer: { id: 'input-own', text: '补充研究条件', createdAt: '2026-10-17T00:01:00.000Z' } } };
      next.conversations[id].requestIds = ['own-request'];
      next.conversations[id].input = '后来写下的下一问';
    });
    mockSnapshot(snapshot({ messages: [
      { id: 'u-own', role: 'user', text: 'Original app question', requestId: 'own-request', turnId: 'turn-own', turnStatus: 'completed' },
      { id: 'a-progress', role: 'assistant', text: '执行中的进展', turnId: 'turn-own', turnStatus: 'completed' },
      { id: 'u-steer', role: 'user', clientUserMessageId: 'input-own', text: '补充研究条件', turnId: 'turn-own', turnStatus: 'completed' },
      { id: 'a-final', role: 'assistant', text: '不能覆盖已保存的原答', turnId: 'turn-own', turnStatus: 'completed' },
    ] }));
    await refreshProjectConversation('research-a', id);
    await refreshProjectConversation('research-a', id);
    expect(data().conversations[id].requestIds).toEqual(['own-request']);
    expect(data().conversations[id].input).toBe('后来写下的下一问');
    expect(data().requests['own-request']).toMatchObject({ body: 'Original app answer [1]', status: 'done',
      supplementalInputs: [{ id: 'input-own', text: '补充研究条件' }] });
    expect(data().requests['own-request'].nativeRun?.pendingSteer).toBeUndefined();
  });

  it('较早分页按时间插入且稳定去重，读取游标不改变已载入的最新问答', async () => {
    const mock = mockSnapshot(snapshot({ nextCursor: 'older-page', messages: [
      { id: 'u-new', role: 'user', text: '最新问题', createdAt: '2026-10-17T01:00:00.000Z', turnId: 'new-turn', turnStatus: 'completed' },
      { id: 'a-new', role: 'assistant', text: '最新回答', turnId: 'new-turn', turnStatus: 'completed' },
    ] }));
    const id = await openProjectSession('research-a', summary());
    mock.mockImplementation(async () => Response.json(snapshot({ messages: [
      { id: 'u-old', role: 'user', text: '较早问题', createdAt: '2026-10-17T00:00:00.000Z', turnId: 'old-turn', turnStatus: 'completed' },
      { id: 'a-old', role: 'assistant', text: '较早回答', turnId: 'old-turn', turnStatus: 'completed' },
    ] })));
    await loadOlderProjectConversation('research-a', id);
    expect(JSON.parse((mock.mock.calls as unknown as [string, RequestInit][])[1][1].body as string).cursor).toBe('older-page');
    expect(data().conversations[id].requestIds.map(key => data().requests[key].prompt)).toEqual(['较早问题', '最新问题']);
    await loadOlderProjectConversation('research-a', id);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(data().conversations[id].nativeHistoryCursor).toBeUndefined();
  });

  it('原生回合仍在执行时显示生成中，并持续刷新同一条记录直至完成', async () => {
    const mock = mockSnapshot(snapshot({ state: 'busy', canResume: false, messages: [
      { id: 'u', role: 'user', text: '查证', turnId: 'turn-live', turnStatus: 'inProgress' },
      { id: 'a', role: 'assistant', text: '正在读取材料', turnId: 'turn-live', turnStatus: 'inProgress' },
    ] }));
    const id = await openProjectSession('research-a', summary());
    const request = data().requests[data().conversations[id].requestIds[0]];
    expect(request.status).toBe('generating');
    expect(request.error).toBeUndefined();
    expect(request.nativeTurnId).toBe('turn-live');
    mock.mockImplementation(async () => Response.json(snapshot({ state: 'busy', canResume: false, messages: [
      { id: 'u', role: 'user', text: '查证', turnId: 'turn-live', turnStatus: 'inProgress' },
      { id: 'a', role: 'assistant', text: '正在核对第二份材料', turnId: 'turn-live', turnStatus: 'inProgress' },
    ] })));
    await refreshProjectConversation('research-a', id);
    expect(data().requests[request.id]).toMatchObject({ status: 'generating', body: '正在核对第二份材料' });
    mock.mockImplementation(async () => Response.json(snapshot({ state: 'idle', canResume: true, messages: [
      { id: 'u', role: 'user', text: '查证', turnId: 'turn-live', turnStatus: 'completed' },
      { id: 'a', role: 'assistant', text: '核对完成', turnId: 'turn-live', turnStatus: 'completed' },
    ] })));
    await refreshProjectConversation('research-a', id);
    expect(data().conversations[id].requestIds).toEqual([request.id]);
    expect(data().requests[request.id]).toMatchObject({ status: 'done', body: '核对完成' });
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['interrupted', undefined, 'stopped', '本轮已中断'],
    ['failed', undefined, 'error', '原生回合执行失败'],
    ['completed', false, 'interrupted', '预览'],
    [undefined, false, 'interrupted', '预览'],
    [undefined, undefined, 'interrupted', '尚未确认'],
  ] as const)('导入原生状态 %s / 完整性 %s 时如实保留结束与核对信息', async (turnStatus, answerComplete, status, message) => {
    mockSnapshot(snapshot({ state: turnStatus === 'failed' || turnStatus === 'interrupted' ? 'idle' : 'unknown', messages: [
      { id: 'u', role: 'user', text: '原生问题', turnId: 'native-turn', turnStatus, answerComplete },
      { id: 'a', role: 'assistant', text: '已有内容', turnId: 'native-turn', turnStatus, answerComplete },
    ] }));
    const id = await openProjectSession('research-a', summary());
    expect(data().requests[data().conversations[id].requestIds[0]]).toMatchObject({ status, error: expect.stringContaining(message), body: '已有内容' });
  });

  it('同一原生回合可补齐托管中断记录，完成后的原始回答继续不可改写', async () => {
    mockSnapshot(snapshot({ messages: [] }));
    const id = await openProjectSession('research-a', summary());
    workspace.updateData(next => {
      next.requests['own-request'] = { ...ownRequest(id), status: 'interrupted', body: '半截回答', nativeSessionId: 'native-thread', nativeTurnId: 'turn-own',
        nativeRun: { managed: true, cursor: 7, delivery: 'accepted', state: 'unknown', transport: 'offline', turnId: 'turn-own', items: [] } };
      next.conversations[id].requestIds = ['own-request'];
    });
    const messages: NativeSessionSnapshot['messages'] = [
      { id: 'u-own', role: 'user', text: 'Original app question', requestId: 'own-request', turnId: 'turn-own', turnStatus: 'completed' },
      { id: 'a-own', role: 'assistant', text: '完整回答 [1]', turnId: 'turn-own', turnStatus: 'completed' },
    ];
    mockSnapshot(snapshot({ state: 'idle', messages }));
    await refreshProjectConversation('research-a', id);
    expect(data().requests['own-request']).toMatchObject({ body: '完整回答 [1]', status: 'done', evidenceIds: ['evidence-a'], nativeRun: { state: 'completed' } });
    expect(() => workspace.updateData(next => { next.requests['own-request'].body = '改写来源'; }, { nativeRunRef: 'own-request' })).toThrow('原始问答不可改写');
    mockSnapshot(snapshot({ state: 'idle', messages: messages.map(message => message.role === 'assistant' ? { ...message, text: '不同回答' } : message) }));
    await refreshProjectConversation('research-a', id);
    expect(data().requests['own-request'].body).toBe('完整回答 [1]');
  });

  it('重复读取按原生身份复用会话，保留输入、材料、技能及本地编辑标题', async () => {
    const mock = mockSnapshot(snapshot());
    const id = await openProjectSession('research-a', summary());
    workspace.addContext({ researchId: 'research-a', conversationId: id, evidenceIds: ['evidence-a'] });
    workspace.renameConversation(id, 'My research wording');
    const skill = { id: 'skill-local', name: 'Research guidance', description: 'Local instructions', enabled: true };
    workspace.updateData(next => { const conversation = next.conversations[id]; conversation.input = 'A question I have not sent'; conversation.skills = [skill]; conversation.codex = { model: 'chosen-model', mode: 'plan' }; conversation.scrollTop = 240; conversation.historyRange = 'latest'; });
    const before = structuredClone(data().conversations[id]);
    await refreshProjectConversation('research-a', id); await refreshProjectConversation('research-a', id);
    expect(data().conversations[id]).toEqual(before);
    expect(Object.values(data().conversations).filter(c => c.nativeSessionId === 'native-thread')).toHaveLength(1);
    expect(data().conversations[id].requestIds).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('已有requestId的自有提交不会重复导入，也不覆盖本软件原答或证据', async () => {
    const id = workspace.getActiveConversation('research-a').id;
    workspace.updateData(next => { const conversation = next.conversations[id]; conversation.connectionId = 'codex'; conversation.nativeSessionId = 'native-thread'; conversation.nativeSessionRef = 'opaque-session-ref'; const request = ownRequest(id); next.requests[request.id] = request; conversation.requestIds = [request.id]; });
    const original = structuredClone(data().requests['own-request']);
    mockSnapshot(snapshot({ messages: [{ id: 'native-own-user', role: 'user', text: original.prompt, requestId: 'own-request' }, { id: 'native-own-answer', role: 'assistant', text: 'Server-side version of the same answer' }] }));
    await refreshProjectConversation('research-a', id);
    expect(data().conversations[id].requestIds).toEqual(['own-request']); expect(data().requests['own-request']).toEqual(original);
  });

  it('刷新清除旧版长材料包装造成的重复聊天，保留原问答与来源存档', async () => {
    const id = workspace.getActiveConversation('research-a').id;
    workspace.updateData(next => {
      const conversation = next.conversations[id], original = ownRequest(id);
      Object.assign(conversation, { connectionId: 'codex', nativeSessionId: 'native-thread', nativeSessionRef: 'opaque-session-ref', requestIds: [original.id, 'polluted-import'] });
      next.requests[original.id] = original;
      next.requests['polluted-import'] = { ...original, id: 'polluted-import', nativeImported: true, nativeMessageId: 'native-own-user', prompt: '[Read-paper requestId=own-request]\n被截断的原文与历史材料' };
    });
    const original = structuredClone(data().requests['own-request']);
    mockSnapshot(snapshot({ messages: [{ id: 'native-own-user', role: 'user', text: original.prompt, requestId: original.id }, { id: 'native-own-answer', role: 'assistant', text: original.body }] }));
    await refreshProjectConversation('research-a', id);
    await refreshProjectConversation('research-a', id);
    expect(data().conversations[id].requestIds).toEqual([original.id]);
    expect(data().requests[original.id]).toEqual(original);
    expect(data().requests['polluted-import']).toBeDefined();
  });

  it('新增原生消息按稳定ID归并，外部引用保持可读而不会伪造本研究证据', async () => {
    const mock = mockSnapshot(snapshot()); const originalEvidence = structuredClone(data().evidence);
    const id = await openProjectSession('research-a', summary()); const first = data().conversations[id].requestIds[0];
    const expanded = snapshot({ updatedAt: '2026-10-17T01:05:00.000Z', messages: [...snapshot().messages, { id: 'native-user-2', role: 'user', text: 'A follow-up from the native client' }, { id: 'native-answer-2', role: 'assistant', text: 'The follow-up answer [99].' }] });
    mock.mockImplementation(async () => Response.json(expanded));
    await refreshProjectConversation('research-a', id); const ids = [...data().conversations[id].requestIds]; await refreshProjectConversation('research-a', id);
    expect(data().conversations[id].requestIds).toEqual(ids); expect(ids).toHaveLength(2); expect(ids[0]).toBe(first);
    expect(data().requests[ids[1]]).toMatchObject({ nativeImported: true, nativeMessageId: 'native-user-2', body: 'The follow-up answer [99].', context: [], evidenceIds: [] });
    expect(data().evidence).toEqual(originalEvidence);
  });

  it('同一原生消息后续补全更新显示缓存，并保留同一个导入身份', async () => {
    const mock = mockSnapshot(snapshot({ messages: [{ id: 'native-user-1', role: 'user', text: 'Native question' }, { id: 'native-answer-1', role: 'assistant', text: 'The first part' }] }));
    const id = await openProjectSession('research-a', summary()); const requestId = data().conversations[id].requestIds[0];
    mock.mockImplementation(async () => Response.json(snapshot({ messages: [{ id: 'native-user-1', role: 'user', text: 'Native question' }, { id: 'native-answer-1', role: 'assistant', text: 'The first part and the completed answer.' }] })));
    await refreshProjectConversation('research-a', id);
    expect(data().conversations[id].requestIds).toEqual([requestId]);
    expect(data().requests[requestId].body).toBe('The first part and the completed answer.');
  });

  it('刷新原生显示缓存不会改变已经保存的独立卡片来源快照', async () => {
    const mock = mockSnapshot(snapshot()); const id = await openProjectSession('research-a', summary());
    const requestId = data().conversations[id].requestIds[0]; const draftId = createManualCardDraft(requestId);
    const before = structuredClone(data().cardDrafts[draftId]);
    mock.mockImplementation(async () => Response.json(snapshot({ messages: [{ id: 'native-user-1', role: 'user', text: 'What does this claim mean?' }, { id: 'native-answer-1', role: 'assistant', text: 'The source client has appended more explanation.' }] })));
    await refreshProjectConversation('research-a', id);
    expect(data().requests[requestId].body).toBe('The source client has appended more explanation.');
    expect(data().cardDrafts[draftId]).toEqual(before);
  });

  it('较早发起但迟到的读取不能回滚已收到的较新原生历史', async () => {
    mockSnapshot(snapshot()); const id = await openProjectSession('research-a', summary());
    const replies: ((response: Response) => void)[] = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { replies.push(resolve); })));
    const older = refreshProjectConversation('research-a', id); const newer = refreshProjectConversation('research-a', id);
    replies[1](Response.json(snapshot({ updatedAt: '2026-10-17T01:10:00.000Z', messages: [{ id: 'native-user-1', role: 'user', text: 'What does this claim mean?' }, { id: 'native-answer-1', role: 'assistant', text: 'The complete latest answer.' }] })));
    await newer;
    replies[0](Response.json(snapshot({ updatedAt: '2026-10-17T01:05:00.000Z', messages: [{ id: 'native-user-1', role: 'user', text: 'What does this claim mean?' }, { id: 'native-answer-1', role: 'assistant', text: 'An earlier partial answer.' }] })));
    await older;
    expect(data().requests[data().conversations[id].requestIds[0]].body).toBe('The complete latest answer.');
  });

  it('只有原生用户消息时标记尚无可见回答，后续实际回答到达后才完成', async () => {
    const messages: NativeSessionSnapshot['messages'] = [{ id: 'native-user-only', role: 'user', text: 'A submitted native question' }];
    const mock = mockSnapshot(snapshot({ messages })); const id = await openProjectSession('research-a', summary());
    const requestId = data().conversations[id].requestIds[0];
    expect(data().requests[requestId]).toMatchObject({ status: 'interrupted', body: '', prompt: 'A submitted native question', nativeImported: true });
    expect(data().requests[requestId].error).toMatch(/尚无可见回答/);
    mock.mockImplementation(async () => Response.json(snapshot({ messages: [...messages, { id: 'native-eventual-answer', role: 'assistant', text: 'The actual visible answer.' }] })));
    await refreshProjectConversation('research-a', id);
    expect(data().conversations[id].requestIds).toEqual([requestId]);
    expect(data().requests[requestId]).toMatchObject({ status: 'done', body: 'The actual visible answer.' });
    expect(data().requests[requestId].error).toBeUndefined();
  });

  it('归档失败、工具活动和历史截断分别保留在原生记录上', async () => {
    const events = [{ kind: 'tool' as const, id: 'tool-native', text: 'Read completed', toolName: 'commandExecution', command: 'cat materials.md', output: 'Actual output', status: 'done' as const, exitCode: 0 }];
    mockSnapshot(snapshot({ archiveError: 'Readable archive could not be updated.', reason: 'Native lock will be checked.', truncated: true, messages: [{ id: 'u', role: 'user', text: 'Read source' }, { id: 'a', role: 'assistant', text: 'Answer', events }] }));
    const id = await openProjectSession('research-a', summary());
    expect(data().conversations[id].nativeReason).toMatch(/Readable archive/); expect(data().conversations[id].nativeReason).toMatch(/部分原生历史/);
    expect(data().requests[data().conversations[id].requestIds[0]].events).toEqual(events);
  });

  it('原生忙碌与未知状态按每次读取结果更新，不干扰已输入内容', async () => {
    const mock = mockSnapshot(snapshot({ state: 'busy', canResume: false, reason: 'Running elsewhere' }));
    const id = await openProjectSession('research-a', summary()); workspace.updateData(next => { next.conversations[id].input = 'Keep this draft'; });
    expect(data().conversations[id]).toMatchObject({ nativeState: 'busy', nativeCanResume: false });
    mock.mockImplementation(async () => Response.json(snapshot({ state: 'unknown', canResume: true, reason: 'Native lock checked on continuation' })));
    await refreshProjectConversation('research-a', id);
    expect(data().conversations[id]).toMatchObject({ nativeState: 'unknown', nativeCanResume: true, input: 'Keep this draft', nativeReason: 'Native lock checked on continuation' });
  });

  it('跨研究切换后的迟到读取仍写回原研究，不切走当前研究或污染其对话', async () => {
    let release!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const pending = openProjectSession('research-a', summary());
    workspace.switchResearch('research-b'); const activeB = workspace.getActiveConversation('research-b').id;
    workspace.updateData(next => { next.conversations[activeB].input = 'Research B draft'; });
    release(Response.json(snapshot())); const id = await pending;
    expect(data().scope).toEqual({ kind: 'research', researchId: 'research-b' });
    expect(data().sessions['research-b'].activeConversationId).toBe(activeB); expect(data().conversations[activeB].input).toBe('Research B draft');
    expect(data().conversations[id].researchId).toBe('research-a'); expect(data().requests[data().conversations[id].requestIds[0]].researchId).toBe('research-a');
  });

  it('本软件正在生成的对话不启动后台原生读取', async () => {
    const mock = mockSnapshot(snapshot()); const id = await openProjectSession('research-a', summary());
    workspace.updateData(next => { const request = ownRequest(id); request.status = 'generating'; next.requests[request.id] = request; next.conversations[id].requestIds.push(request.id); });
    await refreshProjectConversation('research-a', id); await refreshProjectConversation('research-b', id);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('导入问答拒绝重试与重新生成，避免把外部历史重新发送给模型', async () => {
    const mock = mockSnapshot(snapshot()); const id = await openProjectSession('research-a', summary()); const requestId = data().conversations[id].requestIds[0];
    await expect(regenerateAI(requestId)).rejects.toThrow(/重新生成/);
    workspace.updateData(next => { next.requests[requestId].status = 'interrupted'; });
    await expect(retryAI(requestId)).rejects.toThrow(/重试/);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('研究目录请求和重载恢复', () => {
  it('预览与绑定使用明确研究身份，未提交前不改变绑定；状态读取恢复同一标识', async () => {
    const newDirectory = { id: 'binding-b', projectId: 'project-b', path: '/fixture/research-b', name: 'research-b' };
    const mock = vi.fn(async (url: string) => Response.json(url.endsWith('/preview') ? { path: newDirectory.path, name: 'research-b' } : newDirectory));
    vi.stubGlobal('fetch', mock); workspace.switchResearch('research-b');
    const before = structuredClone(data());
    await previewResearchDirectory(newDirectory.path, 'research-b'); expect(data().researches['research-b'].directory).toBeUndefined();
    expect(data().researches['research-b'].title).toBe(before.researches['research-b'].title);
    await bindResearchDirectory('research-b', newDirectory.path); expect(data().researches['research-b'].directory).toEqual(newDirectory);
    expect(data().researches['research-b']).toEqual({ ...before.researches['research-b'], title: 'research-b', directory: newDirectory });
    expect(data().conversations).toEqual(before.conversations);
    workspace.switchResearch('research-a'); await getResearchDirectory('research-b');
    for (const call of mock.mock.calls as unknown as [string, RequestInit][]) expect(JSON.parse(call[1].body as string)).toMatchObject({ workspaceId: 'workspace-existing', researchId: 'research-b' });
    expect(data().researches['research-a'].directory).toEqual(directory);
  });

  it('已有项目从真实目录同步名称，不修改研究身份、资料、对话或当前选择', async () => {
    const before = structuredClone(data());
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...directory, name: '长文本阅读' })));
    await getResearchDirectory('research-a');
    expect(data().researches['research-a']).toEqual({ ...before.researches['research-a'], title: '长文本阅读', directory: { ...directory, name: '长文本阅读' } });
    expect(data().conversations).toEqual(before.conversations);
    expect(data().documents).toEqual(before.documents);
    expect(data().scope).toEqual(before.scope);
    const restored = migrateWorkspace(data());
    expect(restored.researches['research-a'].directory?.name).toBe('长文本阅读');
    restored.researches['research-a'].directory!.name = '';
    expect(() => migrateWorkspace(restored)).toThrow('研究目录名称损坏');
  });

  it.each(['network', 'html'] as const)('研究服务%s错误使用可操作文案并保留绑定与输入', async (kind) => {
    const id = workspace.getActiveConversation('research-a').id; workspace.updateData(next => { next.conversations[id].input = 'Do not lose my draft'; });
    vi.stubGlobal('fetch', vi.fn(async () => { if (kind === 'network') throw new TypeError('Failed to fetch'); return new Response('<html>development server fallback</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }); }));
    await expect(listProjectSessions('research-a')).rejects.toThrow(/启动 npm run ai/);
    expect(data().conversations[id].input).toBe('Do not lose my draft'); expect(data().researches['research-a'].directory).toEqual(directory);
  });

  it('重载时将旧busy降为未知并保留目录、原生身份、输入及来源', () => {
    const original = structuredClone(data()); const id = 'conversation-research-a';
    original.conversations[id] = { ...original.conversations[id], nativeSessionRef: 'opaque-session-ref', nativeSessionId: 'native-thread', nativeState: 'busy', nativeCanResume: true, input: 'Recover me', contextIds: ['evidence-a'], connectionId: 'codex' };
    const migrated = migrateWorkspace(original);
    expect(migrated.conversations[id]).toMatchObject({ nativeSessionRef: 'opaque-session-ref', nativeSessionId: 'native-thread', nativeState: 'unknown', nativeCanResume: false, input: 'Recover me', contextIds: ['evidence-a'] });
    expect(migrated.researches['research-a'].directory).toEqual(directory); expect(original.conversations[id].nativeState).toBe('busy');
  });

  it('损坏的目录或原生引用无法静默恢复，旧临时对话仍可无损读取', () => {
    const original = structuredClone(data()); const id = 'conversation-research-a'; original.conversations[id].nativeSessionId = 'legacy-native'; original.conversations[id].input = 'Legacy draft';
    const old = migrateWorkspace(original); expect(old.conversations[id]).toMatchObject({ nativeSessionId: 'legacy-native', input: 'Legacy draft' }); expect(old.conversations[id].nativeSessionRef).toBeUndefined();
    const brokenDirectory = structuredClone(original); (brokenDirectory.researches['research-a'].directory as unknown as { path: number }).path = 42;
    expect(() => migrateWorkspace(brokenDirectory)).toThrow(/研究目录/);
    const brokenReference = structuredClone(original); (brokenReference.conversations[id] as unknown as { nativeSessionRef: number }).nativeSessionRef = 42;
    expect(() => migrateWorkspace(brokenReference)).toThrow(/原生会话/); expect(original.conversations[id].input).toBe('Legacy draft');
  });
});
