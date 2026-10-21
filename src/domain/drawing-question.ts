import type { DrawingQuestion, DrawingSnapshot, WorkspaceData } from './types';

export const DRAWING_IMAGE_BYTES = 2 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200) => typeof value === 'string' && !!value.trim() && value.length <= max;
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
function valid(value: unknown): asserts value {
  if (!value) throw new Error('绘图问题快照损坏，请重新框选；原输入已保留。');
}
export function drawingTextLength(snapshot: DrawingSnapshot) {
  return snapshot.elements.reduce((n, element) => n + (element.text?.length ?? 0) + (element.resource ? element.resource.title.length + element.resource.body.length : 0), 0)
    + snapshot.connections.reduce((n, connection) => n + (connection.label?.length ?? 0), 0);
}
export function hasDrawingText(snapshot: DrawingSnapshot) {
  return snapshot.elements.some(element => element.text?.trim() || element.resource?.title.trim() || element.resource?.body.trim()) || snapshot.connections.some(connection => connection.label?.trim());
}

/** Also used on restored JSON: never treat a saved object as trusted model input. */
export function validateDrawingQuestion(value: unknown): asserts value is DrawingQuestion {
  valid(object(value) && keys(value, ['snapshot', 'mode']) && ['image', 'text'].includes(value.mode as string));
  const snapshot = value.snapshot;
  valid(object(snapshot) && keys(snapshot, ['id', 'boardId', 'boardTitle', 'createdAt', 'hash', 'image', 'elements', 'connections']));
  valid(text(snapshot.id) && text(snapshot.boardId) && text(snapshot.boardTitle, 2000) && typeof snapshot.createdAt === 'string' && Number.isFinite(Date.parse(snapshot.createdAt)) && hash(snapshot.hash));
  const image = snapshot.image;
  valid(object(image) && keys(image, ['assetId', 'hash', 'width', 'height']) && typeof image.assetId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(image.assetId) && hash(image.hash));
  valid([image.width, image.height].every(n => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 2048));
  valid(Array.isArray(snapshot.elements) && snapshot.elements.length > 0 && snapshot.elements.length <= 100);
  const ids = new Set<string>();
  for (const element of snapshot.elements) {
    valid(object(element) && keys(element, ['id', 'type', 'x', 'y', 'width', 'height', 'angle', 'text', 'resource']) && text(element.id) && !ids.has(element.id as string));
    ids.add(element.id as string);
    valid(['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'freedraw', 'text', 'image', 'frame', 'magicframe', 'embeddable', 'iframe'].includes(element.type as string));
    valid([element.x, element.y, element.width, element.height, element.angle].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e7) && (element.width as number) >= 0 && (element.height as number) >= 0);
    valid(element.text === undefined || typeof element.text === 'string');
    if (element.resource !== undefined) {
      const resource = element.resource;
      valid(object(resource) && keys(resource, ['ref', 'title', 'body']) && object(resource.ref) && keys(resource.ref, ['kind', 'id']) && ['card', 'document'].includes(resource.ref.kind as string) && text(resource.ref.id) && typeof resource.title === 'string' && typeof resource.body === 'string');
    }
  }
  valid(Array.isArray(snapshot.connections) && snapshot.connections.length <= 100);
  const connectionIds = new Set<string>();
  for (const connection of snapshot.connections) {
    valid(object(connection) && keys(connection, ['id', 'startId', 'endId', 'startOutside', 'endOutside', 'startArrowhead', 'endArrowhead', 'label']) && typeof connection.id === 'string' && ids.has(connection.id) && !connectionIds.has(connection.id));
    connectionIds.add(connection.id);
    valid(snapshot.elements.some(element => element.id === connection.id && ['line', 'arrow'].includes(element.type)));
    for (const end of ['start', 'end']) {
      const id = connection[`${end}Id`], outside = connection[`${end}Outside`], head = connection[`${end}Arrowhead`];
      valid((id === undefined || typeof id === 'string' && ids.has(id)) && (outside === undefined || typeof outside === 'boolean') && !(id !== undefined && outside));
      valid(head === undefined || head === null || typeof head === 'string' && head.length <= 50);
    }
    valid(connection.label === undefined || typeof connection.label === 'string');
  }
  valid(drawingTextLength(snapshot as DrawingSnapshot) <= 12000);
  valid(value.mode !== 'text' || hasDrawingText(snapshot as DrawingSnapshot));
}

// Sort keys so the hash survives JSON backup and property ordering changes.
export function drawingSnapshotContent(snapshot: DrawingSnapshot): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, sorted(value[key])])) : value;
  const { hash: _hash, ...content } = snapshot;
  return JSON.stringify(sorted(content));
}

export function drawingQuestionReferences(data: Pick<WorkspaceData, 'conversations' | 'requests'>) {
  return [...Object.values(data.conversations).map(item => item.drawingQuestion), ...Object.values(data.requests).map(item => item.researchRun?.drawingQuestion)]
    .filter((item): item is DrawingQuestion => item !== undefined);
}

export function validateDrawingPng(bytes: ArrayBuffer, image: DrawingSnapshot['image']) {
  const data = new Uint8Array(bytes), view = new DataView(bytes);
  if (data.length < 33 || data.length > DRAWING_IMAGE_BYTES || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => data[i] === byte)
    || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452 || view.getUint32(16) !== image.width || view.getUint32(20) !== image.height) throw new Error('绘图图片缺失、损坏或超过 2MiB／2048px，请重新框选。');
}
