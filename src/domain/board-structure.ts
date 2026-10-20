import type { BoardPlacement } from './types';

export function prepareBoardTreePlacements(placements: BoardPlacement[]): BoardPlacement[] {
  const items = placements.map(p => ({ ...p }));
  // Legacy positions define root order only; semantic links never become parents.
  if (items.every(p => p.order === undefined && p.parentPlacementId === undefined))
    items.sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id)).forEach((p, order) => { p.order = order; });
  return items;
}

export function orderedBoardSiblings(placements: BoardPlacement[], parentPlacementId?: string): BoardPlacement[] {
  return placements.filter(p => p.parentPlacementId === parentPlacementId)
    .sort(compareBoardOrder);
}

// Keep the visible order when proposal/copy IDs change, including older tied orders.
export function compareBoardOrder(a: BoardPlacement, b: BoardPlacement): number {
  return (a.order ?? 0) - (b.order ?? 0) || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
}

export function boardDescendants(placements: BoardPlacement[], id: string): string[] {
  const found = new Set<string>([id]), queue = [id];
  for (let index = 0; index < queue.length; index++) for (const child of placements) {
    if (child.parentPlacementId === queue[index] && !found.has(child.id)) { found.add(child.id); queue.push(child.id); }
  }
  return queue.slice(1);
}

/** Used by writes, imports and snapshots; invalid trees never reach persistence. */
export function validateBoardStructure(placements: BoardPlacement[]) {
  const byId = new Map(placements.map(p => [p.id, p]));
  if (byId.size !== placements.length) throw new Error('白板摆放标识重复。');
  for (const p of placements) {
    if (p.order !== undefined && (!Number.isSafeInteger(p.order) || p.order < 0)) throw new Error('白板分支顺序无效。');
    if (p.parentPlacementId !== undefined && (typeof p.parentPlacementId !== 'string' || !byId.has(p.parentPlacementId) || byId.get(p.parentPlacementId)!.boardId !== p.boardId))
      throw new Error('父节点不存在或不属于同一白板。');
    const visited = new Set<string>([p.id]);
    let parent = p.parentPlacementId;
    while (parent !== undefined) {
      if (visited.has(parent)) throw new Error('不能将分支移入自身或后代。');
      visited.add(parent); parent = byId.get(parent)?.parentPlacementId;
    }
  }
}

/** Removing a placement promotes surviving descendants at its original sibling position. */
export function promoteRemovedPlacements(placements: BoardPlacement[], removed: Set<string>): BoardPlacement[] {
  const result: BoardPlacement[] = [];
  function visit(parent: string | undefined, targetParent: string | undefined, siblings: BoardPlacement[]) {
    for (const p of orderedBoardSiblings(placements, parent)) {
      if (removed.has(p.id)) visit(p.id, targetParent, siblings);
      else {
        const next = { ...p, order: siblings.length };
        if (targetParent === undefined) delete next.parentPlacementId; else next.parentPlacementId = targetParent;
        siblings.push(next); result.push(next);
        visit(p.id, p.id, []);
      }
    }
  }
  visit(undefined, undefined, []);
  return result;
}
