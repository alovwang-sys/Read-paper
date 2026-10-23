import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { contentHash, getAsset, loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { hasFullText } from '../../src/domain/knowledge';
import type { AIRequest, NativeRunState } from '../../src/domain/types';
import { commitCardDraft, submitAI } from '../../src/services/ai';
import { createWorkspaceBackup, readWorkspaceBackup } from '../../src/services/backup';
import { continueInlineInPanel, createInlineCardDraft, createInlineConversation, findInlineConversation } from '../../src/services/inline-ai';
import { getActiveConversation, workspace } from '../../src/services/workspace';
import { drawingPng, drawingQuestionFixture } from '../fixtures/drawing-question';

vi.mock('../../src/data/storage', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/data/storage')>(),
  loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn().mockResolvedValue(undefined), getAsset: vi.fn(),
}));

const primary = 'conversation-research-a';
const state = () => workspace.getState().data;
const source = { documentId: 'paper-a', pageIndex: 0, quote: 'A passage retained after deleting its conversation.' };
let assets: Map<string, Blob>;

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  assets = new Map();
  const seed = createSeed();
  for (const doc of Object.values(seed.documents)) if (hasFullText(doc)) {
    const blob = new Blob([`%PDF-1.7\nsynthetic deletion fixture ${doc.id}`], { type: 'application/pdf' });
    doc.hash = await contentHash(await blob.arrayBuffer()); assets.set(doc.assetId, blob);
  }
  seed.sessions['research-a'].activeConversationId = primary;
  seed.conversations[primary].connectionId = 'codex';
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(seed);
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  vi.mocked(getAsset).mockReset().mockImplementation(async id => assets.get(id));
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function doneRequest(id = 'deletion-request'): AIRequest {
  return { id, researchId: 'research-a', conversationId: primary, prompt: '保留的问题', body: '保留的回答',
    context: [], evidenceIds: [], status: 'done', createdAt: '2026-10-23T00:00:00Z' };
}

