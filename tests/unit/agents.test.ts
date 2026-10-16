import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { getAsset, loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { migrateWorkspace } from '../../src/data/migrations';
import { selectAgent } from '../../src/services/agents';
import { commitCardDraft, generateCardDraft, retryAI, stopAI, submitAI } from '../../src/services/ai';
import { workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn(), contentHash: vi.fn() }));
const data = () => workspace.getState().data;
const frames = (events: unknown[]) => new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n');
const done = (text = '回答来自所选证据 [1]') => frames([{ type: 'session', nativeSessionId: 'native-1' }, { type: 'progress', kind: 'tool', text: '读取材料快照' }, { type: 'delta', text }, { type: 'done', model: 'runtime-model' }]);
beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  const seed = createSeed();
  Object.values(seed.documents).forEach(doc => { doc.hash = 'a'.repeat(64); });
  vi.mocked(loadWorkspace).mockResolvedValue(seed);
  vi.mocked(saveWorkspace).mockResolvedValue(undefined);
  vi.mocked(getAsset).mockResolvedValue(new Blob(['fixture']));
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('研究与助手会话', () => {
  it('切换复用各自对话与输入，首次只带显式材料，干净会话继承助手而无材料', () => {
    const original = workspace.getActiveConversation('research-a').id;
    workspace.addContext({ researchId: 'research-a', conversationId: original, evidenceIds: ['evidence-a'] });
    workspace.updateData(next => { next.conversations[original].input = '尚未发送'; });
    const codex = selectAgent('research-a', 'codex');
    expect(data().conversations[codex]).toMatchObject({ connectionId: 'codex', contextIds: ['evidence-a'], input: '', requestIds: [] });
    workspace.updateData(next => { next.conversations[codex].input = 'Codex 的问题'; });
    expect(selectAgent('research-a', 'model')).toBe(original);
    expect(data().conversations[original].input).toBe('尚未发送');
    expect(selectAgent('research-a', 'codex')).toBe(codex);
    expect(data().conversations[codex].input).toBe('Codex 的问题');
    const fresh = workspace.createConversation('research-a');
    expect(data().conversations[fresh]).toMatchObject({ connectionId: 'codex', contextIds: [], requestIds: [], input: '' });
    expect(selectAgent('research-b', 'codex')).not.toBe(codex);
    expect(data().conversations[data().sessions['research-b'].activeConversationId!].contextIds).toEqual([]);
  });

  it('原生流式事件、迟到响应与知识草稿保持原研究和连接，确认存卡幂等', async () => {
    const conversation = selectAgent('research-a', 'codex');
    workspace.addContext({ researchId: 'research-a', conversationId: conversation, evidenceIds: ['evidence-a'] });
    let release!: (response: Response) => void;
    const fetchMock = vi.fn((_url: string, init?: RequestInit): Promise<Response> => {
      const payload = JSON.parse(init?.body as string);
      return payload.purpose === 'chat' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(done(JSON.stringify({ title: '研究卡片', body: '保留证据 [1]', evidenceIds: ['evidence-a'] })));
    });
    vi.stubGlobal('fetch', fetchMock);
    const pending = submitAI('research-a', conversation, '解释材料');
    await vi.waitFor(() => expect(release).toBeDefined());
    selectAgent('research-a', 'model');
    workspace.openResource({ kind: 'research', id: 'research-b' }, { scope: { kind: 'research', researchId: 'research-b' }, target: 'main' });
    release(done());
    const id = await pending;
    expect(data().requests[id]).toMatchObject({ connectionId: 'codex', researchId: 'research-a', conversationId: conversation, nativeSessionId: 'native-1', status: 'done', events: [{ kind: 'tool', text: '读取材料快照' }] });
    expect(data().conversations[conversation].nativeSessionId).toBe('native-1');
    const payload = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(payload.workspaceId).toBe(data().agentWorkspaceId);
    expect(payload.context[0].evidenceId).toBe('evidence-a');
    const draftId = await generateCardDraft(id);
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toMatchObject({ purpose: 'card', connectionId: 'codex', researchId: 'research-a' });
    const card = commitCardDraft(draftId);
    expect(commitCardDraft(draftId)).toBe(card);
    expect(data().cards[card].provenance?.connectionId).toBe('codex');
    expect(data().researches['research-b'].cardIds).not.toContain(card);
  });

  it('无效引用保留原答且阻止来源入库；重试绑定原连接并创建新尝试', async () => {
    const conversation = selectAgent('research-a', 'codex');
    workspace.addContext({ researchId: 'research-a', conversationId: conversation, evidenceIds: ['evidence-a'] });
    const mock = vi.fn(async () => done('越界引用 [99]'));
    vi.stubGlobal('fetch', mock);
    const id = await submitAI('research-a', conversation, '核查');
    expect(data().requests[id]).toMatchObject({ status: 'error', body: '越界引用 [99]' });
    await expect(generateCardDraft(id)).rejects.toThrow(/引用/);
    mock.mockImplementation(async () => done());
    const next = await retryAI(id, 'demo');
    expect(data().requests[next]).toMatchObject({ retryOf: id, connectionId: 'codex', status: 'done' });
    expect(JSON.parse((mock.mock.calls as unknown as [string, RequestInit][])[1][1].body as string).reset).toBe(true);
  });

  it('续接仅在done返回原生ID时，新增材料仍计入累计范围与请求身份', async () => {
    const conversation = selectAgent('research-a', 'opencode');
    workspace.addContext({ researchId: 'research-a', conversationId: conversation, evidenceIds: ['evidence-a'] });
    vi.stubGlobal('fetch', vi.fn(async () => frames([{ type: 'delta', text: '正文 [1]' }, { type: 'done', nativeSessionId: 'ses_test', model: 'explicit-model' }])));
    const first = await submitAI('research-a', conversation, '第一问');
    expect(data().requests[first].nativeSessionId).toBe('ses_test');
    workspace.addContext({ researchId: 'research-a', conversationId: conversation, evidenceIds: ['evidence-b'] });
    const second = await submitAI('research-a', conversation, '第二问');
    expect(data().requests[second].nativeSessionId).toBe('ses_test');
    expect(data().conversations[conversation].sentContext?.map(item => item.evidenceId)).toEqual(['evidence-a', 'evidence-b']);
  });

  it('取消后迟到内容不覆盖部分回答，停止命令包含原研究和工作区', async () => {
    const conversation = selectAgent('research-a', 'codex');
    let release!: (response: Response) => void;
    const mock = vi.fn((url: string) => url.endsWith('/stop') ? Promise.resolve(Response.json({ stopped: true })) : new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', mock);
    const pending = submitAI('research-a', conversation, '停止测试');
    await vi.waitFor(() => expect(release).toBeDefined());
    const request = Object.values(data().requests).find(item => item.conversationId === conversation)!;
    stopAI(request.id);
    release(done('迟到的文本'));
    await pending;
    expect(data().requests[request.id]).toMatchObject({ status: 'stopped', body: '' });
    expect(mock.mock.calls[1][0]).toBe('/api/ai/agents/stop');
  });

  it('旧schema 2无损读取新增连接字段并拒绝未知连接，不清除输入', () => {
    const seed = createSeed();
    const conversation = Object.values(seed.conversations)[0];
    conversation.input = '恢复我的输入';
    conversation.connectionId = 'codex';
    conversation.nativeSessionId = 'native-test';
    expect(migrateWorkspace(seed).conversations[conversation.id]).toMatchObject({ input: '恢复我的输入', connectionId: 'codex', nativeSessionId: 'native-test' });
    (conversation as unknown as { connectionId: string }).connectionId = 'unknown';
    expect(() => migrateWorkspace(seed)).toThrow(/连接/);
    expect(conversation.input).toBe('恢复我的输入');
  });
});
