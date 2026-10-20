import { contentHash, getAsset, putAsset } from '../data/storage';
import { parseDrawingScene, type DrawingScene } from '../domain/drawing';
import type { BoardDrawingRef, SaveStatus } from '../domain/types';

type SaveState = { status: SaveStatus; error?: string };
type Buffer = {
  scene: DrawingScene;
  commit: (ref: BoardDrawingRef) => void;
  version: number;
  saved: number;
  state: SaveState;
  baseRef?: BoardDrawingRef;
  timer?: ReturnType<typeof setTimeout>;
  saving?: Promise<void>;
};
const buffers = new Map<string, Buffer>();
const subscribers = new Set<() => void>();
const saved: SaveState = { status: 'saved' };
const emit = () => subscribers.forEach(listener => listener());
export const subscribeDrawingSaves = (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };
export const getDrawingSaveState = (boardId: string): SaveState => buffers.get(boardId)?.state ?? saved;

export async function loadBoardDrawing(boardId: string, ref?: BoardDrawingRef): Promise<DrawingScene | undefined> {
  const pending = buffers.get(boardId);
  if (pending && pending.saved !== pending.version && pending.baseRef?.hash === ref?.hash) return pending.scene;
  if (!ref) return undefined;
  const blob = await getAsset(ref.assetId);
  if (!blob) throw new Error('绘图文件缺失，请从备份恢复；当前卡片与资料仍保留。');
  const bytes = await blob.arrayBuffer();
  if (await contentHash(bytes) !== ref.hash) throw new Error('绘图文件校验失败，未覆盖已有内容。');
  return parseDrawingScene(new TextDecoder().decode(bytes));
}

async function persist(boardId: string): Promise<void> {
  const buffer = buffers.get(boardId);
  if (!buffer) return;
  clearTimeout(buffer.timer);
  if (buffer.saving) { await buffer.saving; if (buffer.version !== buffer.saved) await persist(boardId); return; }
  if (buffer.version === buffer.saved) return;
  const version = buffer.version, scene = buffer.scene, commit = buffer.commit;
  buffer.state = { status: 'saving' }; emit();
  buffer.saving = Promise.resolve().then(async () => {
    try {
      const raw = JSON.stringify(scene);
      parseDrawingScene(raw);
      const bytes = new TextEncoder().encode(raw);
      const hash = await contentHash(bytes.buffer);
      const ref = { assetId: `drawing-${hash}`, hash };
      // shortcut: immutable scenes repeat embedded images; split image assets when image-heavy histories outgrow storage.
      await putAsset(ref.assetId, new Blob([bytes], { type: 'application/vnd.excalidraw+json' }));
      if (version !== buffer.version) { buffer.state = { status: 'dirty' }; return; }
      // Assets must commit first; a failed write never leaves a dangling Board reference.
      commit(ref);
      buffer.baseRef = ref;
      buffer.saved = version;
      buffer.state = buffer.version === version ? saved : { status: 'dirty' };
    } catch (error) {
      buffer.state = { status: 'error', error: error instanceof Error ? error.message : '绘图保存失败，内容仍在恢复缓冲中，请重试。' };
      throw error;
    }
  });
  try { await buffer.saving; }
  finally { buffer.saving = undefined; if (buffer.version === buffer.saved) buffers.delete(boardId); emit(); }
  if (buffer.version !== buffer.saved) await persist(boardId);
}

export function stageBoardDrawing(boardId: string, scene: DrawingScene, commit: (ref: BoardDrawingRef) => void, baseRef?: BoardDrawingRef) {
  let buffer = buffers.get(boardId);
  if (!buffer) { buffer = { scene, commit, baseRef, version: 0, saved: 0, state: saved }; buffers.set(boardId, buffer); }
  buffer.scene = scene; buffer.commit = commit; buffer.version++;
  buffer.state = { status: 'dirty' };
  clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => { void persist(boardId).catch(() => {}); }, 400);
  emit();
}

export async function flushBoardDrawings(boardId?: string) {
  for (const id of boardId ? [boardId] : [...buffers.keys()]) await persist(id);
}

export function hasPendingDrawings() { return [...buffers.values()].some(buffer => buffer.saved !== buffer.version); }
