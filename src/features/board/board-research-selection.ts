import type { BoardPlacement } from '../../domain/types';

export function drawingQuestionTooLarge(source: { text: string; elementIds: readonly string[] }) {
  return source.text.length > 20000 || source.elementIds.length > 1000;
}

type DrawingElement = {
  id: string;
  type: string;
  isDeleted?: boolean;
  groupIds?: readonly string[];
  frameId?: string | null;
  containerId?: string | null;
  text?: string;
  customData?: Record<string, unknown> | null;
};

/** Resolve only the explicitly selected group/frame and its own members. */
export function drawingResearchSelection(
  elements: readonly DrawingElement[],
  selection: {
    selectedElementIds: Record<string, boolean>;
    selectedGroupIds?: Record<string, boolean>;
  },
  placements: readonly BoardPlacement[],
) {
  const live = elements.filter(element => !element.isDeleted);
  const selected = new Set(live.filter(element =>
    selection.selectedElementIds[element.id]
    || element.groupIds?.some(id => selection.selectedGroupIds?.[id]),
  ).map(element => element.id));
  // A frame and a shape's bound label belong to the selection; unrelated drawing does not.
  let previousSize = -1;
  while (previousSize !== selected.size) {
    previousSize = selected.size;
    for (const element of live) {
      if (element.frameId && selected.has(element.frameId)) selected.add(element.id);
    }
  }
  for (const element of live) {
    if (element.containerId && selected.has(element.containerId)) selected.add(element.id);
  }
  const chosen = live.filter(element => selected.has(element.id));
  const known = new Set(placements.map(item => item.id));
  const placementIds = [...new Set(chosen.flatMap(element => {
    const id = element.type === 'embeddable' ? element.customData?.placementId : undefined;
    return typeof id === 'string' && known.has(id) ? [id] : [];
  }))];
  const texts = chosen.filter(element => element.type === 'text' && element.text?.trim())
    .map(element => ({ id: element.id, text: element.text! }));
  return { placementIds, texts, elementIds: chosen.map(element => element.id), unsupportedCount: chosen.filter(element =>
    element.type !== 'text' && element.type !== 'embeddable'
    && element.type !== 'frame' && !chosen.some(label => label.containerId === element.id),
  ).length };
}

export function selectedBoardPlacements(
  boardId: string,
  ids: readonly string[],
  placements: readonly BoardPlacement[],
) {
  const wanted = new Set(ids);
  return placements.filter(item => item.boardId === boardId && wanted.has(item.id));
}

export function questionPositionNear(position: { x: number; y: number }, placements: readonly BoardPlacement[]) {
  const next = { x: Math.max(20, position.x), y: Math.max(55, position.y) };
  let collision: BoardPlacement | undefined;
  while ((collision = placements.find(item => next.x < item.x + 280 && next.x + 280 > item.x && next.y < item.y + (item.resourceRef.kind === 'document' ? 360 : 320) + 24 && next.y + 344 > item.y))) {
    next.y = collision.y + (collision.resourceRef.kind === 'document' ? 360 : 320) + 24;
  }
  return next;
}
