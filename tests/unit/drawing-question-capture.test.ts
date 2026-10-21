import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { BoardPlacement, WorkspaceData } from '../../src/domain/types';
import { captureDrawingQuestion, prepareDrawingQuestion } from '../../src/features/board/drawing-question-capture';

const renderer = vi.hoisted(() => ({ exportToBlob: vi.fn(), convertToExcalidrawElements: vi.fn() }));
vi.mock('@excalidraw/excalidraw', () => renderer);

const element = (id: string, type = 'rectangle', fields: Record<string, unknown> = {}) => ({
  id, type, x: 12, y: 30, width: 120, height: 80, angle: 0, isDeleted: false,
  frameId: null, boundElements: null, ...fields,
}) as ExcalidrawElement;
const selection = (...ids: string[]) => ({ selectedElementIds: Object.fromEntries(ids.map(id => [id, true as const])), selectedGroupIds: {} });
const state = (...ids: string[]) => ({ ...selection(...ids), viewBackgroundColor: '#fff' }) as AppState;
const placement: BoardPlacement = { id: 'placement', boardId: 'board', resourceRef: { kind: 'card', id: 'card' }, x: 12, y: 30, group: '' };
const resources = () => ({ cards: { card: { id: 'card', title: 'Selected card', body: 'The whole current card body.', evidenceIds: ['not-a-pdf-input'], needsReview: false } }, documents: {} }) satisfies Pick<WorkspaceData, 'cards' | 'documents'>;
const binary = (id: string) => ({ id, dataURL: 'data:image/png;base64,selected-file', mimeType: 'image/png', created: 0 }) as unknown as BinaryFiles[string];
function png(width = 640, height = 480, size = 24) {
  const bytes = new Uint8Array(size), header = new DataView(bytes.buffer);
  header.setUint32(0, 0x89504e47); header.setUint32(4, 0x0d0a1a0a);
  header.setUint32(12, 0x49484452); header.setUint32(16, width); header.setUint32(20, height);
  return new Blob([bytes], { type: 'image/png' });
}

beforeEach(() => {
  renderer.exportToBlob.mockReset().mockResolvedValue(png());
  renderer.convertToExcalidrawElements.mockReset().mockImplementation(elements => elements);
});

describe('drawing question content', () => {
  it('sends only selected elements, their bound labels and their image files, never enclosed or connected outside content', () => {
    const scene = [
      element('shape', 'rectangle', { frameId: 'outside-frame', boundElements: [{ id: 'label', type: 'text' }, { id: 'outside-arrow', type: 'arrow' }] }),
      element('label', 'text', { containerId: 'shape', text: 'Selected label' }),
      element('arrow', 'arrow', { startBinding: { elementId: 'shape' }, endBinding: { elementId: 'outside' }, startArrowhead: null, endArrowhead: 'arrow' }),
      element('inside-but-not-selected', 'text', { text: 'Private enclosed note' }),
      element('outside', 'rectangle'), element('outside-frame', 'frame'), element('outside-arrow', 'arrow'),
      element('image', 'image', { fileId: 'selected-file', status: 'saved' }),
      element('outside-image', 'image', { fileId: 'private-file', status: 'saved' }),
    ];
    const prepared = prepareDrawingQuestion(scene, selection('shape', 'arrow', 'image'), {
      'selected-file': binary('selected-file'), 'private-file': binary('private-file'),
    }, [], resources());
    expect(prepared.elements.map(item => item.id)).toEqual(['shape', 'label', 'arrow', 'image']);
    expect(Object.keys(prepared.files)).toEqual(['selected-file']);
    expect(prepared.connections).toEqual([{ id: 'arrow', startId: 'shape', endOutside: true, startArrowhead: null, endArrowhead: 'arrow' }]);
    expect(prepared.renderElements[0]).toMatchObject({ frameId: null, boundElements: [{ id: 'label', type: 'text' }] });
    expect(prepared.renderElements[2]).toMatchObject({ endBinding: null });
    expect(scene[0]).toMatchObject({ frameId: 'outside-frame' });
    expect(JSON.stringify(prepared)).not.toContain('Private enclosed note');
  });

  it('freezes complete selected card content and metadata without pulling its evidence or mutating the card', () => {
    const data = resources();
    const prepared = prepareDrawingQuestion([element('embed', 'embeddable', { customData: { placementId: 'placement' } })], selection('embed'), {}, [placement], data);
    data.cards.card.body = 'A later edit';
    expect(prepared.elements[0]).toMatchObject({ id: 'embed', x: 12, y: 30, resource: { ref: { kind: 'card', id: 'card' }, title: 'Selected card', body: 'The whole current card body.' } });
    expect(JSON.stringify(prepared)).not.toContain('not-a-pdf-input');
    expect(data.cards.card.body).toBe('A later edit');
  });

  it('includes only a selected document entry description, not raw PDF text or discovered abstract', () => {
    const data: Pick<WorkspaceData, 'cards' | 'documents'> = { cards: {}, documents: {
      paper: { id: 'paper', title: 'Paper title', authors: 'One Author', year: '2026', filename: 'paper.pdf', pageCount: 14, assetId: 'private-pdf', hash: 'a'.repeat(64), readingStatus: 'unread', textStatus: 'ready' },
    } };
    const result = prepareDrawingQuestion([element('embed', 'embeddable', { customData: { placementId: 'placement' } })], selection('embed'), {}, [{ ...placement, resourceRef: { kind: 'document', id: 'paper' } }], data);
    expect(result.elements[0].resource).toEqual({ ref: { kind: 'document', id: 'paper' }, title: 'Paper title', body: 'One Author · 2026\n14 页' });
    expect(JSON.stringify(result)).not.toContain('private-pdf');
  });

  it('accepts a complete local pending image and rejects an errored or remote file', () => {
    const scene = [element('image', 'image', { fileId: 'file', status: 'pending' })];
    expect(prepareDrawingQuestion(scene, selection('image'), { file: binary('file') }, [], resources()).files).toHaveProperty('file');
    expect(() => prepareDrawingQuestion([element('image', 'image', { fileId: 'file', status: 'error' })], selection('image'), { file: binary('file') }, [], resources())).toThrow('尚未加载完整');
    expect(() => prepareDrawingQuestion(scene, selection('image'), { file: { ...binary('file'), dataURL: 'https://private.example/image' as BinaryFiles[string]['dataURL'] } }, [], resources())).toThrow('尚未加载完整');
  });

  it('rejects too many selected/frame elements, oversized complete text, missing resource and unloaded images', () => {
    expect(() => prepareDrawingQuestion([], selection(), {}, [], resources())).toThrow('请先选择');
    const hundred = Array.from({ length: 100 }, (_, i) => element(`e-${i}`, 'rectangle', { frameId: 'frame' }));
    expect(() => prepareDrawingQuestion([...hundred, element('frame', 'frame')], selection('frame'), {}, [], resources())).toThrow('100 个元素');
    expect(() => prepareDrawingQuestion([element('text', 'text', { text: 'x'.repeat(12001) })], selection('text'), {}, [], resources())).toThrow('12,000');
    const data = resources(); data.cards.card.body = 'x'.repeat(12000);
    expect(() => prepareDrawingQuestion([element('card', 'embeddable', { customData: { placementId: 'placement' } })], selection('card'), {}, [placement], data)).toThrow('12,000');
    expect(() => prepareDrawingQuestion([element('card', 'embeddable', { customData: { placementId: 'missing' } })], selection('card'), {}, [], resources())).toThrow('摆放已缺失');
    expect(() => prepareDrawingQuestion([element('image', 'image', { fileId: 'missing', status: 'saved' })], selection('image'), {}, [], resources())).toThrow('尚未加载完整');
    expect(() => prepareDrawingQuestion([element('shape', 'rectangle', { x: NaN })], selection('shape'), {}, [], resources())).toThrow('位置或尺寸无效');
  });
});

