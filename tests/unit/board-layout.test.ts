import { describe, expect, it } from 'vitest';
import type { BoardPlacement } from '../../src/domain/types';
import { layoutBoardTree, orderedBoardPlacements, treeVisiblePlacements } from '../../src/domain/board-layout';

function node(id: string, parentPlacementId?: string, order = 0): BoardPlacement {
  return { id, boardId: 'board', resourceRef: { kind: 'card', id: `card-${id}` }, x: 10, y: 20, group: 'same group', parentPlacementId, order };
}
const branch = [node('root'), node('a', 'root', 1), node('b', 'root', 0), node('c', 'b'), node('d', 'b', 1), node('other', undefined, 1)];

describe('explicit board tree layout', () => {
  it('balances parent over ordered children without changing shared content or input', () => {
    const before = structuredClone(branch), result = layoutBoardTree(branch);
    expect(branch).toEqual(before);
    expect(result.map(item => item.id)).toEqual(['root', 'b', 'c', 'd', 'a', 'other']);
    const byId = Object.fromEntries(result.map(item => [item.id, item]));
    expect(byId.b.x - byId.root.x).toBe(340);
    expect(byId.c.x - byId.b.x).toBe(340);
    expect(byId.b.y).toBe((byId.c.y + byId.d.y) / 2);
    expect(byId.a.y).toBeGreaterThan(byId.d.y);
    expect(byId.other.x).toBe(byId.root.x);
    result.forEach(item => expect({ ...item, x: 10, y: 20 }).toEqual(branch.find(original => original.id === item.id)));
  });

  it.each([100, 160])('keeps a forest of 80 cards apart at height %i', nodeHeight => {
    const forest = Array.from({ length: 80 }, (_, i) => node(String(i), i % 13 ? String(Math.floor((i - 1) / 3)) : undefined, i));
    const result = layoutBoardTree(forest, { nodeHeight });
    expect(result).toHaveLength(80);
    for (const [i, a] of result.entries()) for (const b of result.slice(i + 1)) {
      expect(Math.abs(a.x - b.x) >= 320 || Math.abs(a.y - b.y) >= nodeHeight + 24).toBe(true);
    }
  });

  it('folds descendants as view data and expands to the same original positions', () => {
    const before = layoutBoardTree(branch);
    expect(treeVisiblePlacements(branch, ['b']).map(item => item.id)).toEqual(['root', 'b', 'a', 'other']);
    expect(layoutBoardTree(branch, { collapsedIds: ['b'] }).map(item => item.id)).toEqual(['root', 'b', 'a', 'other']);
    expect(layoutBoardTree(branch)).toEqual(before);
    expect(orderedBoardPlacements(branch).map(item => item.id)).toEqual(before.map(item => item.id));
  });

  it('stays finite and deterministic for missing parents, cross-board parents and cycles', () => {
    const invalid = [node('c', 'a'), node('b', 'c'), node('a', 'b'), node('orphan', 'missing'), { ...node('external', 'a'), boardId: 'another' }];
    const result = layoutBoardTree(invalid);
    expect(result).toHaveLength(5);
    expect(result.every(item => Number.isFinite(item.x) && Number.isFinite(item.y))).toBe(true);
    expect(result).toEqual(layoutBoardTree([...invalid].reverse()));
    expect(result.find(item => item.id === 'external')?.x).toBe(64);
    expect(result.find(item => item.id === 'orphan')?.x).toBe(64);
  });

  it('does not infer parents from group, old coordinates or shared card identity', () => {
    const flat = branch.map(item => ({ ...item, parentPlacementId: undefined, resourceRef: { kind: 'card' as const, id: 'same' } }));
    expect(new Set(layoutBoardTree(flat).map(item => item.x))).toEqual(new Set([64]));
  });

  it('retains tied sibling order after placement IDs are replaced', () => {
    const laidOut = layoutBoardTree([node('root'), node('a', 'root'), node('z', 'root')]);
    const renamed = laidOut.map(p => ({ ...p, id: p.id === 'a' ? 'new-z' : p.id === 'z' ? 'new-a' : p.id }));
    expect(layoutBoardTree(renamed).map(p => ({ ref: p.resourceRef, x: p.x, y: p.y })))
      .toEqual(laidOut.map(p => ({ ref: p.resourceRef, x: p.x, y: p.y })));
  });
});
