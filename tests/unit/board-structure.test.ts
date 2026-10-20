import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { contentHash, loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { boardSnapshot } from '../../src/domain/board-history';
import { boardDescendants, orderedBoardSiblings, validateBoardStructure } from '../../src/domain/board-structure';
import type { BoardPlacement } from '../../src/domain/types';
import { addBoardCard, moveBoardBranch, removeBoardPlacements, reorderBoardPlacement, setBoardLayout } from '../../src/services/board-structure';
import { boardChanges, restoreBoardChange } from '../../src/services/board-history';
import { createWorkspaceBackup, readWorkspaceBackup, type BackupAsset } from '../../src/services/backup';
import { researchFileData } from '../../src/services/project-files';
import { workspace } from '../../src/services/workspace';
import { paneGroups } from '../../src/services/panes';

vi.mock('../../src/data/storage', async importOriginal => ({ ...await importOriginal<object>(), loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn() }));
const data = () => workspace.getState().data;
const items = () => Object.values(data().placements).filter(p => p.boardId === 'board-a');
const siblingIds = (parent?: string) => orderedBoardSiblings(items(), parent).map(p => p.id);
let assets: BackupAsset[];
beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  const seed = createSeed(); assets = [];
  seed.boards['board-a'].layout = 'free';
  Object.assign(seed.placements['placement-a'], { order: 0 });
  Object.assign(seed.placements['placement-b'], { order: 0, parentPlacementId: 'placement-a' });
  Object.assign(seed.placements['placement-c'], { order: 0, parentPlacementId: 'placement-b' });
  for (const [id, parent, order] of [['placement-d', undefined, 1], ['placement-e', 'placement-a', 1], ['placement-f', 'placement-b', 1]] as const)
    seed.placements[id] = { ...seed.placements['placement-c'], id, order, ...(parent ? { parentPlacementId: parent } : {}) };
  delete seed.placements['placement-d'].parentPlacementId;
  for (const doc of Object.values(seed.documents)) if (doc.assetId) {
    const blob = new Blob([`%PDF-1.7\n${doc.id}`], { type: 'application/pdf' });
    doc.hash = await contentHash(await blob.arrayBuffer()); assets.push({ id: doc.assetId, blob });
  }
  vi.mocked(loadWorkspace).mockResolvedValue(seed); await workspace.load();
  expect(workspace.getState().loadError).toBeUndefined();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('人工研究树的共享结构和恢复', () => {
  it('顺序只在同胞内生效，后代集合不包含自身或跨白板复用', () => {
    expect(siblingIds()).toEqual(['placement-a', 'placement-d']);
    expect(siblingIds('placement-a')).toEqual(['placement-b', 'placement-e']);
    expect(boardDescendants(items(), 'placement-b')).toEqual(['placement-c', 'placement-f']);
    expect(boardDescendants(items(), 'placement-a')).not.toContain('placement-a2');
  });
  it.each(['cycle', 'self', 'missing', 'cross-board', 'negative-order', 'fractional-order', 'duplicate'])('结构校验拒绝 %s', kind => {
    const broken: BoardPlacement[] = structuredClone(Object.values(data().placements));
    const a = broken.find(p => p.id === 'placement-a')!;
    if (kind === 'cycle') a.parentPlacementId = 'placement-c';
    if (kind === 'self') a.parentPlacementId = a.id;
    if (kind === 'missing') a.parentPlacementId = 'missing';
    if (kind === 'cross-board') a.parentPlacementId = 'placement-a2';
    if (kind === 'negative-order') a.order = -1;
    if (kind === 'fractional-order') a.order = 0.5;
    if (kind === 'duplicate') broken.push({ ...a });
    expect(() => validateBoardStructure(broken)).toThrow();
  });
  it.each(['cycle', 'cross-board', 'order'])('导入损坏的 %s 层级时拒绝读取且不修改输入', kind => {
    const broken = structuredClone(data());
    if (kind === 'cycle') broken.placements['placement-a'].parentPlacementId = 'placement-c';
    if (kind === 'cross-board') broken.placements['placement-b'].parentPlacementId = 'placement-a2';
    if (kind === 'order') broken.placements['placement-b'].order = -1;
    const before = structuredClone(broken);
    expect(() => migrateWorkspace(broken)).toThrow();
    expect(broken).toEqual(before);
  });
  it('移动整枝只改归属和同胞顺序，不改共享内容或语义关系，一次动作一条历史', () => {
    const before = structuredClone(data());
    moveBoardBranch('board-a', 'placement-b', 'placement-d');
    expect(data().placements['placement-b'].parentPlacementId).toBe('placement-d');
    expect(boardDescendants(items(), 'placement-b')).toEqual(['placement-c', 'placement-f']);
    expect(data().placements['placement-c'].parentPlacementId).toBe('placement-b');
    expect(siblingIds('placement-a')).toEqual(['placement-e']);
    expect(data().cards).toEqual(before.cards); expect(data().edges).toEqual(before.edges);
    expect(boardSnapshot(data(), 'board-a2')).toEqual(boardSnapshot(before, 'board-a2'));
    expect(boardChanges(data(), 'board-a')).toHaveLength(1);
    expect(boardChanges(data(), 'board-a')[0].before).toEqual(boardSnapshot(before, 'board-a'));
  });
  it.each(['placement-b', 'placement-c', 'placement-a2', 'missing'])('拒绝将分支移入无效父节点 %s 并保留全部状态', parent => {
    const before = structuredClone(data());
    expect(() => moveBoardBranch('board-a', 'placement-b', parent)).toThrow();
    expect(data()).toEqual(before);
  });
  it('同胞前移、后移及越界保持，指定错误落点不产生半次写入', () => {
    reorderBoardPlacement('board-a', 'placement-e', -1);
    expect(siblingIds('placement-a')).toEqual(['placement-e', 'placement-b']);
    reorderBoardPlacement('board-a', 'placement-e', 1);
    expect(siblingIds('placement-a')).toEqual(['placement-b', 'placement-e']);
    const before = structuredClone(data());
    reorderBoardPlacement('board-a', 'placement-e', 1);
    expect(data()).toEqual(before);
    expect(() => moveBoardBranch('board-a', 'placement-b', 'placement-a', 'placement-d')).toThrow();
    expect(data()).toEqual(before);
  });
  it('移出中间节点在原位置提升子节点，保留共享卡片并仅清除受影响的关联线', () => {
    const cards = structuredClone(data().cards);
    removeBoardPlacements('board-a', ['placement-b']);
    expect(siblingIds('placement-a')).toEqual(['placement-c', 'placement-f', 'placement-e']);
    expect(data().placements['placement-b']).toBeUndefined();
    expect(data().placements['placement-c'].parentPlacementId).toBe('placement-a');
    expect(data().edges['edge-a']).toBeUndefined(); expect(data().cards).toEqual(cards);
    expect(boardChanges(data(), 'board-a')).toHaveLength(1);
  });
  it('同时移出相邻祖先时提升到最近保留祖先，不丢失同胞相对顺序', () => {
    removeBoardPlacements('board-a', ['placement-a', 'placement-b']);
    expect(siblingIds()).toEqual(['placement-c', 'placement-f', 'placement-e', 'placement-d']);
    expect(items().every(p => p.parentPlacementId === undefined)).toBe(true);
  });
  it('整枝移出只删除摆放和端点连线，跨白板复用及所有卡片保留', () => {
    const before = structuredClone(data());
    removeBoardPlacements('board-a', ['placement-b'], true);
    for (const id of ['placement-b', 'placement-c', 'placement-f']) expect(data().placements[id]).toBeUndefined();
    expect(siblingIds('placement-a')).toEqual(['placement-e']);
    expect(data().cards).toEqual(before.cards); expect(data().placements['placement-a2']).toEqual(before.placements['placement-a2']);
  });
  it('非法移出批次不会先删除其中合法节点', () => {
    const before = structuredClone(data());
    expect(() => removeBoardPlacements('board-a', ['placement-b', 'placement-a2'], true)).toThrow();
    expect(data()).toEqual(before);
  });
  it('新卡片追加到指定同胞末尾，绑定本研究，错误父节点不会留下孤立卡片', () => {
    const id = addBoardCard('board-a', ' 新的评估计划 ', 'placement-a'), p = data().placements[id];
    expect(siblingIds('placement-a')).toEqual(['placement-b', 'placement-e', id]);
    expect(data().cards[p.resourceRef.id]).toMatchObject({ title: '新的评估计划', needsReview: true, evidenceIds: [] });
    expect(data().researches['research-a'].cardIds).toContain(p.resourceRef.id);
    const before = structuredClone(data());
    expect(() => addBoardCard('board-a', '错误父级', 'placement-a2')).toThrow();
    expect(data()).toEqual(before);
  });
  it('切换树布局不把语义边推断为父级，返回自由布局保留明确层级', () => {
    const hierarchy = items().map(p => [p.id, p.parentPlacementId, p.order]), edges = structuredClone(data().edges);
    setBoardLayout('board-a', 'tree');
    expect(data().boards['board-a'].layout).toBe('tree');
    expect(items().map(p => [p.id, p.parentPlacementId, p.order])).toEqual(hierarchy);
    expect(data().edges).toEqual(edges);
    setBoardLayout('board-a', 'free');
    expect(data().boards['board-a'].layout).toBe('free');
    expect(items().map(p => [p.id, p.parentPlacementId, p.order])).toEqual(hierarchy);
    expect(boardChanges(data(), 'board-a')).toHaveLength(2);
  });
  it('旧平面白板切换树布局仍保留所有根节点，不把已有语义边当作父子关系', () => {
    workspace.updateData(next => {
      for (const p of Object.values(next.placements)) if (p.boardId === 'board-a') { delete p.parentPlacementId; delete p.order; }
    });
    const edges = structuredClone(data().edges);
    setBoardLayout('board-a', 'tree');
    expect(items().every(p => p.parentPlacementId === undefined)).toBe(true);
    expect(new Set(items().map(p => p.order)).size).toBe(items().length);
    expect(data().edges).toEqual(edges);
  });
  it('历史可恢复层级；恢复副本重映射父级与连线，仍复用原卡片', async () => {
    const before = boardSnapshot(data(), 'board-a')!;
    moveBoardBranch('board-a', 'placement-b', 'placement-d');
    const change = boardChanges(data(), 'board-a')[0];
    await restoreBoardChange(change.id);
    expect(boardSnapshot(data(), 'board-a')).toEqual(before);
    const copyId = await restoreBoardChange(change.id, 'copy'), copy = boardSnapshot(data(), copyId)!;
    const copiedIds = new Set(copy.placements.map(p => p.id));
    expect(copy.placements).toHaveLength(before.placements.length);
    expect(copy.placements.every(p => !before.placements.some(old => old.id === p.id))).toBe(true);
    expect(copy.placements.filter(p => p.parentPlacementId).every(p => copiedIds.has(p.parentPlacementId!))).toBe(true);
    expect(copy.edges.every(e => copiedIds.has(e.fromPlacementId) && copiedIds.has(e.toPlacementId))).toBe(true);
    expect(copy.placements.map(p => p.resourceRef)).toEqual(expect.arrayContaining(before.placements.map(p => p.resourceRef)));
    validateBoardStructure(copy.placements);
  });
  it('树结构、历史、视图折叠和原文实体通过备份、项目导出与重新加载保留', async () => {
    setBoardLayout('board-a', 'tree'); moveBoardBranch('board-a', 'placement-b', 'placement-d');
    workspace.openResource({ kind: 'board', id: 'board-a' }, { target: 'main', scope: { kind: 'research', researchId: 'research-a' } });
    workspace.setViewState({ boardCollapsed: JSON.stringify(['placement-d']) }, paneGroups(data().sessions['research-a'].layout!.root)[0].activeTabId);
    const historyCount = boardChanges(data(), 'board-a').length;
    const exported = researchFileData(data(), 'research-a');
    expect(exported.boards['board-a'].layout).toBe('tree');
    expect(exported.placements['placement-b'].parentPlacementId).toBe('placement-d');
    expect(exported.boardChanges).toEqual(data().boardChanges);
    const backup = await readWorkspaceBackup(await createWorkspaceBackup(data(), assets));
    expect(backup.data.placements).toEqual(data().placements);
    expect(backup.data.sessions).toEqual(migrateWorkspace(data()).sessions);
    vi.mocked(loadWorkspace).mockResolvedValue(backup.data); await workspace.load();
    expect(data().placements['placement-b'].parentPlacementId).toBe('placement-d');
    expect(boardChanges(data(), 'board-a')).toHaveLength(historyCount);
    expect(JSON.stringify(data().sessions['research-a'].layout)).toContain('boardCollapsed');
  });
});
