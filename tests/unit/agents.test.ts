import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasFullText } from '../../src/domain/knowledge';
import { createSeed } from '../../src/data/seed';
import { getAsset, loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { migrateWorkspace } from '../../src/data/migrations';
import { bindResearchDirectory, getAgents, codexSupportsImages, currentAssistantSupportsImages, getResearchDirectory, listProjectSessions, openProjectSession, refreshProjectConversation, selectAgent } from '../../src/services/agents';
import { commitCardDraft, generateCardDraft, generateCardDraftFromExcerpts, reviseCardDraft, respondToAgent, retryAI, snapshotContext, stopAI, submitAI } from '../../src/services/ai';
import { workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn(), contentHash: vi.fn() }));
vi.mock('../../src/services/project-files', () => ({ syncResearchFiles: vi.fn(async () => {}) }));
const data = () => workspace.getState().data;
const frames = (events: unknown[]) => new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n');
const done = (text = '回答来自所选证据 [1]') => frames([{ type: 'session', nativeSessionId: 'native-1', nativeSessionRef: 'ref-native-1' }, { type: 'progress', kind: 'tool', text: '读取材料快照' }, { type: 'delta', text }, { type: 'done', model: 'runtime-model', nativeSessionId: 'native-1', nativeSessionRef: 'ref-native-1' }]);
beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  const seed = createSeed();
  Object.values(seed.researches).forEach(research => { research.directory = { id: `binding-${research.id}`, projectId: `project-${research.id}`, path: `/fixture/${research.id}` }; });
  Object.values(seed.documents).filter(hasFullText).forEach(doc => { doc.hash = 'a'.repeat(64); });
  vi.mocked(loadWorkspace).mockResolvedValue(seed);
  vi.mocked(saveWorkspace).mockResolvedValue(undefined);
  vi.mocked(getAsset).mockResolvedValue(new Blob(['fixture']));
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('研究与助手会话', () => {
  it('图片能力按当前助手与所选型号判断，未知型号不冒充支持', async () => {
    const catalog = { skills: [], plan: false, models: [
      { id: 'text-only', name: '文字', isDefault: true, inputModalities: ['text' as const] },
      { id: 'vision', name: '图像', inputModalities: ['text' as const, 'image' as const] },
      { id: 'unknown', name: '未确认' },
    ] };
    expect(codexSupportsImages(catalog)).toBe(false);
    expect(codexSupportsImages(catalog, 'vision')).toBe(true);
    expect(codexSupportsImages(catalog, 'unknown')).toBe(false);
    expect(codexSupportsImages(catalog, 'missing')).toBe(false);
    const conversation = selectAgent('research-a', 'codex');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(catalog)));
    workspace.updateData(next => { next.conversations[conversation].codex = { model: 'vision' }; });
    expect(await currentAssistantSupportsImages('research-a')).toBe(true);
    selectAgent('research-a', 'claude');
    expect(await currentAssistantSupportsImages('research-a')).toBe(false);
  });

  it('Codex 发送区域实际字节且只包含冻结的本轮上下文，文字助手拒绝发送', async () => {
    const conversation = selectAgent('research-a', 'codex');
    const blob = new Blob(['real-region-bytes'], { type: 'image/png' });
    vi.mocked(getAsset).mockResolvedValue(blob);
    const { contentHash } = await import('../../src/data/storage');
    vi.mocked(contentHash).mockResolvedValue('b'.repeat(64));
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,cmVhbC1yZWdpb24tYnl0ZXM=';
      onload?: () => void;
      readAsDataURL() { this.onload?.(); }
    });
    workspace.updateData(next => {
      next.evidence['evidence-a'].kind = 'region';
      next.evidence['evidence-a'].region = { assetId: 'region-a', hash: 'b'.repeat(64), rect: { x: 0, y: 0, width: 0.5, height: 0.5 }, rotation: 0, width: 100, height: 100 };
      next.conversations[conversation].contextIds = ['evidence-a'];
      next.conversations[conversation].codex = { model: 'vision' };
    });
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith('/capabilities')
      ? Response.json({ skills: [], plan: false, models: [{ id: 'text-only', name: '文字', isDefault: true, inputModalities: ['text'] }, { id: 'vision', name: '图像', inputModalities: ['text', 'image'] }] }) : JSON.parse(_init?.body as string).purpose === 'chat' ? done() : done(JSON.stringify({ title: '图像卡片', body: '图像来源 [1]', evidenceIds: ['evidence-a'] })));
    vi.stubGlobal('fetch', fetchMock);
    const id = await submitAI('research-a', conversation, '解释这张图');
    expect(data().requests[id].status).toBe('done');
    const payload = JSON.parse(fetchMock.mock.calls.find(([url]) => url.endsWith('/run'))![1]!.body as string);
    expect(payload.images).toEqual([{ evidenceId: 'evidence-a', dataUrl: 'data:image/png;base64,cmVhbC1yZWdpb24tYnl0ZXM=' }]);
    expect(payload.context[0].region.hash).toBe('b'.repeat(64));
    workspace.updateData(next => { next.conversations[conversation].codex = { model: 'text-only', access: 'full-access', mode: 'plan' }; });
    const draft = await generateCardDraft(id);
    expect(data().cardDrafts[draft].status).toBe('editing');
    const cardPayload = JSON.parse(fetchMock.mock.calls.filter(([url]) => url.endsWith('/run'))[1][1]!.body as string);
    expect(cardPayload).toMatchObject({ purpose: 'card', codex: { model: 'vision' } });
    expect(cardPayload).not.toHaveProperty('skillIds');
    expect(Object.keys(cardPayload.codex)).toEqual(['model']);
    workspace.updateData(next => { next.conversations[conversation].codex = { model: 'vision', access: 'full-access' }; });
    const excerptDraft = await generateCardDraftFromExcerpts('research-a', ['evidence-a']);
    expect(data().cardDrafts[excerptDraft].source.codexModel).toBe('vision');
    workspace.updateData(next => { next.conversations[conversation].codex = { model: 'text-only' }; });
    await reviseCardDraft(excerptDraft, '保留图像依据，简化结论。');
    const revisionPayload = JSON.parse(fetchMock.mock.calls.filter(([url]) => url.endsWith('/run')).at(-1)![1]!.body as string);
    expect(revisionPayload).toMatchObject({ purpose: 'revision', codex: { model: 'vision' } });
    const claude = selectAgent('research-a', 'claude');
    fetchMock.mockClear();
    const blocked = await submitAI('research-a', claude, '解释这张图');
    expect(data().requests[blocked]).toMatchObject({ status: 'error', error: expect.stringContaining('未确认支持图片') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('目录只在绑定确认时保存，状态与原生列表使用同一研究身份', async () => {
    const binding = { id: 'binding-confirmed', projectId: 'project-confirmed', path: '/fixture/confirmed' };
    const fetchMock = vi.fn(async (url: string) => Response.json(url.endsWith('/list') ? { sessions: [], errors: [] } : binding));
    vi.stubGlobal('fetch', fetchMock);
    const prior = data().researches['research-a'].directory;
    expect(prior?.path).toBe('/fixture/research-a');
    await bindResearchDirectory('research-a', binding.path);
    expect(data().researches['research-a'].directory).toEqual(binding);
    expect(await getResearchDirectory('research-a')).toEqual(binding);
    expect(await listProjectSessions('research-a')).toEqual({ sessions: [], errors: [] });
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) expect(JSON.parse(init.body as string)).toMatchObject({ researchId: 'research-a', workspaceId: data().agentWorkspaceId });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/ai/agents/projects/bind', '/api/ai/agents/projects/status', '/api/ai/agents/projects/list']);
  });

  it('原生会话按身份导入并增量刷新，保留输入与可核查来源边界', async () => {
    const snapshot = { id: 'ref-native-import', agentId: 'codex' as const, nativeSessionId: 'native-import', title: '原生研究对话', updatedAt: '2026-10-17T00:00:00Z', state: 'idle' as const, canResume: true, origin: 'native' as const, messages: [{ id: 'user-1', role: 'user' as const, text: '比较条件' }, { id: 'answer-1', role: 'assistant' as const, text: '原始回答，没有已关联材料。' }] };
    const fetchMock = vi.fn(async () => Response.json(snapshot)); vi.stubGlobal('fetch', fetchMock);
    const id = await openProjectSession('research-a', snapshot);
    workspace.updateData(next => { next.conversations[id].input = '尚未发送的追问'; });
    const requestId = data().conversations[id].requestIds[0];
    expect(data().requests[requestId]).toMatchObject({ nativeImported: true, nativeMessageId: 'user-1', context: [], evidenceIds: [], body: '原始回答，没有已关联材料。' });
    snapshot.messages.push({ id: 'answer-extra', role: 'assistant', text: '新增的原生内容。' });
    await refreshProjectConversation('research-a', id); await refreshProjectConversation('research-a', id);
    expect(data().conversations[id]).toMatchObject({ input: '尚未发送的追问', nativeSessionRef: snapshot.id, nativeSessionId: snapshot.nativeSessionId, nativeCanResume: true, requestIds: [requestId] });
    expect(data().requests[requestId].body).toBe('原始回答，没有已关联材料。\n\n新增的原生内容。');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('安装入口只保留已核实的官方HTTPS站点', async () => {
    const base = { name: 'Codex', state: 'not-installed', capabilities: { images: false, tools: false, resume: true, permissions: 'read-only' } };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agents: [
      { ...base, id: 'codex', installation: { url: 'https://learn.chatgpt.com/docs/cli', label: '安装说明' } },
      { ...base, id: 'claude', installation: { url: 'javascript:alert(1)', label: '无效链接' } },
      { ...base, id: 'opencode', installation: { url: 'https://opencode.ai.attacker.example/install', label: '无效站点' } },
    ] })));
    const agents = await getAgents();
    expect(agents[0].installation?.url).toBe('https://learn.chatgpt.com/docs/cli');
    expect(agents[1].installation).toBeUndefined();
    expect(agents[2].installation).toBeUndefined();
  });

  it('工具开始和完成更新同一记录，真实命令与输出不混入回答正文', async () => {
    const conversation = selectAgent('research-a', 'codex');
    vi.stubGlobal('fetch', vi.fn(async () => frames([
      { type: 'progress', kind: 'tool', id: 'tool-1', toolName: 'commandExecution', command: 'cat materials.md', status: 'running', text: '读取材料' },
      { type: 'progress', kind: 'tool', id: 'tool-1', status: 'done', output: '工具的实际输出', text: '读取完成' },
      { type: 'delta', text: '这是原始回答。' }, { type: 'done', model: 'test-model' },
    ])));
    const id = await submitAI('research-a', conversation, '读材料');
    expect(data().requests[id].events).toEqual([{ kind: 'tool', id: 'tool-1', toolName: 'commandExecution', command: 'cat materials.md', status: 'done', output: '工具的实际输出', text: '读取完成' }]);
    expect(data().requests[id].body).toBe('这是原始回答。');
  });

  it('写锁恢复改用副本后保留原生累计材料与旧消息来源，下一轮沿用新关联', async () => {
    const conversation = selectAgent('research-a', 'codex');
    workspace.addContext({ researchId: 'research-a', conversationId: conversation, evidenceIds: ['evidence-a'] });
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => done('前一轮未引用材料的回答。'));
    vi.stubGlobal('fetch', mock);
    const original = await submitAI('research-a', conversation, '原来的问题');
    workspace.updateData(next => { next.conversations[conversation].contextIds = ['evidence-b']; });
    mock.mockImplementation(async () => frames([
      { type: 'session', nativeSessionId: 'native-fork', nativeSessionRef: 'ref-fork', forkedFromId: 'native-1' },
      { type: 'progress', kind: 'status', id: 'session-fork', text: '原会话由 Codex 后台保留，已保留历史并在独立会话继续。原会话不受影响。' },
      { type: 'delta', text: '继续核对本轮材料 [1]' },
      { type: 'done', nativeSessionId: 'native-fork', nativeSessionRef: 'ref-fork', model: 'runtime-model' },
    ]));
    const recovered = await submitAI('research-a', conversation, '继续讨论');
    expect(data().requests[recovered].context.map(item => item.evidenceId)).toEqual(['evidence-b']);
    expect(data().conversations[conversation].sentContext?.map(item => item.evidenceId)).toEqual(['evidence-a', 'evidence-b']);
    expect(data().requests[original].nativeSessionId).toBe('native-1');
    expect(data().requests[recovered]).toMatchObject({ nativeSessionId: 'native-fork', status: 'done', events: [expect.objectContaining({ id: 'session-fork' })] });
    expect(data().conversations[conversation]).toMatchObject({ nativeSessionId: 'native-fork', nativeSessionRef: 'ref-fork', nativeState: 'idle', nativeCanResume: true });
    await submitAI('research-a', conversation, '下一轮');
    expect(JSON.parse(mock.mock.calls[2][1]!.body as string).sessionRef).toBe('ref-fork');
    expect(mock).toHaveBeenCalledTimes(3);
  });
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

  it('Codex 提交冻结技能和模型模式，重试沿用原快照，整理卡片不继承技能', async () => {
    const conversation = selectAgent('research-a', 'codex');
    const skill = { id: '/skills/research/SKILL.md', name: '研究核查', description: '核对研究依据', enabled: true };
    const settings = { model: 'submitted-model', mode: 'plan' as const, effort: 'ultra', access: 'full-access' as const };
    workspace.updateData(next => { next.conversations[conversation].skills = [skill]; next.conversations[conversation].codex = settings; });
    let release!: (response: Response) => void;
    let runs = 0;
    const mock = vi.fn((_url: string, init?: RequestInit): Promise<Response> => {
      const payload = JSON.parse(init?.body as string);
      if (payload.purpose === 'card') return Promise.resolve(done(JSON.stringify({ title: '独立研究卡片', body: '需要继续核查的观点。', evidenceIds: [] })));
      return ++runs === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(done('有效答复。'));
    });
    vi.stubGlobal('fetch', mock);
    const pending = submitAI('research-a', conversation, '调用所选技能核查');
    await vi.waitFor(() => expect(release).toBeDefined());
    workspace.updateData(next => {
      next.conversations[conversation].skills![0].name = '后续修改的技能';
      next.conversations[conversation].skills = [];
      next.conversations[conversation].codex = { model: 'later-model', mode: 'chat' };
    });
    release(done('越界的来源编号 [99]'));
    const original = await pending;
    expect(data().requests[original]).toMatchObject({ status: 'error', skills: [skill], codex: settings });
    expect(JSON.parse(mock.mock.calls[0][1]!.body as string)).toMatchObject({ skillIds: [skill.id], codex: settings });
    const retry = await retryAI(original);
    expect(data().requests[retry]).toMatchObject({ status: 'done', retryOf: original, skills: [skill], codex: settings });
    expect(JSON.parse(mock.mock.calls[1][1]!.body as string)).toMatchObject({ skillIds: [skill.id], codex: settings, reset: true });
    await generateCardDraft(retry);
    const cardPayload = JSON.parse(mock.mock.calls[2][1]!.body as string);
    expect(cardPayload.purpose).toBe('card');
    expect(cardPayload).not.toHaveProperty('skillIds');
    expect(cardPayload).not.toHaveProperty('codex');
    const cardRequest = data().requests[cardPayload.requestId];
    expect(cardRequest.skills).toBeUndefined();
    expect(cardRequest.codex).toBeUndefined();
  });

  it('跨研究交互回应绑定原请求，断流和停止均让未完成交互失效', async () => {
    const conversation = selectAgent('research-a', 'codex');
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const mock = vi.fn((url: string, _init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/respond')) return Promise.resolve(Response.json({ accepted: true }));
      if (url.endsWith('/stop')) return Promise.resolve(Response.json({ stopped: true }));
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } })));
    });
    const emit = (index: number, ...events: object[]) => streams[index].enqueue(new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n'));
    vi.stubGlobal('fetch', mock);
    const pending = submitAI('research-a', conversation, '需要确认后再继续');
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    const request = Object.values(data().requests).find(item => item.conversationId === conversation)!;
    emit(0, { type: 'interaction', interaction: { id: 'question-1', kind: 'question', title: '核查范围', questions: [{ id: 'scope', question: '核查哪些材料？', options: [{ label: '当前材料' }] }] } });
    await vi.waitFor(() => expect(data().requests[request.id].interactions?.[0].status).toBe('pending'));
    workspace.switchResearch('research-b');
    selectAgent('research-b', 'opencode');
    const reply = { answers: { scope: ['当前材料'] } };
    await respondToAgent(request.id, 'question-1', reply);
    const responseCall = mock.mock.calls.find(([url]) => url.endsWith('/respond'))!;
    expect(JSON.parse(responseCall[1]!.body as string)).toEqual({ workspaceId: data().agentWorkspaceId, requestId: request.id, researchId: 'research-a', conversationId: conversation, connectionId: 'codex', interactionId: 'question-1', reply });
    emit(0,
      { type: 'interaction-resolved', id: 'question-1', status: 'answered' },
      { type: 'delta', text: '已开始分析当前材料。' },
      { type: 'interaction', interaction: { id: 'approval-1', kind: 'approval', title: '继续读取材料' } },
    );
    streams[0].close();
    expect(await pending).toBe(request.id);
    expect(data().requests[request.id]).toMatchObject({ status: 'error', researchId: 'research-a', body: '已开始分析当前材料。', interactions: [{ id: 'question-1', status: 'answered' }, { id: 'approval-1', status: 'expired' }] });
    const sent = mock.mock.calls.length;
    await expect(respondToAgent(request.id, 'approval-1', { decision: 'allowOnce' })).rejects.toThrow(/结束/);
    expect(mock).toHaveBeenCalledTimes(sent);

    const retrying = retryAI(request.id);
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    const retry = Object.values(data().requests).find(item => item.retryOf === request.id)!;
    emit(1, { type: 'interaction', interaction: { id: 'approval-2', kind: 'approval', title: '读取本轮材料' } });
    await vi.waitFor(() => expect(data().requests[retry.id].interactions?.[0].status).toBe('pending'));
    stopAI(retry.id);
    expect(data().requests[retry.id]).toMatchObject({ status: 'stopped', interactions: [{ id: 'approval-2', status: 'expired' }] });
    await expect(respondToAgent(retry.id, 'approval-2', { decision: 'allowOnce' })).rejects.toThrow(/结束/);
    streams[1].close(); await retrying;
    const stopCall = mock.mock.calls.find(([url]) => url.endsWith('/stop'))!;
    expect(JSON.parse(stopCall[1]!.body as string)).toMatchObject({ requestId: retry.id, researchId: 'research-a', conversationId: conversation, connectionId: 'codex', workspaceId: data().agentWorkspaceId });
    expect(data().scope).toEqual({ kind: 'research', researchId: 'research-b' });
    expect(workspace.getActiveConversation('research-b').requestIds).toEqual([]);
  });

  it('续接仅在done返回原生ID时，新增材料仍计入累计范围与请求身份', async () => {
    const conversation = selectAgent('research-a', 'opencode');
    workspace.addContext({ researchId: 'research-a', conversationId: conversation, evidenceIds: ['evidence-a'] });
    vi.stubGlobal('fetch', vi.fn(async () => frames([{ type: 'delta', text: '正文 [1]' }, { type: 'done', nativeSessionId: 'ses_test', nativeSessionRef: 'ref-ses-test', model: 'explicit-model' }])));
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

  it('保存模型推理与权限选择，拒绝损坏的权限设置而不清空草稿', () => {
    const seed = createSeed(), conversation = Object.values(seed.conversations)[0];
    conversation.input = '仍在编辑的研究问题';
    conversation.codex = { model: 'selected-model', effort: 'ultra', access: 'full-access', mode: 'chat' };
    expect(migrateWorkspace(seed).conversations[conversation.id].codex).toEqual(conversation.codex);
    (conversation.codex as { access: string }).access = 'unknown';
    expect(() => migrateWorkspace(seed)).toThrow('Codex 设置损坏');
    expect(conversation.input).toBe('仍在编辑的研究问题');
  });
});

