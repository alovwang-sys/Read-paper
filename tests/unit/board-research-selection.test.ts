import { describe, expect, it } from 'vitest';
import type { BoardPlacement } from '../../src/domain/types';
import { drawingQuestionTooLarge, drawingResearchSelection, questionPositionNear, selectedBoardPlacements } from '../../src/features/board/board-research-selection';

const placement = (id: string, boardId = 'board-a'): BoardPlacement => ({
  id, boardId, resourceRef: { kind: 'card', id: 'shared-card' }, x: 50, y: 80, group: '',
});

describe('explicit board research selection', () => {
  it('does not autofill or save a drawing source beyond the persisted question limits', () => {
    expect(drawingQuestionTooLarge({ text: 'x'.repeat(20000), elementIds: Array(1000).fill('element') })).toBe(false);
    expect(drawingQuestionTooLarge({ text: 'x'.repeat(20001), elementIds: ['element'] })).toBe(true);
    expect(drawingQuestionTooLarge({ text: 'A small question', elementIds: Array(1001).fill('element') })).toBe(true);
  });
  it('places a new question near the requested position without covering shared nodes', () => {
    expect(questionPositionNear({ x: 50, y: 80 }, [placement('p-a')])).toEqual({ x: 50, y: 424 });
    expect(questionPositionNear({ x: 50, y: 80 }, [{ ...placement('p-a'), resourceRef: { kind: 'document', id: 'paper' } }])).toEqual({ x: 50, y: 464 });
    expect(questionPositionNear({ x: 500, y: 80 }, [placement('p-a')])).toEqual({ x: 500, y: 80 });
  });
  it('retains distinct placement IDs for one shared card and rejects other-board/missing selections', () => {
    const entries = [placement('p-a'), placement('p-b'), placement('p-other', 'board-b')];
    expect(selectedBoardPlacements('board-a', ['p-a', 'p-b', 'missing', 'p-other', 'p-a'], entries).map(item => item.id)).toEqual(['p-a', 'p-b']);
  });

  it('captures only explicitly selected resources, never all nearby items or deleted/unknown embeds', () => {
    const result = drawingResearchSelection([
      { id: 'a', type: 'embeddable', customData: { placementId: 'p-a' } },
      { id: 'b', type: 'embeddable', customData: { placementId: 'p-b' } },
      { id: 'unknown', type: 'embeddable', customData: { placementId: 'not-shared' } },
      { id: 'deleted', type: 'text', text: 'old text', isDeleted: true },
      { id: 'nearby', type: 'text', text: 'not selected' },
    ], { selectedElementIds: { a: true, unknown: true, deleted: true } }, [placement('p-a'), placement('p-b')]);
    expect(result.placementIds).toEqual(['p-a']);
    expect(result.texts).toEqual([]);
    expect(result.elementIds).not.toContain('nearby');
  });

  it('expands selected groups, deduplicates resource IDs and preserves exact drawing text for confirmation', () => {
    const original = '  Why more documents?\nCheck conditions.  ';
    const result = drawingResearchSelection([
      { id: 'a', type: 'embeddable', groupIds: ['group-a'], customData: { placementId: 'p-a' } },
      { id: 'copy', type: 'embeddable', groupIds: ['group-a'], customData: { placementId: 'p-a' } },
      { id: 'b', type: 'embeddable', groupIds: ['group-b'], customData: { placementId: 'p-b' } },
      { id: 'text', type: 'text', groupIds: ['group-a'], text: original },
      { id: 'blank', type: 'text', groupIds: ['group-a'], text: '  ' },
    ], { selectedElementIds: {}, selectedGroupIds: { 'group-a': true } }, [placement('p-a'), placement('p-b')]);
    expect(result.placementIds).toEqual(['p-a']);
    expect(result.texts).toEqual([{ id: 'text', text: original }]);
  });

  it('resolves nested frames and bound labels regardless of element order without OCRing images or strokes', () => {
    const result = drawingResearchSelection([
      { id: 'label', type: 'text', containerId: 'box', text: 'A readable question' },
      { id: 'box', type: 'rectangle', frameId: 'nested' },
      { id: 'resource', type: 'embeddable', frameId: 'nested', customData: { placementId: 'p-a' } },
      { id: 'nested', type: 'frame', frameId: 'frame' },
      { id: 'image', type: 'image', frameId: 'frame' },
      { id: 'stroke', type: 'freedraw', frameId: 'frame' },
      { id: 'frame', type: 'frame' },
      { id: 'unrelated', type: 'text', text: 'Do not include me' },
    ], { selectedElementIds: { frame: true } }, [placement('p-a')]);
    expect(result.placementIds).toEqual(['p-a']);
    expect(result.texts).toEqual([{ id: 'label', text: 'A readable question' }]);
    expect(result.unsupportedCount).toBe(2);
    expect(result.elementIds).not.toContain('unrelated');
  });

  it('selects a bound arrow label but never expands its linked outside nodes', () => {
    const result = drawingResearchSelection([
      { id: 'arrow-label', type: 'text', containerId: 'arrow', text: 'A drawn direction' },
      { id: 'arrow', type: 'arrow' },
      { id: 'outside-card', type: 'embeddable', customData: { placementId: 'p-a' } },
      { id: 'outside-text', type: 'text', text: 'Private outside content' },
    ], { selectedElementIds: { arrow: true } }, [placement('p-a')]);
    expect(result.elementIds).toEqual(['arrow-label', 'arrow']);
    expect(result.placementIds).toEqual([]);
    expect(result.texts).toEqual([{ id: 'arrow-label', text: 'A drawn direction' }]);
  });
});
