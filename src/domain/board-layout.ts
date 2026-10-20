import type { BoardPlacement } from './types';
import { compareBoardOrder } from './board-structure';

function boardForest(placements: BoardPlacement[]) {
  const byId = new Map(placements.map(item => [item.id, item]));
  const ordered = [...byId.values()].sort(compareBoardOrder);
  const parents = new Map<string, string>();
  for (const item of ordered) {
    const parent = item.parentPlacementId && byId.get(item.parentPlacementId);
    if (parent && parent.id !== item.id && parent.boardId === item.boardId) parents.set(item.id, parent.id);
  }
  // Invalid imported structures must remain readable while boundary validation reports the problem.
  for (const item of ordered) {
    const path: string[] = [];
    let id: string | undefined = item.id;
    while (id && !path.includes(id)) { path.push(id); id = parents.get(id); }
    if (id) parents.delete(path.slice(path.indexOf(id)).sort()[0]);
  }
  const children = new Map<string | undefined, BoardPlacement[]>();
  for (const item of ordered) {
    const parent = parents.get(item.id);
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  return children;
}

export function orderedBoardPlacements(placements: BoardPlacement[]): BoardPlacement[] {
  return treeVisiblePlacements(placements, []);
}

export function treeVisiblePlacements(placements: BoardPlacement[], collapsedIds: string[]): BoardPlacement[] {
  const children = boardForest(placements), collapsed = new Set(collapsedIds), visible: BoardPlacement[] = [];
  function visit(parent?: string) {
    for (const item of children.get(parent) ?? []) {
      visible.push(item);
      if (!collapsed.has(item.id)) visit(item.id);
    }
  }
  visit();
  return visible;
}

export function layoutBoardTree(placements: BoardPlacement[], options: { collapsedIds?: string[]; nodeHeight?: number } = {}): BoardPlacement[] {
  const height = Number.isFinite(options.nodeHeight) && options.nodeHeight! > 0 ? options.nodeHeight! : 100;
  const children = boardForest(placements), collapsed = new Set(options.collapsedIds), spans = new Map<string, number>();
  const visibleChildren = (id: string) => collapsed.has(id) ? [] : children.get(id) ?? [];
  function measure(item: BoardPlacement): number {
    const branch = visibleChildren(item.id);
    const span = Math.max(height, branch.reduce((sum, child) => sum + measure(child), 0) + Math.max(0, branch.length - 1) * 28);
    spans.set(item.id, span);
    return span;
  }
  const roots = children.get(undefined) ?? [];
  roots.forEach(measure);
  const result: BoardPlacement[] = [];
  function place(item: BoardPlacement, depth: number, top: number) {
    result.push({ ...item, x: 64 + depth * 340, y: top + (spans.get(item.id)! - height) / 2 });
    let next = top;
    for (const child of visibleChildren(item.id)) {
      place(child, depth + 1, next);
      next += spans.get(child.id)! + 28;
    }
  }
  let top = 64;
  for (const root of roots) {
    place(root, 0, top);
    top += spans.get(root.id)! + 64;
  }
  return result;
}