it('原生忙碌或连接失败保留原输入，成功后才清空且不自动重发', async () => {
  const id = selectAgent('research-a', 'codex');
  const prompt = '原生客户端释放占用后继续这个问题';
  workspace.updateData(next => { next.conversations[id].input = prompt; });
  const mock = vi.fn(async () => frames([{ type: 'error', code: 'session_busy', error: '此原生会话正在其他客户端使用。' }]));
  vi.stubGlobal('fetch', mock);
  const failed = await submitAI('research-a', id, prompt);
  expect(data().requests[failed].status).toBe('error');
  expect(data().conversations[id].input).toBe(prompt);
  expect(mock).toHaveBeenCalledTimes(1);
  mock.mockImplementation(async () => done('明确再次提交后的回答。'));
  await submitAI('research-a', id, prompt);
  expect(data().conversations[id].input).toBe('');
  expect(mock).toHaveBeenCalledTimes(2);
});

it('Codex 不再受 16 条、24,000 字材料与 80,000 字历史限制，快照和引用校验仍完整保留', async () => {
  const id = selectAgent('research-a', 'codex');
  workspace.updateData(next => {
    const ids = Array.from({ length: 17 }, (_, index) => `context-evidence-${index}`);
    ids.forEach(evidenceId => { next.evidence[evidenceId] = { ...next.evidence['evidence-a'], id: evidenceId, quote: '完整保留的原文明示材料。'.repeat(130) }; });
    next.conversations[id].contextIds = ids;
  });
  const longAnswer = '已在原生会话中的历史回答。'.repeat(8000);
  expect(longAnswer.length).toBeGreaterThan(80_000);
  const mock = vi.fn(async (_url: string, _init?: RequestInit) => done(longAnswer));
  vi.stubGlobal('fetch', mock);
  const first = await submitAI('research-a', id, '比较全部明确选择的材料');
  expect(data().requests[first]).toMatchObject({ status: 'done', evidenceIds: [] });
  mock.mockImplementation(async () => done());
  const second = await submitAI('research-a', id, '继续原生历史');
  expect(data().requests[second].status).toBe('done');
  const payload = JSON.parse(mock.mock.calls[1][1]!.body as string);
  expect(payload.context).toHaveLength(17);
  expect(payload.context.reduce((total: number, item: { quote: string }) => total + item.quote.length, 0)).toBeGreaterThan(24_000);
  expect(payload.history[0].body).toBe(longAnswer);
  expect(payload.context.map((item: { evidenceId: string }) => item.evidenceId)).toEqual(data().conversations[id].contextIds);
  const model = selectAgent('research-a', 'model');
  workspace.updateData(next => { next.conversations[model].contextIds = [...next.conversations[id].contextIds]; });
  expect(() => snapshotContext(data(), 'research-a', model)).toThrow('上下文过大');
  workspace.updateData(next => { next.documents[next.evidence['context-evidence-0'].documentId].hash = 'changed-source'; });
  await expect(submitAI('research-a', id, '不能绕过来源验证')).rejects.toThrow('请求来源已变化');
  expect(mock).toHaveBeenCalledTimes(2);
});
