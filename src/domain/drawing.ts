import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import type { BoardContext, BoardDrawingRef, WorkspaceData } from './types';

export type DrawingScene = {
  type: 'excalidraw';
  version: 2;
  source: string;
  elements: readonly ExcalidrawElement[];
  appState: { viewBackgroundColor: string; scrollX: number; scrollY: number; zoom: { value: number } };
  files: BinaryFiles;
};
export const MAX_DRAWING_BYTES = 32 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const kinds = new Set(['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'text', 'freedraw', 'image', 'frame', 'magicframe', 'embeddable']);
const coordinate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e8;
function requireValid(value: unknown, message: string): asserts value { if (!value) throw new Error(`绘图${message}，已有内容已保留。`); }

export function validateDrawingRef(value: unknown): asserts value is BoardDrawingRef {
  requireValid(object(value) && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash) && value.assetId === `drawing-${value.hash}`, '资产引用损坏');
}

/** The native file keeps image attachments together; only this tiny ref enters workspace/history. */
export function parseDrawingScene(raw: string): DrawingScene {
  requireValid(raw.length <= MAX_DRAWING_BYTES && new TextEncoder().encode(raw).length <= MAX_DRAWING_BYTES, '超过 32 MB 保存上限，请减少图片或拆分白板');
  let scene: unknown;
  try { scene = JSON.parse(raw); } catch { throw new Error('绘图文件不是有效 JSON，已有内容已保留。'); }
  requireValid(object(scene) && scene.type === 'excalidraw' && scene.version === 2 && typeof scene.source === 'string' && Array.isArray(scene.elements) && scene.elements.length <= 20000 && object(scene.appState) && object(scene.files), '文件格式不完整');
  const state = scene.appState;
  requireValid(typeof state.viewBackgroundColor === 'string' && state.viewBackgroundColor.length <= 100 && coordinate(state.scrollX) && coordinate(state.scrollY) && object(state.zoom) && typeof state.zoom.value === 'number' && state.zoom.value >= .1 && state.zoom.value <= 30, '视口无效');
  const ids = new Set<string>();
  for (const item of scene.elements) {
    requireValid(object(item) && typeof item.id === 'string' && !!item.id && !['__proto__', 'constructor', 'prototype'].includes(item.id) && item.id.length <= 200 && !ids.has(item.id) && kinds.has(String(item.type)) && [item.x, item.y, item.width, item.height, item.angle].every(coordinate) && typeof item.isDeleted === 'boolean', '元素结构损坏');
    ids.add(item.id);
    if (item.type === 'text') requireValid(typeof item.text === 'string' && item.text.length <= 100000, '文字过长或损坏');
    if (item.points !== undefined) requireValid(Array.isArray(item.points) && item.points.length <= 100000 && item.points.every(point => Array.isArray(point) && point.length === 2 && point.every(coordinate)), '笔画坐标无效');
    if (item.type === 'image' && !item.isDeleted && item.fileId) requireValid(typeof item.fileId === 'string' && Object.hasOwn(scene.files, item.fileId), '图片附件缺失');
  }
  for (const [id, file] of Object.entries(scene.files)) {
    requireValid(!['__proto__', 'constructor', 'prototype'].includes(id) && object(file) && file.id === id && typeof file.mimeType === 'string' && /^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(file.mimeType) && typeof file.dataURL === 'string' && file.dataURL.startsWith(`data:${file.mimeType};base64,`), '图片附件格式无效');
    let bytes: string;
    try { bytes = atob(file.dataURL.slice(file.dataURL.indexOf(',') + 1)); } catch { throw new Error('绘图图片编码损坏，已有内容已保留。'); }
    const image = file.mimeType === 'image/png' ? bytes.startsWith('\x89PNG\r\n\x1a\n')
      : file.mimeType === 'image/jpeg' ? bytes.startsWith('\xff\xd8\xff')
      : file.mimeType === 'image/gif' ? /^GIF8[79]a/.test(bytes)
      : file.mimeType === 'image/webp' ? bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP'
      : /<svg[\s>]/i.test(bytes) && !/<script[\s>]|<foreignObject[\s>]|\bon\w+\s*=/i.test(bytes);
    requireValid(image, '图片文件头与格式不符');
  }
  return scene as unknown as DrawingScene;
}

export function drawingReferences(data: WorkspaceData): BoardDrawingRef[] {
  const refs = [
    ...Object.values(data.boards).map(board => board.drawing),
    ...Object.values(data.boardChanges ?? {}).flatMap(change => [change.before?.board.drawing, change.after?.board.drawing]),
    ...Object.values(data.requests).map(request => request.boardContext?.snapshot.board.drawing),
  ].filter((ref): ref is BoardDrawingRef => !!ref);
  return [...new Map(refs.map(ref => [`${ref.assetId}:${ref.hash}`, ref])).values()];
}

export function boardContextForModel(context: BoardContext): BoardContext {
  const board = { ...context.snapshot.board };
  delete board.drawing;
  return { ...context, snapshot: { ...context.snapshot, board } };
}
