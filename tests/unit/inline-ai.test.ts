import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { getAsset, loadWorkspace, saveMigrationBackup, saveWorkspace } from '../../src/data/storage';
import { migrateWorkspace } from '../../src/data/migrations';
import { researchEvidence } from '../../src/domain/knowledge';
import { commitCardDraft, submitAI, type AIResponder } from '../../src/services/ai';
import { continueInlineInPanel, createInlineCardDraft, createInlineConversation, findInlineConversation, inlineAIConfig } from '../../src/services/inline-ai';
import { getActiveConversation, workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn(), contentHash: vi.fn() }));
const state = () => workspace.getState().data;
const source = { documentId: 'paper-a', pageIndex: 0, quote: 'A selected passage for local explanation.' };
const rightId = 'conversation-research-a';

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(saveWorkspace).mockResolvedValue(undefined);
  vi.mocked(saveMigrationBackup).mockResolvedValue(undefined);
  vi.mocked(getAsset).mockResolvedValue(new Blob(['PDF']));
  const seed = createSeed();
  seed.documents['paper-a'].hash = 'a'.repeat(64);
  vi.mocked(loadWorkspace).mockResolvedValue(seed);
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('原文旁问答', () => {
  it('建立独立会话和内部来源，不打开右侧、不增加可见摘录，重复打开复用问答', () => {
    const before = structuredClone(state().sessions['research-a']);
    const visible = researchEvidence(state(), 'research-a').length;
    state().conversations[rightId].input = '右侧未发送的研究问题';
    const id = createInlineConversation('research-a', source);
    expect(state().sessions['research-a']).toEqual(before);
    expect(state().conversations[rightId].input).toBe('右侧未发送的研究问题');
    expect(state().conversations[rightId].contextIds).not.toContain(state().conversations[id].contextIds[0]);
    expect(researchEvidence(state(), 'research-a')).toHaveLength(visible);
    expect(state().evidence[state().conversations[id].contextIds[0]].contextOnly).toBe(true);
    expect(createInlineConversation('research-a', source)).toBe(id);
    expect(findInlineConversation('research-a', source)?.id).toBe(id);
  });

  it('右侧选中本机助手或目录故障时，轻问仍使用同一内置模型服务，不调用CLI或目录同步', async () => {
    workspace.updateData(data => {
      data.conversations[rightId].connectionId = 'codex';
      data.researches['research-a'].directory = { id: 'binding', projectId: 'project', path: '/unavailable' };
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (url === '/api/ai/config') return new Response(JSON.stringify({ configured: true, runtime: 'pi', model: 'glm-5.3-flash', images: false }));
      if (url === '/api/ai/chat') return new Response('{"type":"delta","text":"对所选原文的解释 [1]"}\n{"type":"done"}\n');
      throw new Error('不应访问CLI或目录服务');
    });
    vi.stubGlobal('fetch', fetchMock);
    const id = createInlineConversation('research-a', source);
    const requestId = await submitAI('research-a', id, '解释这段');
    expect(state().requests[requestId].status).toBe('done');
    expect(state().requests[requestId].connectionId).toBe('model');
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/ai/config', '/api/ai/chat']);
  });

  it('未配置模型时明确说明模型设置，不将问题归咎于CLI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ configured: false }))));
    await expect(inlineAIConfig('research-a')).rejects.toThrow('请先在设置中配置模型连接');
  });

  it('另一处选区和切研究不扩大已提交范围，迟到回答留在原研究', async () => {
    const id = createInlineConversation('research-a', source);
    let finish!: () => void;
    const responder: AIResponder = request => new Promise(resolve => {
      expect(request.context.map(item => item.quote)).toEqual([source.quote]);
      finish = () => resolve({ body: '原选区的解释 [1]', evidenceIds: [request.context[0].evidenceId] });
    });
    const running = submitAI('research-a', id, '原问题', responder);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const second = createInlineConversation('research-a', { ...source, quote: 'A separate selected passage.' });
    workspace.switchResearch('research-b');
    finish();
    const requestId = await running;
    expect(state().requests[requestId].researchId).toBe('research-a');
    expect(state().requests[requestId].context[0].quote).toBe(source.quote);
    expect(state().conversations[second].requestIds).toHaveLength(0);
    expect(state().scope).toEqual({ kind: 'research', researchId: 'research-b' });
  });

  it('就地编辑并确认存卡保留双来源，连点不重复，不抢占右侧', async () => {
    const before = structuredClone(state().sessions['research-a'].panel);
    const id = createInlineConversation('research-a', source);
    const requestId = await submitAI('research-a', id, '解释术语', async request => ({ body: '可以编辑的解释 [1]', evidenceIds: [request.context[0].evidenceId] }));
    const draftId = createInlineCardDraft(requestId);
    expect(createInlineCardDraft(requestId)).toBe(draftId);
    expect(state().conversations[id].inlineSource?.draftId).toBe(draftId);
    workspace.updateData(data => { data.cardDrafts[draftId].title = '我理解的术语'; data.cardDrafts[draftId].body = '我修改后的理解 [1]'; });
    const cardId = commitCardDraft(draftId);
    expect(commitCardDraft(draftId)).toBe(cardId);
    expect(state().cards[cardId].provenance?.requestId).toBe(requestId);
    expect(state().cards[cardId].provenance?.context[0].quote).toBe(source.quote);
    expect(state().evidence[state().cards[cardId].evidenceIds[0]].contextOnly).toBeUndefined();
    expect(state().sessions['research-a'].panel).toEqual(before);
  });

  it('在右侧继续复用同一记录，保留原会话输入和材料', () => {
    workspace.updateData(data => { data.conversations[rightId].input = '原有讨论草稿'; });
    const before = structuredClone(state().conversations[rightId]);
    const id = createInlineConversation('research-a', source);
    const count = Object.keys(state().conversations).length;
    continueInlineInPanel(id);
    expect(state().sessions['research-a'].activeConversationId).toBe(id);
    expect(state().sessions['research-a'].panel.mode).toBe('ai');
    expect(state().conversations[id].inlineSource?.promoted).toBe(true);
    expect(state().conversations[rightId]).toEqual(before);
    expect(Object.keys(state().conversations)).toHaveLength(count);
  });

  it('刷新迁移保留轻问、输入及来源，未展开的轻问不会变成右侧默认对话', () => {
    const id = createInlineConversation('research-a', source);
    workspace.updateData(data => { data.conversations[id].input = '稍后继续问'; });
    const restored = migrateWorkspace(structuredClone(state()));
    expect(restored.conversations[id].inlineSource).toEqual(state().conversations[id].inlineSource);
    expect(restored.conversations[id].input).toBe('稍后继续问');
    expect(restored.evidence[restored.conversations[id].contextIds[0]].contextOnly).toBe(true);
    delete restored.sessions['research-a'].activeConversationId;
    expect(getActiveConversation(restored, 'research-a')?.id).toBe(rightId);
  });

  it('明确摘录复用内部来源并显示，不产生第二条证据', () => {
    const id = createInlineConversation('research-a', source), evidenceId = state().conversations[id].contextIds[0];
    const count = Object.keys(state().evidence).length;
    expect(workspace.captureExcerpt('research-a', source)).toBe(evidenceId);
    expect(state().evidence[evidenceId].contextOnly).toBeUndefined();
    expect(Object.keys(state().evidence)).toHaveLength(count);
  });
  it('同图像内容但不同页面位置保留各自区域来源', () => {
    const region = { assetId: 'region-1', hash: 'c'.repeat(64), rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, rotation: 0, width: 300, height: 100 };
    const first = createInlineConversation('research-a', { ...source, kind: 'region', quote: '', region });
    const other = { ...source, kind: 'region' as const, quote: '', region: { ...region, assetId: 'region-2', rect: { ...region.rect, y: 0.6 } } };
    const second = createInlineConversation('research-a', other);
    expect(second).not.toBe(first);
    expect(state().evidence[state().conversations[second].contextIds[0]].region?.rect.y).toBe(0.6);
    expect(findInlineConversation('research-a', other)?.id).toBe(second);
  });

  it('预检使用轻问自己的连接，右侧切换不会改变已有轻问', async () => {
    state().conversations[rightId].connectionId = 'demo';
    const demoId = createInlineConversation('research-a', source);
    state().conversations[rightId].connectionId = 'model';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ configured: false })));
    vi.stubGlobal('fetch', fetchMock);
    expect((await inlineAIConfig('research-a', demoId)).mode).toBe('demo');
    expect(fetchMock).not.toHaveBeenCalled();
    const modelId = createInlineConversation('research-a', { ...source, quote: 'Another passage' });
    state().conversations[rightId].connectionId = 'demo';
    await expect(inlineAIConfig('research-a', modelId)).rejects.toThrow('请先在设置中配置模型连接');
  });

  it('资料库明确继续回所属研究，切到另一研究的迟到操作被拒绝', () => {
    const id = createInlineConversation('research-a', source);
    workspace.openCollection('documents');
    expect(state().scope.kind).toBe('library');
    continueInlineInPanel(id);
    expect(state().scope).toEqual({ kind: 'research', researchId: 'research-a' });
    expect(state().sessions['research-a'].activeConversationId).toBe(id);
    expect(state().sessions['research-a'].active).toEqual({ kind: 'document', id: 'paper-a' });
    workspace.switchResearch('research-b');
    expect(() => continueInlineInPanel(id)).toThrow('请回到原研究');
    expect(state().scope).toEqual({ kind: 'research', researchId: 'research-b' });
  });

});
