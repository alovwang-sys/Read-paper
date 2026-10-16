import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { getAsset, loadWorkspace, saveMigrationBackup, saveWorkspace } from '../../src/data/storage';
import type { AIRequest, ContextSnapshot, NativeSessionSnapshot, NativeSessionSummary } from '../../src/domain/types';
import { bindResearchDirectory, getResearchDirectory, listProjectSessions, openProjectSession, previewResearchDirectory, refreshProjectConversation } from '../../src/services/agents';
import { createManualCardDraft, regenerateAI, retryAI } from '../../src/services/ai';
import { workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn(), contentHash: vi.fn() }));
const data = () => workspace.getState().data;
const directory = { id: 'binding-a', projectId: 'project-a', path: '/fixture/research-a' };
const summary = (overrides: Partial<NativeSessionSummary> = {}): NativeSessionSummary => ({ id: 'opaque-session-ref', agentId: 'codex', nativeSessionId: 'native-thread', title: 'Native discussion', updatedAt: '2026-10-17T01:00:00.000Z', state: 'unknown', canResume: true, origin: 'native', ...overrides });
const snapshot = (overrides: Partial<NativeSessionSnapshot> = {}): NativeSessionSnapshot => ({ ...summary(), messages: [{ id: 'native-user-1', role: 'user', text: 'What does this claim mean?', createdAt: '2026-10-17T00:59:00.000Z' }, { id: 'native-answer-1', role: 'assistant', text: 'An external answer cites [1], but its source is not associated.' }], ...overrides });
const mockSnapshot = (value: NativeSessionSnapshot) => { const mock = vi.fn(async () => Response.json(value)); vi.stubGlobal('fetch', mock); return mock; };
function source(): ContextSnapshot {
  const evidence = data().evidence['evidence-a']; const document = data().documents[evidence.documentId];
  return { evidenceId: evidence.id, documentId: document.id, documentHash: document.hash, title: document.title, pageIndex: evidence.pageIndex, quote: evidence.quote };
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
  Object.values(seed.documents).forEach(document => { document.hash = 'a'.repeat(64); });
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(seed);
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('研究项目原生历史的公开服务路径', () => {
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
    const newDirectory = { id: 'binding-b', projectId: 'project-b', path: '/fixture/research-b' };
    const mock = vi.fn(async (url: string) => Response.json(url.endsWith('/preview') ? { path: newDirectory.path, name: 'research-b' } : newDirectory));
    vi.stubGlobal('fetch', mock); workspace.switchResearch('research-b');
    await previewResearchDirectory(newDirectory.path, 'research-b'); expect(data().researches['research-b'].directory).toBeUndefined();
    await bindResearchDirectory('research-b', newDirectory.path); expect(data().researches['research-b'].directory).toEqual(newDirectory);
    workspace.switchResearch('research-a'); await getResearchDirectory('research-b');
    for (const call of mock.mock.calls as unknown as [string, RequestInit][]) expect(JSON.parse(call[1].body as string)).toMatchObject({ workspaceId: 'workspace-existing', researchId: 'research-b' });
    expect(data().researches['research-a'].directory).toEqual(directory);
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