describe('drawing question PNG export', () => {
  it('renders selected content and honest resource placeholders with scene embedding disabled', async () => {
    const source = [element('card', 'embeddable', { customData: { placementId: 'placement' } }), element('private', 'text', { text: 'Do not send' })];
    const data = resources();
    const capture = captureDrawingQuestion(source, state('card'), {}, [placement], data);
    data.cards.card.body = 'An edit after clicking';
    const result = await capture;
    expect(result).toMatchObject({ width: 640, height: 480, elements: [{ resource: { body: 'The whole current card body.' } }] });
    const sent = renderer.exportToBlob.mock.calls[0][0];
    expect(sent.appState).toMatchObject({ exportEmbedScene: false, exportScale: 1, exportBackground: true });
    expect(sent.maxWidthOrHeight).toBe(2048);
    expect(sent.elements).toHaveLength(1);
    expect(sent.elements[0]).toMatchObject({ id: 'card', type: 'rectangle', label: { text: '卡片 1\n文字另附' } });
    expect(JSON.stringify(sent)).not.toContain('Do not send');
    expect(source[0].type).toBe('embeddable');
  });

  it('rejects oversized, malformed or over-dimension exported PNG without truncating content', async () => {
    const source = [element('shape')];
    renderer.exportToBlob.mockResolvedValueOnce(png(640, 480, 2 * 1024 * 1024 + 1));
    await expect(captureDrawingQuestion(source, state('shape'), {}, [], resources())).rejects.toThrow('2 MiB');
    renderer.exportToBlob.mockResolvedValueOnce(new Blob(['bad png']));
    await expect(captureDrawingQuestion(source, state('shape'), {}, [], resources())).rejects.toThrow('导出失败');
    renderer.exportToBlob.mockResolvedValueOnce(png(2049, 480));
    await expect(captureDrawingQuestion(source, state('shape'), {}, [], resources())).rejects.toThrow('尺寸无效');
  });

  it('fails a selected image decode rather than sending the native missing-image placeholder', async () => {
    vi.stubGlobal('Image', class { src = ''; decode() { return Promise.reject(new Error('bad image')); } });
    try {
      await expect(captureDrawingQuestion([element('image', 'image', { fileId: 'file', status: 'pending' })], state('image'), { file: binary('file') }, [], resources())).rejects.toThrow('无法解码');
      expect(renderer.exportToBlob).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
