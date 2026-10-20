import type { BoardPlacement, WorkspaceData } from '../domain/types';
import { boardDescendants, orderedBoardSiblings, prepareBoardTreePlacements, promoteRemovedPlacements, validateBoardStructure } from '../domain/board-structure';
import { layoutBoardTree } from '../domain/board-layout';
import { uid, workspace } from './workspace';

function placementsFor(data: WorkspaceData, boardId: string) {
  if (!data.boards[boardId]) throw new Error('白板已不存在。');
  return Object.values(data.placements).filter(p => p.boardId === boardId);
}
function arrange(data: WorkspaceData, boardId: string) {
  const items = placementsFor(data, boardId);
  validateBoardStructure(items);
  if (data.boards[boardId].layout === 'tree') for (const p of layoutBoardTree(items)) data.placements[p.id] = p;
}

export function setBoardLayout(boardId: string, layout: 'free' | 'tree') {
  if (!['free', 'tree'].includes(layout)) throw new Error('白板布局无效。');
  workspace.updateData(data => {
    const items = placementsFor(data, boardId);
    const leavingTree = data.boards[boardId].layout === 'tree' && layout === 'free';
    data.boards[boardId].layout = layout;
    if (layout === 'tree') prepareBoardTreePlacements(items).forEach(p => { data.placements[p.id] = p; });
    // Free cards show excerpts and source controls, so leave room for their full density.
    if (leavingTree) layoutBoardTree(items, { nodeHeight: 340 }).forEach(p => { data.placements[p.id] = p; });
    arrange(data, boardId);
  }, { boardChange: { summary: layout === 'tree' ? '按明确层级整理白板' : '切换为自由布局' } });
}

export function moveBoardBranch(boardId: string, placementId: string, parentPlacementId: string | undefined, beforePlacementId?: string) {
  workspace.updateData(data => {
    const items = placementsFor(data, boardId), item = items.find(p => p.id === placementId);
    if (!item) throw new Error('要移动的节点已不存在。');
    if (parentPlacementId !== undefined && (!items.some(p => p.id === parentPlacementId) || parentPlacementId === placementId || boardDescendants(items, placementId).includes(parentPlacementId)))
      throw new Error('目标父节点无效，不能移入自身或后代。');
    const oldParent = item.parentPlacementId, siblings = orderedBoardSiblings(items, parentPlacementId).filter(p => p.id !== placementId);
    const at = beforePlacementId === undefined ? siblings.length : siblings.findIndex(p => p.id === beforePlacementId);
    if (at < 0) throw new Error('目标顺序已改变，请重新选择。');
    if (parentPlacementId === undefined) delete item.parentPlacementId; else item.parentPlacementId = parentPlacementId;
    if (oldParent !== parentPlacementId) orderedBoardSiblings(items, oldParent).forEach((p, i) => { p.order = i; });
    siblings.splice(at, 0, item); siblings.forEach((p, i) => { p.order = i; });
    arrange(data, boardId);
  }, { boardChange: { summary: '调整分支归属与顺序' } });
}

export function reorderBoardPlacement(boardId: string, id: string, direction: -1 | 1) {
  if (direction !== -1 && direction !== 1) throw new Error('排序方向无效。');
  const items = placementsFor(workspace.getState().data, boardId), item = items.find(p => p.id === id);
  if (!item) throw new Error('节点已不存在。');
  const siblings = orderedBoardSiblings(items, item.parentPlacementId), index = siblings.findIndex(p => p.id === id), target = index + direction;
  if (target < 0 || target >= siblings.length) return;
  moveBoardBranch(boardId, id, item.parentPlacementId, direction < 0 ? siblings[target].id : siblings[target + 1]?.id);
}

export function removeBoardPlacements(boardId: string, ids: string[], branch = false) {
  workspace.updateData(data => {
    const items = placementsFor(data, boardId), removed = new Set(ids);
    if (ids.some(id => !items.some(p => p.id === id))) throw new Error('要移出的节点已改变。');
    if (branch) ids.forEach(id => boardDescendants(items, id).forEach(child => removed.add(child)));
    const hierarchical = items.some(p => p.parentPlacementId !== undefined || p.order !== undefined);
    const remaining: BoardPlacement[] = hierarchical ? promoteRemovedPlacements(items, removed) : items.filter(p => !removed.has(p.id));
    items.forEach(p => { delete data.placements[p.id]; });
    remaining.forEach(p => { data.placements[p.id] = p; });
    for (const e of Object.values(data.edges)) if (e.boardId === boardId && (removed.has(e.fromPlacementId) || removed.has(e.toPlacementId))) delete data.edges[e.id];
    arrange(data, boardId);
  }, { boardChange: { summary: branch ? '移出整枝，保留共享卡片' : '移出节点，保留子分支与共享卡片' } });
}

export function addBoardCard(boardId: string, title: string, parentPlacementId?: string): string {
  if (!title.trim() || title.trim().length > 200) throw new Error('请填写 200 字以内的节点标题。');
  const id = uid('placement');
  workspace.updateData(data => {
    const items = placementsFor(data, boardId);
    if (parentPlacementId !== undefined && !items.some(p => p.id === parentPlacementId)) throw new Error('父节点已不存在。');
    const cardId = uid('card');
    data.cards[cardId] = { id: cardId, title: title.trim(), body: '', evidenceIds: [], needsReview: true };
    data.researches[data.boards[boardId].researchId].cardIds.push(cardId);
    data.placements[id] = { id, boardId, resourceRef: { kind: 'card', id: cardId }, x: 50, y: 80 + items.length * 130, group: '',
      order: Math.max(-1, ...orderedBoardSiblings(items, parentPlacementId).map(p => p.order ?? 0)) + 1, ...(parentPlacementId ? { parentPlacementId } : {}) };
    arrange(data, boardId);
  }, { boardChange: { summary: parentPlacementId ? '添加子节点' : '添加研究节点' } });
  return id;
}
