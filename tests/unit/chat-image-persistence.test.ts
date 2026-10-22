import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { contentHash, getAsset } from '../../src/data/storage';
import { hasFullText } from '../../src/domain/knowledge';
import type { ChatImageAttachment, WorkspaceData } from '../../src/domain/types';
import { createWorkspaceBackup, readWorkspaceBackup } from '../../src/services/backup';
import { buildResearchFiles } from '../../src/services/project-files';
import { drawingPng } from '../fixtures/drawing-question';

vi.mock('../../src/data/storage', () => ({ getAsset: vi.fn(), contentHash: async (bytes: ArrayBuffer) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex') }));
const jpeg = '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/fyiiigD/9k=';
const blobs: Record<ChatImageAttachment['mimeType'], Blob> = {
  'image/png': drawingPng,
  'image/jpeg': new Blob([Buffer.from(jpeg, 'base64')], { type: 'image/jpeg' }),
  'image/webp': new Blob([Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')], { type: 'image/webp' }),
};
async function fixture() {
  const data = createSeed(), assets = new Map<string, Blob>();
  for (const document of Object.values(data.documents)) if (hasFullText(document)) {
    const blob = new Blob([`%PDF-1.4\n${document.id}`], { type: 'application/pdf' });
    document.hash = await contentHash(await blob.arrayBuffer());
    assets.set(document.assetId, blob);
  }
  const images = await Promise.all(Object.entries(blobs).map(async ([mime, blob], index) => {
    const image: ChatImageAttachment = { assetId: `chat-image-${index}`, hash: await contentHash(await blob.arrayBuffer()), name: `image-${index}.misleading-extension`, mimeType: mime as ChatImageAttachment['mimeType'], size: blob.size };
    assets.set(image.assetId, blob);
    return image;
  }));
  const conversation = data.conversations['conversation-research-a'];
  conversation.input = '';
  conversation.chatImages = [images[0]];
  conversation.requestIds = ['image-only-request'];
  data.requests['image-only-request'] = { id: 'image-only-request', researchId: 'research-a', conversationId: conversation.id, prompt: '', body: '图片回答', createdAt: '2026-10-21T00:00:00Z', status: 'done', context: [], evidenceIds: [], history: [], researchRun: { chatImages: images.slice(1) } };
  return { data, assets, images, conversation };
}
const assetEntries = (assets: Map<string, Blob>) => [...assets].map(([id, blob]) => ({ id, blob }));
async function editArchive(blob: Blob, edit: (files: Record<string, Uint8Array>, data: WorkspaceData, manifest: any) => void | Promise<void>) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const data = JSON.parse(strFromU8(files['workspace.json'])), manifest = JSON.parse(strFromU8(files['manifest.json']));
  await edit(files, data, manifest);
  files['workspace.json'] = strToU8(JSON.stringify(data));
  for (const entry of [manifest.workspace, ...manifest.assets]) if (files[entry.path]) {
    entry.size = files[entry.path].length;
    entry.hash = await contentHash(files[entry.path].buffer as ArrayBuffer);
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  return new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>]);
}

beforeEach(() => { vi.mocked(getAsset).mockReset(); });
describe('聊天图片的刷新、完整备份与研究目录', () => {
  it('仅图草稿与已发送 PNG/JPEG/WebP 在刷新迁移和 ZIP 往返后保留引用及真实资产，不向 JSON 塞 dataUrl', async () => {
    const { data, assets, images, conversation } = await fixture(), before = structuredClone(data);
    const migrated = migrateWorkspace(JSON.parse(JSON.stringify(data)));
    expect(migrated.conversations[conversation.id].chatImages).toEqual([images[0]]);
    expect(migrated.requests['image-only-request'].researchRun?.chatImages).toEqual(images.slice(1));
    const blob = await createWorkspaceBackup(data, assetEntries(assets)), restored = await readWorkspaceBackup(blob);
    expect(restored.data.conversations[conversation.id].chatImages).toEqual([images[0]]);
    expect(restored.data.requests['image-only-request'].researchRun?.chatImages).toEqual(images.slice(1));
    for (const image of images) {
      const restoredBlob = restored.assets.find(asset => asset.id === image.assetId)!.blob;
      expect(restoredBlob.type).toBe(image.mimeType);
      expect(Buffer.from(await restoredBlob.arrayBuffer())).toEqual(Buffer.from(await assets.get(image.assetId)!.arrayBuffer()));
    }
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer())), json = strFromU8(files['workspace.json']);
    expect(json).not.toContain('data:image/'); expect(json).not.toContain('dataUrl');
    expect(restored.summary.assets).toBe(assets.size); expect(data).toEqual(before);
  });

  it('接受尚无聊天图片字段的旧版本备份', async () => {
    const { data, assets } = await fixture();
    delete data.conversations['conversation-research-a'].chatImages;
    delete data.requests['image-only-request'].researchRun;
    const archive = await createWorkspaceBackup(data, assetEntries(assets));
    const legacy = await editArchive(archive, (_files, workspace) => {
      Object.assign(workspace, { schemaVersion: 2 });
      delete workspace.documents['paper-stub'];
      workspace.researches['research-a'].documentIds = workspace.researches['research-a'].documentIds.filter(id => id !== 'paper-stub');
    });
    expect((await readWorkspaceBackup(legacy)).data.schemaVersion).toBe(3);
  });

  it.each(['missing', 'mime', 'size', 'hash', 'header', 'conflicting-hash'] as const)('导出前拒绝 %s，不能产生丢图或误导恢复的 ZIP', async kind => {
    const { data, assets, images, conversation } = await fixture(), image = images[0], blob = assets.get(image.assetId)!;
    if (kind === 'missing') assets.delete(image.assetId);
    if (kind === 'mime') assets.set(image.assetId, new Blob([await blob.arrayBuffer()], { type: 'image/jpeg' }));
    if (kind === 'size') image.size++;
    if (kind === 'hash') image.hash = 'a'.repeat(64);
    if (kind === 'header') {
      const corrupt = new Blob([new Uint8Array(blob.size)], { type: image.mimeType });
      assets.set(image.assetId, corrupt); image.hash = await contentHash(await corrupt.arrayBuffer());
    }
    if (kind === 'conflicting-hash') data.requests['image-only-request'].researchRun!.chatImages = [{ ...image, hash: 'b'.repeat(64) }];
    expect(conversation.chatImages).toBeDefined();
    await expect(createWorkspaceBackup(data, assetEntries(assets))).rejects.toThrow(/图片|hash|格式|大小/);
  });

  it.each(['missing', 'mime', 'size', 'hash', 'header', 'conflicting-hash', 'data-url'] as const)('即使重算清单，恢复前仍拒绝 %s 语义篡改', async kind => {
    const { data, assets, images } = await fixture(), image = images[0];
    const archive = await createWorkspaceBackup(data, assetEntries(assets));
    const edited = await editArchive(archive, async (files, workspace, manifest) => {
      const stored = workspace.conversations['conversation-research-a'].chatImages![0];
      if (kind === 'missing') { delete files[`assets/${image.assetId}`]; manifest.assets = manifest.assets.filter((entry: any) => entry.id !== image.assetId); }
      if (kind === 'mime') manifest.assets.find((entry: any) => entry.id === image.assetId).type = 'image/jpeg';
      if (kind === 'size') stored.size++;
      if (kind === 'hash') stored.hash = 'a'.repeat(64);
      if (kind === 'header') { files[`assets/${image.assetId}`].fill(0); stored.hash = await contentHash(files[`assets/${image.assetId}`].buffer as ArrayBuffer); }
      if (kind === 'conflicting-hash') workspace.requests['image-only-request'].researchRun!.chatImages = [{ ...stored, hash: 'b'.repeat(64) }];
      if (kind === 'data-url') Object.assign(stored, { dataUrl: 'data:image/png;base64,AAAA' });
    });
    await expect(readWorkspaceBackup(edited)).rejects.toThrow(/图片|hash|格式|大小|缺少/);
  });

  it('研究目录按真实 MIME 导出并校验 bytes/hash，图片仅为附件；待发送与已发送轮次保留且研究隔离', async () => {
    const { data, assets, images, conversation } = await fixture();
    images[0].name = '../[unsafe](name)<tag>.jpg';
    const privateImage = { ...images[0], assetId: 'other-research-image', name: '另一个研究的私有图片.png' };
    assets.set(privateImage.assetId, blobs['image/png']);
    data.conversations['conversation-research-b'].chatImages = [privateImage];
    const drawingBlob = new Blob([JSON.stringify({ type: 'excalidraw', version: 2, source: 'fixture', elements: [], appState: { viewBackgroundColor: '#fff', scrollX: 0, scrollY: 0, zoom: { value: 1 } }, files: {} })], { type: 'application/vnd.excalidraw+json' });
    const drawingHash = await contentHash(await drawingBlob.arrayBuffer()), drawingId = `drawing-${drawingHash}`;
    data.boards['board-a'].drawing = { assetId: drawingId, hash: drawingHash };
    assets.set(drawingId, drawingBlob);
    vi.mocked(getAsset).mockImplementation(async id => assets.get(id));
    const before = structuredClone(data), { files } = await buildResearchFiles(data, 'research-a'), map = Object.fromEntries(files.map(file => [file.path, file]));
    const markdown = map[`sessions/${conversation.id}.md`].content, structured = JSON.parse(map['research.json'].content);
    for (const [index, image] of images.entries()) {
      const path = `images/${image.assetId}.${['png', 'jpg', 'webp'][index]}`, file = map[path];
      expect(file.encoding).toBe('base64'); expect(file.hash).toBe(image.hash);
      expect(Buffer.from(file.content, 'base64')).toEqual(Buffer.from(await assets.get(image.assetId)!.arrayBuffer()));
      expect(structured.assets[image.assetId]).toMatchObject({ path, hash: image.hash, type: image.mimeType });
      expect(markdown).toContain(`(../${path})`);
    }
    expect(markdown).toContain('## 未发送输入'); expect(markdown).toContain('图片回答');
    expect(markdown).toContain('../\\[unsafe\\](name)\\<tag\\>.jpg');
    expect(markdown).toContain('不作为 PDF 原文证据'); expect(markdown).not.toMatch(/PDF 第 \d+ 页/);
    expect(structured.entities.conversations[conversation.id].chatImages).toEqual([images[0]]);
    expect(structured.entities.requests['image-only-request'].researchRun.chatImages).toEqual(images.slice(1));
    expect(map['research.json'].content).not.toContain('data:image/');
    expect(map[`drawings/${drawingId}.excalidraw`]).toBeDefined();
    expect(JSON.stringify(files)).not.toContain(privateImage.assetId); expect(JSON.stringify(files)).not.toContain(privateImage.name);
    expect(files.every(file => !file.path.includes('unsafe'))).toBe(true); expect(data).toEqual(before);
    const other = await buildResearchFiles(data, 'research-b');
    for (const image of images) expect(other.files.some(file => file.path.startsWith(`images/${image.assetId}.`))).toBe(false);
  });

  it.each(['missing', 'mime', 'size', 'hash', 'header', 'conflicting-hash'] as const)('已导出过后目录缓存也不能掩盖 %s', async kind => {
    const { data, assets, images } = await fixture(), image = images[0], blob = assets.get(image.assetId)!;
    vi.mocked(getAsset).mockImplementation(async id => assets.get(id));
    await buildResearchFiles(data, 'research-a');
    if (kind === 'missing') assets.delete(image.assetId);
    if (kind === 'mime') assets.set(image.assetId, new Blob([await blob.arrayBuffer()], { type: 'image/jpeg' }));
    if (kind === 'size') image.size++;
    if (kind === 'hash') image.hash = 'a'.repeat(64);
    if (kind === 'header') { const corrupt = new Blob([new Uint8Array(blob.size)], { type: image.mimeType }); assets.set(image.assetId, corrupt); image.hash = await contentHash(await corrupt.arrayBuffer()); }
    if (kind === 'conflicting-hash') data.requests['image-only-request'].researchRun!.chatImages = [{ ...image, hash: 'b'.repeat(64) }];
    await expect(buildResearchFiles(data, 'research-a')).rejects.toThrow(/图片|hash|格式|大小/);
  });
});
