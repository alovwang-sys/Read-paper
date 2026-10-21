import { convertToExcalidrawElements, getCommonBounds, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawLinearElement } from '@excalidraw/excalidraw/element/types';

type Arrow = ExcalidrawLinearElement;
type Shape = Extract<ExcalidrawElement, { type: 'rectangle' | 'ellipse' | 'diamond' }>;
type Point = { x: number; y: number };

function globalPoints(arrow: Arrow): Point[] {
  if (!arrow.angle) return arrow.points.map(point => ({ x: arrow.x + point[0], y: arrow.y + point[1] }));
  const [x1, y1, x2, y2] = getCommonBounds([{ ...arrow, angle: 0 }]);
  const cx = (x1 + x2) / 2 - arrow.x, cy = (y1 + y2) / 2 - arrow.y;
  const cos = Math.cos(arrow.angle), sin = Math.sin(arrow.angle);
  return arrow.points.map(point => {
    const dx = point[0] - cx, dy = point[1] - cy;
    return { x: arrow.x + cx + dx * cos - dy * sin, y: arrow.y + cy + dx * sin + dy * cos };
  });
}

const endpoint = (arrow: Arrow, end: 'start' | 'end') => globalPoints(arrow)[end === 'start' ? 0 : arrow.points.length - 1];

/** Placement moves outside the drawing editor must move their attached endpoints, too. */
export function moveBoundArrowEndpoints(before: readonly ExcalidrawElement[], after: readonly ExcalidrawElement[]) {
  const previous = new Map(before.map(element => [element.id, element]));
  const current = new Map(after.map(element => [element.id, element]));
  let changed = false;
  const next = after.map(element => {
    if (element.type !== 'arrow' || ('elbowed' in element && element.elbowed) || element.isDeleted || element.customData?.boardRelation || element.points.length < 2) return element;
    const original = previous.get(element.id);
    const delta = (end: 'start' | 'end', id?: string): Point => {
      if (original?.type === 'arrow') {
        const oldPoint = endpoint(original, end), newPoint = endpoint(element, end);
        if (Math.hypot(oldPoint.x - newPoint.x, oldPoint.y - newPoint.y) > .01) return { x: 0, y: 0 };
      }
      const old = id && previous.get(id), next = id && current.get(id);
      return old && next && !next.isDeleted ? { x: next.x - old.x, y: next.y - old.y } : { x: 0, y: 0 };
    };
    const start = delta('start', element.startBinding?.elementId), end = delta('end', element.endBinding?.elementId);
    if (!start.x && !start.y && !end.x && !end.y) return element;
    changed = true;
    if (start.x === end.x && start.y === end.y) return newElementWith(element, { x: element.x + start.x, y: element.y + start.y });
    const points = globalPoints(element).map((point, index) => {
      const shift = index === 0 ? start : index === element.points.length - 1 ? end : { x: 0, y: 0 };
      return { x: point.x + shift.x, y: point.y + shift.y };
    });
    const origin = points[0];
    const local = points.map(point => [point.x - origin.x, point.y - origin.y]) as Arrow['points'];
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    for (const [x, y] of local) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    return newElementWith(element, { x: origin.x, y: origin.y, angle: 0, points: local, width: maxX - minX, height: maxY - minY });
  });
  return changed ? next : after;
}

function inside(element: ExcalidrawElement, point: Point): element is Shape {
  if (element.isDeleted || element.locked || !['rectangle', 'ellipse', 'diamond'].includes(element.type) || element.width <= 0 || element.height <= 0) return false;
  const dx = point.x - element.x - element.width / 2, dy = point.y - element.y - element.height / 2;
  const x = Math.abs((dx * Math.cos(element.angle) + dy * Math.sin(element.angle)) / (element.width / 2));
  const y = Math.abs((-dx * Math.sin(element.angle) + dy * Math.cos(element.angle)) / (element.height / 2));
  return element.type === 'ellipse' ? x * x + y * y <= 1 : element.type === 'diamond' ? x + y <= 1 : x <= 1 && y <= 1;
}

/** Transparent shapes should accept a deliberately dropped arrow endpoint, too. */
export function bindDroppedArrowEndpoints(elements: readonly ExcalidrawElement[], before: ReadonlyMap<string, ExcalidrawElement>) {
  const updates = new Map<string, ExcalidrawElement>();
  for (const element of elements) {
    // shortcut: elbow arrows keep native outline snapping until the library exposes its binding/router API.
    if (element.type !== 'arrow' || ('elbowed' in element && element.elbowed) || element.isDeleted || element.locked || element.customData?.boardRelation || element.points.length < 2) continue;
    const original = before.get(element.id);
    if (original?.type === 'arrow' && JSON.stringify(original.points) === JSON.stringify(element.points)) continue;
    let arrow = element;
    for (const end of ['start', 'end'] as const) {
      const field = end === 'start' ? 'startBinding' : 'endBinding';
      if (arrow[field]) continue;
      const point = endpoint(arrow, end);
      if (original?.type === 'arrow') {
        const previous = endpoint(original, end);
        if (Math.hypot(previous.x - point.x, previous.y - point.y) < .01) continue;
      }
      const other = end === 'start' ? arrow.endBinding : arrow.startBinding;
      const target = [...elements].reverse().find((candidate): candidate is Shape => candidate.id !== other?.elementId && inside(candidate, point));
      if (!target) continue;
      const converted = convertToExcalidrawElements([target, { ...arrow, [end]: { id: target.id } }], { regenerateIds: false });
      const convertedArrow = converted.find(item => item.id === arrow.id);
      const binding = convertedArrow?.type === 'arrow' && convertedArrow[field];
      if (!binding) continue;
      // Only copy binding metadata: the converter also nudges points and recreates targets.
      arrow = newElementWith(arrow, { [field]: binding });
      updates.set(arrow.id, arrow);
      const current = updates.get(target.id) ?? target;
      const boundElements = [...(current.boundElements ?? []).filter(item => item.id !== arrow.id), { id: arrow.id, type: 'arrow' as const }];
      updates.set(target.id, newElementWith(current, { boundElements }));
    }
  }
  return updates.size ? elements.map(element => updates.get(element.id) ?? element) : elements;
}