describe('可恢复的会话删除', () => {
  it('删除当前会话回落到同研究的可用会话，不改变资源、阅读位置或其他研究', () => {
    const sibling = workspace.createConversation('research-a');
    workspace.selectConversation('research-a', primary);
    workspace.openResource({ kind: 'document', id: 'paper-a' }, { target: 'main', scope: { kind: 'research', researchId: 'research-a' } });
    workspace.setReader('paper-a', { pageIndex: 1, scale: 1.25 });
    const before = structuredClone(state().sessions['research-a']);
    const other = structuredClone(state().sessions['research-b']);
    workspace.deleteConversation(primary);
    expect(state().conversations[primary]).toMatchObject({ archived: true, deletedAt: expect.any(String) });
    expect(state().sessions['research-a'].activeConversationId).toBe(sibling);
    expect(state().sessions['research-a'].active).toEqual(before.active);
    expect(state().sessions['research-a'].layout).toEqual(before.layout);
    expect(state().sessions['research-a'].readers).toEqual(before.readers);
    expect(state().sessions['research-b']).toEqual(other);
  });

  it('删除最后可用会话生成同助手的空会话，重复删除不再创建，普通入口不能复活', () => {
    workspace.updateData(data => { data.conversations[primary].input = '尚未发送的草稿'; });
    workspace.deleteConversation(primary);
    const next = workspace.getActiveConversation('research-a');
    expect(next.id).not.toBe(primary); expect(next.researchId).toBe('research-a');
    expect(next.connectionId).toBe('codex'); expect(next.requestIds).toEqual([]);
    const ids = Object.keys(state().conversations);
    workspace.deleteConversation(primary);
    expect(Object.keys(state().conversations)).toEqual(ids);
    expect(() => workspace.selectConversation('research-a', primary)).toThrow(/已删除/);
    expect(() => workspace.archiveConversation(primary, false)).toThrow(/已删除/);
    expect(getActiveConversation(state(), 'research-a')?.id).toBe(next.id);
    expect(state().conversations[primary].input).toBe('尚未发送的草稿');
    expect(state().conversations[primary].deletedAt).toBeTruthy();
  });

  it('删除和恢复保留历史、可编辑卡片草稿、卡片来源、附件、绘图快照与未发送输入', async () => {
    const id = createInlineConversation('research-a', source);
    continueInlineInPanel(id);
    const requestId = await submitAI('research-a', id, '解释这一段', async request => ({ body: '原文的解释 [1]', evidenceIds: [request.context[0].evidenceId] }), { paperBrief: 'none' });
    const draftId = createInlineCardDraft(requestId), cardId = commitCardDraft(draftId);
    const question = await drawingQuestionFixture(), hash = await contentHash(await drawingPng.arrayBuffer());
    assets.set(question.snapshot.image.assetId, drawingPng);
    workspace.updateData(data => {
      data.conversations[id].input = '恢复后继续编辑的输入';
      data.conversations[id].drawingQuestion = question;
      data.conversations[id].chatImages = [{ assetId: question.snapshot.image.assetId, hash, name: 'synthetic.png', mimeType: 'image/png', size: drawingPng.size }];
      data.conversations[id].researchFocus = { ref: { kind: 'card', id: cardId }, title: '讨论的卡片', body: '显式背景' };
      data.cardDrafts['editable-copy'] = { ...structuredClone(data.cardDrafts[draftId]), id: 'editable-copy', status: 'editing', cardId: undefined, body: '未保存卡片草稿' };
    });
    const original = structuredClone(state());
    workspace.deleteConversation(id);
    expect(state().requests).toEqual(original.requests);
    expect(state().cardDrafts).toEqual(original.cardDrafts);
    expect(state().cards).toEqual(original.cards);
    expect(state().evidence).toEqual(original.evidence);
    expect(await getAsset(question.snapshot.image.assetId)).toBe(drawingPng);
    expect(state().conversations[id]).toEqual({ ...original.conversations[id], archived: true, deletedAt: expect.any(String) });
    workspace.restoreDeletedConversation(id);
    workspace.selectConversation('research-a', id);
    expect(state().conversations[id]).toEqual({ ...original.conversations[id], archived: false });
    expect(state().cards[cardId].provenance?.requestId).toBe(requestId);
    expect(state().cardDrafts['editable-copy'].body).toBe('未保存卡片草稿');
  });

  it.each<NativeRunState>(['running', 'waiting-input', 'compacting', 'stopping', 'unknown'])('managed %s 尚未终止，即使外层done也拒绝删除', nativeState => {
    const request = doneRequest();
    request.nativeRun = { managed: true, cursor: 1, delivery: 'accepted', state: nativeState, transport: 'offline', items: [] };
    workspace.updateData(data => { data.requests[request.id] = request; data.conversations[primary].requestIds = [request.id]; });
    const before = structuredClone(state());
    expect(() => workspace.deleteConversation(primary)).toThrow(/任务进行中/);
    expect(state()).toEqual(before);
  });

  it.each(['completed', 'failed', 'interrupted'] as const)('managed %s 已终止允许删除', nativeState => {
    const request = doneRequest();
    request.nativeRun = { managed: true, cursor: 1, delivery: 'accepted', state: nativeState, transport: 'offline', items: [] };
    workspace.updateData(data => { data.requests[request.id] = request; data.conversations[primary].requestIds = [request.id]; });
    workspace.deleteConversation(primary);
    expect(state().conversations[primary].deletedAt).toBeTruthy();
    expect(state().requests[request.id]).toEqual(request);
  });

  it('生成中的请求、原生busy和卡片生成分别拒绝删除且不改数据', async () => {
    const request = doneRequest(); request.status = 'generating';
    workspace.updateData(data => { data.requests[request.id] = request; data.conversations[primary].requestIds = [request.id]; });
    expect(() => workspace.deleteConversation(primary)).toThrow(/任务进行中/);
    workspace.updateData(data => { data.requests[request.id].status = 'done'; data.conversations[primary].nativeState = 'busy'; });
    expect(() => workspace.deleteConversation(primary)).toThrow(/任务进行中/);
    const id = createInlineConversation('research-a', source);
    const answerId = await submitAI('research-a', id, '生成卡片', async request => ({ body: '解释 [1]', evidenceIds: [request.context[0].evidenceId] }), { paperBrief: 'none' });
    const draftId = createInlineCardDraft(answerId);
    workspace.updateData(data => { data.cardDrafts[draftId].status = 'generating'; });
    const before = structuredClone(state());
    expect(() => workspace.deleteConversation(id)).toThrow(/任务进行中/);
    expect(state()).toEqual(before);
  });

  it('资产准备阶段删除后不登记请求、不调用模型，也不清空草稿', async () => {
    const id = createInlineConversation('research-a', source);
    workspace.updateData(data => { data.conversations[id].input = '准备时删除，保留原输入'; });
    let release!: (blob: Blob) => void;
    vi.mocked(getAsset).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const responder = vi.fn(async () => ({ body: '不应调用', evidenceIds: [] }));
    const requests = Object.keys(state().requests);
    const pending = submitAI('research-a', id, '准备时删除，保留原输入', responder, { paperBrief: 'none' });
    const rejected = expect(pending).rejects.toThrow(/会话已删除/);
    await vi.waitFor(() => expect(release).toBeDefined());
    workspace.deleteConversation(id);
    const document = state().documents['paper-a'];
    if (!hasFullText(document)) throw new Error('测试 PDF 必须存在');
    release(assets.get(document.assetId)!);
    await rejected;
    expect(responder).not.toHaveBeenCalled();
    expect(Object.keys(state().requests)).toEqual(requests);
    expect(state().conversations[id].input).toBe('准备时删除，保留原输入');
  });

  it('删除的就地会话不被自动发现；再次提问新建记录，显式恢复后可找回原历史', () => {
    const id = createInlineConversation('research-a', source);
    workspace.updateData(data => { data.conversations[id].input = '旧位置的私有草稿'; });
    workspace.deleteConversation(id);
    expect(findInlineConversation('research-a', source)).toBeUndefined();
    const next = createInlineConversation('research-a', source);
    expect(next).not.toBe(id); expect(state().conversations[id].deletedAt).toBeTruthy();
    workspace.restoreDeletedConversation(id);
    expect(state().conversations[id].input).toBe('旧位置的私有草稿');
    expect(state().conversations[id].inlineSource).toEqual(state().conversations[next].inlineSource);
  });

  it('保存刷新、迁移和真实ZIP备份往返保留删除墓碑与请求，恢复只解除指定记录', async () => {
    workspace.updateData(data => {
      const request = doneRequest(); data.requests[request.id] = request;
      data.conversations[primary].requestIds = [request.id]; data.conversations[primary].input = '备份保留草稿';
    });
    workspace.deleteConversation(primary); await workspace.flushSave();
    const persisted = structuredClone(vi.mocked(saveWorkspace).mock.calls.at(-1)![0]);
    const deletedAt = persisted.conversations[primary].deletedAt;
    expect(migrateWorkspace(persisted).conversations[primary]).toMatchObject({ archived: true, deletedAt });
    vi.mocked(loadWorkspace).mockResolvedValue(persisted); await workspace.load();
    expect(state().conversations[primary].deletedAt).toBe(deletedAt);
    expect(getActiveConversation(state(), 'research-a')?.id).not.toBe(primary);
    const zip = await createWorkspaceBackup(state(), [...assets].map(([id, blob]) => ({ id, blob })));
    const restored = await readWorkspaceBackup(zip);
    expect(restored.data.conversations[primary]).toEqual(state().conversations[primary]);
    expect(restored.data.requests).toEqual(state().requests);
    expect(restored.assets).toHaveLength(assets.size);
    workspace.restoreDeletedConversation(primary);
    expect(state().conversations[primary]).toMatchObject({ archived: false, input: '备份保留草稿', requestIds: ['deletion-request'] });
    expect(state().conversations[primary].deletedAt).toBeUndefined();
  });
});
