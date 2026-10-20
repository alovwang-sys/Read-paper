import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentHash, getAsset, putAsset } from '../../src/data/storage';
import { boardContextForModel, parseDrawingScene, type DrawingScene } from '../../src/domain/drawing';
import { captureBoardContext, recordBoardChanges } from '../../src/domain/board-history';
import { createSeed } from '../../src/data/seed';
import { flushBoardDrawings, getDrawingSaveState, hasPendingDrawings, loadBoardDrawing, stageBoardDrawing } from '../../src/services/drawing-storage';

vi.mock('../../src/data/storage', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/data/storage')>(), getAsset: vi.fn(), putAsset: vi.fn(),
}));
const assets = new Map<string, Blob>();
const scene = (background = '#fff'): DrawingScene => ({ type: 'excalidraw', version: 2, source: 'Papertrail', elements: [], appState: { viewBackgroundColor: background, scrollX: 0, scrollY: 0, zoom: { value: 1 } }, files: {} });
beforeEach(() => {
  assets.clear();
  vi.mocked(getAsset).mockImplementation(async id => assets.get(id));
  vi.mocked(putAsset).mockImplementation(async (id, blob) => { assets.set(id, blob); });
});
afterEach(async () => {
  vi.mocked(putAsset).mockImplementation(async (id, blob) => { assets.set(id, blob); });
  await flushBoardDrawings();
  vi.clearAllMocks();
});

describe('immutable drawing saves', () => {
  it('coalesces updates and saves the asset before committing its ref', async () => {
    const commit = vi.fn(ref => { expect(assets.has(ref.assetId)).toBe(true); });
    stageBoardDrawing('drawing-a', scene('#eee'), commit);
    stageBoardDrawing('drawing-a', scene('#fff'), commit);
    await flushBoardDrawings();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(putAsset).toHaveBeenCalledTimes(1);
    const ref = commit.mock.calls[0][0];
    expect(ref.assetId).toBe(`drawing-${ref.hash}`);
    expect(await loadBoardDrawing('drawing-a', ref)).toEqual(scene());
    expect(hasPendingDrawings()).toBe(false);
  });

  it('retains the previous ref and pending scene on failure, then retries', async () => {
    const data = createSeed(), board = data.boards['board-a'];
    const commit = vi.fn(ref => { board.drawing = ref; });
    vi.mocked(putAsset).mockRejectedValueOnce(new Error('磁盘已满'));
    stageBoardDrawing(board.id, scene(), commit);
    await expect(flushBoardDrawings(board.id)).rejects.toThrow('磁盘已满');
    expect(commit).not.toHaveBeenCalled();
    expect(board.drawing).toBeUndefined();
    expect(getDrawingSaveState(board.id).status).toBe('error');
    expect(await loadBoardDrawing(board.id)).toEqual(scene());
    await flushBoardDrawings(board.id);
    expect(board.drawing).toBeDefined();
    expect(getDrawingSaveState(board.id).status).toBe('saved');
  });

  it('does not commit an outdated scene when edits arrive during an asset write', async () => {
    let release!: () => void;
    let started!: () => void;
    const firstWrite = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(putAsset).mockImplementationOnce(async (id, blob) => {
      started(); await new Promise<void>(resolve => { release = resolve; }); assets.set(id, blob);
    });
    const commit = vi.fn();
    stageBoardDrawing('drawing-race', scene('#eee'), commit);
    const saving = flushBoardDrawings('drawing-race');
    await firstWrite;
    stageBoardDrawing('drawing-race', scene('#fff'), commit);
    release(); await saving;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await loadBoardDrawing('drawing-race', commit.mock.calls[0][0])).toEqual(scene());
  });

  it('rejects missing/corrupted assets and damaged attachments', async () => {
    const hash = 'a'.repeat(64), ref = { assetId: `drawing-${hash}`, hash };
    await expect(loadBoardDrawing('missing', ref)).rejects.toThrow('缺失');
    assets.set(ref.assetId, new Blob(['not the saved drawing']));
    await expect(loadBoardDrawing('corrupt', ref)).rejects.toThrow('校验');
    const broken = { ...scene(), files: { image: { id: 'image', mimeType: 'image/png', dataURL: 'data:image/png;base64,bm90IGFuIGltYWdl' } } };
    expect(() => parseDrawingScene(JSON.stringify(broken))).toThrow('文件头');
  });

  it('preserves drawing refs in history and removes them from model context', async () => {
    const before = createSeed(), next = structuredClone(before);
    const bytes = new TextEncoder().encode(JSON.stringify(scene()));
    const hash = await contentHash(bytes.buffer);
    next.boards['board-a'].drawing = { assetId: `drawing-${hash}`, hash };
    next.boards['board-a'].layout = 'tree';
    recordBoardChanges(before, next);
    expect(Object.values(next.boardChanges!)[0].after?.board.drawing?.hash).toBe(hash);
    const context = captureBoardContext(next, 'research-a', 'board-a', 'board');
    expect(context.snapshot.board.drawing?.hash).toBe(hash);
    expect(boardContextForModel(context).snapshot.board.drawing).toBeUndefined();
    expect(boardContextForModel(context).snapshot.board.layout).toBe('tree');
    expect(context.snapshot.board.drawing?.hash).toBe(hash);
  });
});
