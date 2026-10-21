import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { contentHash, loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { boardSnapshot, captureBoardContext, parseBoardPlan, recordBoardChanges } from '../../src/domain/board-history';
import type { BoardPlan, ContextSnapshot, ResourceRef } from '../../src/domain/types';
import { applyBoardProposal, boardChanges, canAutoApplyBoardProposal, createChatBoardContext, restoreBoardChange, undoBoardCreation } from '../../src/services/board-history';
import { createWorkspaceBackup, readWorkspaceBackup, type BackupAsset } from '../../src/services/backup';
import { researchFileData } from '../../src/services/project-files';
import { workspace } from '../../src/services/workspace';
import { paneGroups } from '../../src/services/panes';
import { openBoardResearch } from '../../src/services/board-research';

vi.mock('../../src/data/storage', async importOriginal => ({ ...await importOriginal<object>(), loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn() }));
const data = () => workspace.getState().data;
let assets: BackupAsset[];
beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  const seed = createSeed(); assets = [];
  for (const doc of Object.values(seed.documents)) if (doc.assetId) {
    const blob = new Blob([`%PDF-1.7\n${doc.id}`], { type: 'application/pdf' });
    doc.hash = await contentHash(await blob.arrayBuffer()); assets.push({ id: doc.assetId, blob });
  }
  vi.mocked(loadWorkspace).mockResolvedValue(seed); await workspace.load();
  expect(workspace.getState().loadError).toBeUndefined();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function request() {
  const context = createChatBoardContext(data(), 'research-a', ['evidence-a']);
  const evidence = data().evidence['evidence-a'], doc = data().documents[evidence.documentId];
  const source: ContextSnapshot = { evidenceId: evidence.id, documentId: doc.id, documentHash: doc.hash!, title: doc.title, pageIndex: evidence.pageIndex, quote: evidence.quote };
  const plan: BoardPlan = { summary: '把讨论中的两步画出来', title: '对话流程草稿', layout: 'flow', nodes: [
    { card: { title: '依据', body: '需要核查的观点 [1]', evidenceIds: ['evidence-a'] }, group: '材料' },
    { card: { title: '下一步', body: '进一步验证', evidenceIds: [] }, group: '行动' },
  ], edges: [{ from: 0, to: 1, label: '验证' }] };
  workspace.updateData(next => { next.requests.create = { id: 'create', researchId: 'research-a', conversationId: 'conversation-research-a', connectionId: 'codex', prompt: '把讨论画成流程图', body: plan.summary, createdAt: new Date().toISOString(), context: [source], evidenceIds: [], status: 'done', purpose: 'chat', boardContext: context, boardProposal: plan }; });
  return { context, plan };
}

describe('对话创建白板的事务与撤销', () => {
  it('虚拟目标不写库；完成后同批保存卡片、引用和历史，切研究也不跳转', async () => {
    const before = structuredClone(data());
    const virtual = createChatBoardContext(data(), 'research-a', []);
    expect(virtual.intent).toBe('create'); expect(data()).toEqual(before);
    const { context } = request(); workspace.switchResearch('research-b');
    const session = structuredClone(data().sessions['research-b']);
    expect(canAutoApplyBoardProposal('create')).toBe(true);
    const changeId = await applyBoardProposal('create'), change = data().boardChanges![changeId];
    expect(data().scope).toEqual({ kind: 'research', researchId: 'research-b' });
    expect(data().sessions['research-b']).toEqual(session);
    expect(change).toMatchObject({ before: null, boardId: context.boardId, requestId: 'create', revision: 1 });
    expect(change.createdCards).toHaveLength(2);
    for (const card of change.createdCards!) {
      expect(data().cards[card.id]).toEqual(card);
      expect(card).toMatchObject({ needsReview: true, provenance: { researchId: 'research-a', requestId: 'create', context: data().requests.create.context } });
      expect(data().researches['research-a'].cardIds).toContain(card.id);
    }
    for (const id of Object.keys(before.cards)) expect(data().cards[id]).toEqual(before.cards[id]);
    expect(boardSnapshot(data(), 'board-a')).toEqual(boardSnapshot(before, 'board-a'));
    expect(vi.mocked(saveWorkspace).mock.calls.at(-1)![0].boardChanges?.[changeId].createdCards).toEqual(change.createdCards);
    expect(migrateWorkspace(data()).boardChanges).toEqual(data().boardChanges);
  });

  it.each(['quote', 'hash', 'membership', 'unauthorized', 'citation'])('%s变动拒绝整批应用，不能留下空白板或半批卡片', async mutation => {
    request(); workspace.updateData(next => {
      if (mutation === 'quote') next.evidence['evidence-a'].quote += 'changed';
      if (mutation === 'hash') next.documents['paper-a'].hash = 'f'.repeat(64);
      if (mutation === 'membership') next.researches['research-a'].documentIds = [];
      if (mutation === 'unauthorized') next.requests.create.boardProposal!.nodes[0].card!.evidenceIds = ['evidence-b'];
      if (mutation === 'citation') next.requests.create.boardProposal!.nodes[0].card!.body = '越界引用 [2]';
    });
    const before = structuredClone(data()); await expect(applyBoardProposal('create')).rejects.toThrow(); expect(data()).toEqual(before);
  });

  it('保存失败重试复用同一批实体和历史，成功后清除错误', async () => {
    const { context } = request(); vi.mocked(saveWorkspace).mockRejectedValue(new Error('磁盘已满'));
    await expect(applyBoardProposal('create')).rejects.toThrow('磁盘已满');
    const cards = structuredClone(data().cards), snapshot = boardSnapshot(data(), context.boardId);
    workspace.updateData(next => { next.requests.create.boardApplyError = '磁盘已满'; });
    vi.mocked(saveWorkspace).mockResolvedValue(undefined); await applyBoardProposal('create');
    expect(data().cards).toEqual(cards); expect(boardSnapshot(data(), context.boardId)).toEqual(snapshot);
    expect(boardChanges(data(), context.boardId)).toHaveLength(1); expect(data().requests.create.boardApplyError).toBeUndefined();
  });

  it('对话生成白板卡片也保留当前及所选历史的摘要快照和派生出处', async () => {
    request();
    workspace.updateData(next => {
      const material = { id: 'abstract:current', kind: 'abstract' as const, title: '当前题录', text: '当前来源摘要', version: 'v1', url: 'https://example.org/current', derivedFrom: { sourceIds: ['abstract:ancestor'], requestIds: ['ancestor-request'] } };
      const historical = { ...material, id: 'abstract:history', title: '历史题录', text: '提交时历史摘要', derivedFrom: undefined };
      next.requests.create.materials = [material];
      next.requests.create.history = [{ requestId: 'history-request', prompt: '此前问题', body: '此前回答', evidenceIds: [], context: [], materials: [historical] }];
    });
    const changeId = await applyBoardProposal('create');
    const created = data().boardChanges![changeId].createdCards!;
    for (const card of created) {
      expect(card.provenance?.materials?.map(item => item.id)).toEqual(['abstract:history', 'abstract:current']);
      expect(card.provenance?.context).toEqual(data().requests.create.context);
      expect(card.provenance?.derivedFrom?.sourceIds).toEqual(expect.arrayContaining(['evidence:evidence-a', 'abstract:history', 'abstract:current', 'abstract:ancestor']));
      expect(card.provenance?.derivedFrom?.requestIds).toEqual(expect.arrayContaining(['create', 'history-request', 'ancestor-request']));
    }
    workspace.updateData(next => { next.requests.create.materials![0].text = '后来修改的摘要'; });
    expect(data().cards[created[0].id].provenance?.materials?.[1].text).toBe('当前来源摘要');
    const backup = await readWorkspaceBackup(await createWorkspaceBackup(data(), assets));
    expect(backup.data.cards[created[0].id].provenance).toEqual(created[0].provenance);
    expect(backup.data.boardChanges![changeId].createdCards).toEqual(created);
  });

  it('撤销清理各会话入口及未复用卡片，档案可备份、导出、刷新和恢复', async () => {
    const { context } = request(); const creationId = await applyBoardProposal('create');
    const cards = data().boardChanges![creationId].createdCards!, cardId = cards[0].id;
    workspace.updateData(next => {
      for (const session of Object.values(next.sessions)) {
        const refs: ResourceRef[] = [{ kind: 'board', id: context.boardId }, { kind: 'card', id: cardId }];
        session.active = refs[0]; session.openItems.push(...refs); session.history.push(...refs); session.recentItems = refs;
        session.pinnedIds.push(context.boardId, cardId); session.viewports[context.boardId] = { x: 1, y: 2, scale: 1 };
        session.panel.ref = refs[1]; session.panel.history = refs; session.panel.sourceReturnRef = refs[0]; session.panel.findEvidenceFor = cardId;
      }
      next.conversations['conversation-research-a'].input = '未发送的输入';
      next.conversations['conversation-research-a'].boardSkill = { boardId: context.boardId, scope: 'board' };
    });
    workspace.setSelection({ scope: data().scope, viewInstanceId: `board:${context.boardId}`, selectedItems: [{ resourceRef: { kind: 'card', id: cardId } }], evidenceIds: [] });
    await undoBoardCreation('create');
    expect(data().boards[context.boardId]).toBeUndefined(); expect(workspace.getState().selection).toBeUndefined();
    cards.forEach(card => expect(data().cards[card.id]).toBeUndefined());
    for (const session of Object.values(data().sessions)) {
      expect(JSON.stringify(session)).not.toContain(context.boardId); expect(JSON.stringify(session)).not.toContain(cardId);
    }
    expect(data().conversations['conversation-research-a']).toMatchObject({ input: '未发送的输入' });
    expect(data().conversations['conversation-research-a'].boardSkill).toBeUndefined();
    const exported = researchFileData(data(), 'research-a');
    expect(exported.cards[cardId]).toBeUndefined(); expect(exported.archivedCards[cardId]).toEqual(cards[0]);
    expect(exported.evidence['evidence-a']).toBeDefined();
    const backup = await readWorkspaceBackup(await createWorkspaceBackup(data(), assets));
    expect(backup.data.boardChanges).toEqual(data().boardChanges);
    vi.mocked(loadWorkspace).mockResolvedValue(backup.data); await workspace.load();
    const deletion = boardChanges(data(), context.boardId)[0];
    expect(deletion).toMatchObject({ restores: creationId, after: null, revision: 2 });
    await restoreBoardChange(deletion.id);
    expect(data().boards[context.boardId]).toBeDefined(); expect(data().cards[cardId]).toEqual(cards[0]);
    expect(boardChanges(data(), context.boardId)).toHaveLength(3);
    await readWorkspaceBackup(await createWorkspaceBackup(data(), assets));
  });

  it.each(['edit', 'other-research', 'other-board', 'draft', 'historical-board', 'local-discussion'])('撤销保留已%s的卡片', async kind => {
    request(); const creationId = await applyBoardProposal('create'), card = data().boardChanges![creationId].createdCards![0];
    workspace.updateData(next => {
      if (kind === 'edit') next.cards[card.id].body += '人工编辑';
      if (kind === 'other-research') { next.researches['research-b'].cardIds.push(card.id); next.researches['research-b'].documentIds.push('paper-a'); }
      if (kind === 'other-board' || kind === 'historical-board') next.placements.reuse = { id: 'reuse', boardId: 'board-a2', resourceRef: { kind: 'card', id: card.id }, x: 0, y: 0, group: '' };
      if (kind === 'draft') next.drafts['draft-a'].cardRefs = [{ cardId: card.id, insertedAt: new Date().toISOString() }];
    });
    if (kind === 'historical-board') workspace.updateData(next => { delete next.placements.reuse; });
    if (kind === 'local-discussion') {
      const placement = Object.values(data().placements).find(item => item.resourceRef.kind === 'card' && item.resourceRef.id === card.id)!;
      openBoardResearch({ boardId: placement.boardId, placementIds: [placement.id], mode: 'ask' });
    }
    const preserved = structuredClone(data().cards[card.id]); await undoBoardCreation('create'); expect(data().cards[card.id]).toEqual(preserved);
    await readWorkspaceBackup(await createWorkspaceBackup(data(), assets));
  });

  it('撤销保存失败可以重试，后续编辑阻止撤销创建', async () => {
    const { context } = request(); await applyBoardProposal('create');
    vi.mocked(saveWorkspace).mockRejectedValue(new Error('磁盘已满')); await expect(undoBoardCreation('create')).rejects.toThrow('磁盘已满');
    vi.mocked(saveWorkspace).mockResolvedValue(undefined); await undoBoardCreation('create'); expect(boardChanges(data(), context.boardId)).toHaveLength(2);
    await restoreBoardChange(boardChanges(data(), context.boardId)[0].id);
    const before = structuredClone(data()); await expect(undoBoardCreation('create')).rejects.toThrow('后续修改'); expect(data()).toEqual(before);
  });

  it('撤销清理新版窗格及视图选区，保留另一窗格的独立阅读位置', async () => {
    const { context } = request(); await applyBoardProposal('create');
    workspace.updateData(next => {
      const session = next.sessions['research-a'];
      session.layout = { version: 2, focusedPaneId: 'generated-pane', zoomedPaneId: 'generated-pane', root: {
        kind: 'split', id: 'split-preview', axis: 'row', ratio: .6,
        first: { kind: 'group', id: 'reading-pane', activeTabId: 'reading-view', tabs: [{ id: 'reading-view', ref: { kind: 'document', id: 'paper-a' }, reading: { pageIndex: 1, scale: 1.5, offset: .4 } }] },
        second: { kind: 'group', id: 'generated-pane', activeTabId: 'generated-view', history: ['generated-view'], recentTabIds: ['generated-view'], tabs: [{ id: 'generated-view', ref: { kind: 'board', id: context.boardId } }] },
      } };
      session.active = { kind: 'board', id: context.boardId };
    });
    workspace.setSelection({ scope: data().scope, viewInstanceId: 'view:generated-view', selectedItems: [], evidenceIds: [] });
    await undoBoardCreation('create');
    expect(workspace.getState().selection).toBeUndefined();
    expect(data().sessions['research-a'].layout).toMatchObject({ focusedPaneId: 'reading-pane', root: { kind: 'group', id: 'reading-pane' } });
    expect(data().sessions['research-a'].layout!.zoomedPaneId).toBeUndefined();
    expect(paneGroups(data().sessions['research-a'].layout!.root)[0].tabs[0].reading).toEqual({ pageIndex: 1, scale: 1.5, offset: .4 });
    expect(migrateWorkspace(data()).sessions['research-a'].layout).toEqual(data().sessions['research-a'].layout);
  });

  it('恢复不能覆盖仍存在的卡片，也不能绕过来源或研究关联校验', async () => {
    const { context } = request(); const created = await applyBoardProposal('create'), card = data().boardChanges![created].createdCards![0];
    await undoBoardCreation('create'); const deletion = boardChanges(data(), context.boardId)[0];
    workspace.updateData(next => { next.documents['paper-a'].hash = 'b'.repeat(64); });
    const before = structuredClone(data()); await expect(restoreBoardChange(deletion.id)).rejects.toThrow('来源已改变'); expect(data()).toEqual(before);
    workspace.updateData(next => { next.documents['paper-a'].hash = card.provenance!.context[0].documentHash; next.cards[card.id] = { ...card, body: '后来独立编辑的正文' }; });
    await expect(restoreBoardChange(deletion.id)).rejects.toThrow('重新关联');
    workspace.updateData(next => { next.researches['research-a'].cardIds.push(card.id); }); await restoreBoardChange(deletion.id);
    expect(data().cards[card.id].body).toBe('后来独立编辑的正文');
  });

  it('自动应用按保留旧节点和旧关系判断，换标签或删节点都需预览', () => {
    const context = captureBoardContext(data(), 'research-a', 'board-a', 'board');
    const nodes: BoardPlan['nodes'] = context.snapshot.placements.map(p => ({ placementId: p.id, resourceRef: context.resources.find(r => r.ref.kind === p.resourceRef.kind && r.ref.id === p.resourceRef.id)!.ref, group: p.group }));
    const edges = context.snapshot.edges.map(e => ({ from: nodes.findIndex(n => n.placementId === e.fromPlacementId), to: nodes.findIndex(n => n.placementId === e.toPlacementId), label: e.label }));
    const plan: BoardPlan = { summary: '整理位置', title: context.snapshot.board.title, layout: 'preserve', nodes, edges };
    request(); workspace.updateData(next => { next.requests.create.boardContext = context; next.requests.create.boardProposal = plan; });
    expect(canAutoApplyBoardProposal('create')).toBe(true);
    workspace.updateData(next => { next.requests.create.boardProposal!.nodes[0].group = '人工分组被改变'; });
    expect(canAutoApplyBoardProposal('create')).toBe(false);
    workspace.updateData(next => { next.requests.create.boardProposal!.nodes[0].group = context.snapshot.placements[0].group; });
    workspace.updateData(next => { next.requests.create.boardProposal!.layout = 'flow'; }); expect(canAutoApplyBoardProposal('create')).toBe(false);
    workspace.updateData(next => { next.requests.create.boardProposal!.layout = 'preserve'; });
    workspace.updateData(next => { next.requests.create.boardProposal!.edges[0].label = '语义已变'; }); expect(canAutoApplyBoardProposal('create')).toBe(false);
    workspace.updateData(next => { next.requests.create.boardProposal = { ...plan, nodes: nodes.slice(1), edges: [] }; }); expect(canAutoApplyBoardProposal('create')).toBe(false);
  });

  it('人工同时创建卡片和摆放保持兼容；新建空图及注入ID被拒绝', () => {
    const before = createSeed(), next = structuredClone(before);
    next.cards.manual = { id: 'manual', title: '人工卡片', body: '', evidenceIds: [], needsReview: true };
    next.placements.manual = { id: 'manual', boardId: 'board-a', resourceRef: { kind: 'card', id: 'manual' }, x: 0, y: 0, group: '' };
    recordBoardChanges(before, next); expect(migrateWorkspace(next)).toBeDefined();
    const { context, plan } = request();
    expect(() => parseBoardPlan(JSON.stringify({ ...plan, nodes: [], edges: [] }), context)).toThrow('为空');
    expect(() => parseBoardPlan(JSON.stringify({ ...plan, nodes: [{ card: { title: 'X', body: 'X', evidenceIds: ['__proto__'] }, group: '' }] }), context)).toThrow();
  });
});
