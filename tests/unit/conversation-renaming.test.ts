import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { contentHash, getAsset, loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { hasFullText } from '../../src/domain/knowledge';
import type { AIConnectionId } from '../../src/domain/types';
import { commitCardDraft, submitAI } from '../../src/services/ai';
import { createWorkspaceBackup, readWorkspaceBackup } from '../../src/services/backup';
import { continueInlineInPanel, createInlineCardDraft, createInlineConversation } from '../../src/services/inline-ai';
import { loadPdfDocument } from '../../src/services/pdf';
import { destinationLabel, researchConversationLists, routeResearchDraft, submitResearchRun } from '../../src/services/research-agent';
import { workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', async importOriginal => ({ ...await importOriginal<typeof import('../../src/data/storage')>(),
  loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn().mockResolvedValue(undefined), getAsset: vi.fn() }));
vi.mock('../../src/services/pdf', () => ({ loadPdfDocument: vi.fn() }));
const primary = 'conversation-research-a', researchId = 'research-a';
const state = () => workspace.getState().data;
let assets: Map<string, Blob>;

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  const seed = createSeed(); assets = new Map();
  for (const document of Object.values(seed.documents)) if (hasFullText(document)) {
    const blob = new Blob([`%PDF-1.7\nsynthetic rename fixture ${document.id}`], { type: 'application/pdf' });
    document.hash = await contentHash(await blob.arrayBuffer()); assets.set(document.assetId, blob);
  }
  seed.sessions[researchId].activeConversationId = primary;
  seed.conversations[primary].connectionId = 'codex';
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(seed);
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  vi.mocked(getAsset).mockReset().mockImplementation(async id => assets.get(id));
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('会话手动命名', () => {
  it('所有助手及原生关联的会话均可改名，不切会话、不改输入或原生关联', () => {
    for (const connectionId of ['codex', 'claude', 'opencode', 'model', 'demo'] as AIConnectionId[]) {
      workspace.updateData(data => { Object.assign(data.conversations[primary], { connectionId, nativeSessionRef: 'local-native-reference', input: '保留的未发送输入' }); });
      const before = structuredClone(state());
      workspace.renameConversation(primary, `${connectionId} 的自定义名称`);
      expect(state().conversations[primary]).toEqual({ ...before.conversations[primary], title: `${connectionId} 的自定义名称`, titleEdited: true });
      expect(state().sessions).toEqual(before.sessions);
      expect(state().conversations['conversation-research-b']).toEqual(before.conversations['conversation-research-b']);
    }
  });

  it('原文讨论改名仅更新会话名称，问答、草稿、卡片provenance和锚点保持原快照', async () => {
    const id = createInlineConversation(researchId, { documentId: 'paper-a', pageIndex: 0, quote: 'A selected original passage for the renaming fixture.' });
    const requestId = await submitAI(researchId, id, '原始问题', async request => ({ body: '原始回答 [1]', evidenceIds: [request.context[0].evidenceId] }), { paperBrief: 'none' });
    const draftId = createInlineCardDraft(requestId), cardId = commitCardDraft(draftId);
    continueInlineInPanel(id);
    workspace.updateData(data => { data.conversations[id].input = '后续未发送草稿'; });
    const before = structuredClone(state());
    workspace.renameConversation(id, '我对原文的理解');
    expect(state().conversations[id]).toEqual({ ...before.conversations[id], title: '我对原文的理解', titleEdited: true });
    expect(state().sessions).toEqual(before.sessions);
    expect(state().requests).toEqual(before.requests); expect(state().evidence).toEqual(before.evidence);
    expect(state().cardDrafts).toEqual(before.cardDrafts); expect(state().cards).toEqual(before.cards);
    expect(state().cards[cardId].provenance?.conversationTitle).toBe(before.cards[cardId].provenance?.conversationTitle);
  });

  it('名称去首尾空白并限制120字符，空名、缺失和已删除会话拒绝且不污染数据', () => {
    workspace.renameConversation(primary, `  ${'命名'.repeat(80)}  `);
    expect(state().conversations[primary].title).toBe('命名'.repeat(60));
    const before = structuredClone(state());
    expect(() => workspace.renameConversation(primary, ' \n\t ')).toThrow(/不能为空/);
    expect(() => workspace.renameConversation('missing', '名称')).toThrow(/不存在/);
    expect(state()).toEqual(before);
    workspace.deleteConversation(primary);
    const deleted = structuredClone(state());
    expect(() => workspace.renameConversation(primary, '不应改名')).toThrow(/已删除/);
    expect(state()).toEqual(deleted);
  });

  it('普通AI首条提问不会覆盖用户手动填写的“新会话”', async () => {
    workspace.renameConversation(primary, '新会话');
    const requestId = await submitAI(researchId, primary, '这条问题不能成为新标题', async () => ({ body: '确定性回答', evidenceIds: [] }), { paperBrief: 'none' });
    expect(state().requests[requestId].status).toBe('done');
    expect(state().conversations[primary]).toMatchObject({ title: '新会话', titleEdited: true, requestIds: [requestId] });
  });

  it('研究Agent首条提问也保留手动“新会话”，仍正常登记回答', async () => {
    workspace.updateData(data => { data.researches[researchId].documentIds = ['paper-a']; data.researches[researchId].cardIds = []; });
    vi.mocked(loadPdfDocument).mockResolvedValue({ hash: state().documents['paper-a'].hash,
      pdf: { numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'Synthetic research text.' }] }) }) } } as never);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).includes('capabilities')
      ? new Response(JSON.stringify({ connections: [{ id: 'codex', research: true }] }))
      : new Response([{ type: 'delta', text: '受控研究回答' }, { type: 'done', model: 'rename-fixture', readPages: [] }].map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } })));
    workspace.renameConversation(primary, '新会话');
    const requestId = await submitResearchRun(researchId, '第一条研究问题，不应代替手动名');
    expect(state().requests[requestId]).toMatchObject({ status: 'done', conversationId: primary, body: '受控研究回答' });
    expect(state().conversations[primary]).toMatchObject({ title: '新会话', titleEdited: true });
  });

  it('卡片讨论显示自定义名、可按名搜索，转到新锚定讨论继续保留名称编辑状态', () => {
    workspace.updateData(data => { Object.assign(data.conversations[primary], { anchor: { kind: 'card', id: 'card-a' }, title: '卡片的默认名称', input: '讨论中的草稿' }); });
    const card = structuredClone(state().cards['card-a']);
    workspace.renameConversation(primary, '需要核对的适用条件');
    const groups = researchConversationLists(state(), researchId, '需要核对的适用条件').discussions;
    expect(groups.flatMap(group => group.items).map(item => item.label)).toContain('需要核对的适用条件');
    expect(destinationLabel(state(), state().conversations[primary])).toBe('会话「需要核对的适用条件」');
    const nextId = routeResearchDraft(researchId, 'new');
    expect(state().conversations[nextId]).toMatchObject({ title: '需要核对的适用条件', titleEdited: true, anchor: { kind: 'card', id: 'card-a' }, input: '讨论中的草稿' });
    expect(state().cards['card-a']).toEqual(card);
  });

  it('保存重新加载、迁移和真实ZIP往返保留手动标题及标记，旧记录保持兼容', async () => {
    workspace.renameConversation(primary, '保存后的研究讨论'); await workspace.flushSave();
    const persisted = structuredClone(vi.mocked(saveWorkspace).mock.calls.at(-1)![0]);
    expect(migrateWorkspace(persisted).conversations[primary]).toMatchObject({ title: '保存后的研究讨论', titleEdited: true });
    expect(migrateWorkspace(createSeed()).conversations[primary].titleEdited).toBeUndefined();
    vi.mocked(loadWorkspace).mockResolvedValue(persisted); await workspace.load();
    expect(state().conversations[primary]).toMatchObject({ title: '保存后的研究讨论', titleEdited: true });
    const zip = await createWorkspaceBackup(state(), [...assets].map(([id, blob]) => ({ id, blob })));
    const backup = await readWorkspaceBackup(zip);
    expect(backup.data.conversations[primary]).toEqual(state().conversations[primary]);
    expect(backup.assets).toHaveLength(assets.size);
  });

  it.each(['true', 1, null, {}])('迁移拒绝损坏的titleEdited字段 %j', value => {
    const seed = createSeed();
    Object.assign(seed.conversations[primary], { titleEdited: value });
    expect(() => migrateWorkspace(seed)).toThrow(/会话名称编辑状态/);
  });
});
