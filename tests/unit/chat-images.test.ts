import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { contentHash, getAsset, loadWorkspace, putAsset, saveWorkspace } from '../../src/data/storage';
import { CHAT_IMAGE_LIMITS } from '../../src/domain/chat-images';
import type { ChatImageAttachment } from '../../src/domain/types';
import { attachChatImages, loadChatImage, removeChatImage } from '../../src/services/chat-images';
import { createResearchConversation } from '../../src/services/research-agent';
import { attachDrawingQuestion, setDrawingQuestionMode } from '../../src/services/drawing-question';
import { workspace } from '../../src/services/workspace';
import { drawingDigest, drawingPng, drawingQuestionFixture } from '../fixtures/drawing-question';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn(), putAsset: vi.fn(), contentHash: vi.fn() }));
const researchId = 'research-a', conversationId = 'conversation-research-a';
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const attachment = (hash = 'a'.repeat(64)): ChatImageAttachment => ({ assetId: `chat-image-${hash}`, hash, name: 'sample.png', mimeType: 'image/png', size: png.length });
const file = (name = 'sample.png', bytes = png, type = 'image/png') => new File([bytes], name, { type });
const owner = () => workspace.getState().data.conversations[conversationId];

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(createSeed());
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  vi.mocked(putAsset).mockReset().mockResolvedValue(undefined);
  vi.mocked(getAsset).mockReset().mockResolvedValue(new Blob([png], { type: 'image/png' }));
  vi.mocked(contentHash).mockReset().mockResolvedValue('a'.repeat(64));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('聊天原始图片附件', () => {
  it('保存原始字节、按hash去重，移除仅删除草稿引用', async () => {
    await attachChatImages(researchId, [file(), file('same-image.png')]);
    expect(owner().chatImages).toEqual([attachment()]);
    const [id, saved] = vi.mocked(putAsset).mock.calls[0];
    expect(id).toBe(attachment().assetId); expect(new Uint8Array(await saved.arrayBuffer())).toEqual(png);
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    await attachChatImages(researchId, [file()]);
    expect(owner().chatImages).toHaveLength(1);
    removeChatImage(researchId, attachment().assetId); expect(owner().chatImages).toBeUndefined();
    expect(await loadChatImage(attachment())).toBeInstanceOf(Blob);
  });
  it('JPEG和WebP原格式保留，不压成PNG', async () => {
    const jpeg = new Uint8Array([255, 216, 255, 224]);
    const webp = new TextEncoder().encode('RIFF1234WEBP');
    vi.mocked(contentHash).mockResolvedValueOnce('b'.repeat(64)).mockResolvedValueOnce('c'.repeat(64));
    await attachChatImages(researchId, [file('photo.jpg', jpeg, 'image/jpeg'), file('photo.webp', webp, 'image/webp')]);
    expect(owner().chatImages?.map(image => image.mimeType)).toEqual(['image/jpeg', 'image/webp']);
    const writes = vi.mocked(putAsset).mock.calls;
    expect(new Uint8Array(await writes[0][1].arrayBuffer())).toEqual(jpeg);
    expect(new Uint8Array(await writes[1][1].arrayBuffer())).toEqual(webp);
  });
  it('拒绝伪造类型、超8MiB、不可解码和批次中的坏文件，不部分附送', async () => {
    await expect(attachChatImages(researchId, [file('fake.png', new Uint8Array([1, 2, 3]))])).rejects.toThrow('格式');
    await expect(attachChatImages(researchId, [file('large.png', new Uint8Array(CHAT_IMAGE_LIMITS.maxImageBytes + 1))])).rejects.toThrow('8 MB');
    await expect(attachChatImages(researchId, [file('svg.svg', png, 'image/svg+xml')])).rejects.toThrow('格式');
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('bad image'));
    await expect(attachChatImages(researchId, [file()])).rejects.toThrow('无法解码');
    await expect(attachChatImages(researchId, [file(), file('bad.png', new Uint8Array([1]))])).rejects.toThrow('格式');
    expect(owner().chatImages).toBeUndefined(); expect(putAsset).not.toHaveBeenCalled();
  });
  it('读取核实字节格式、大小、hash及资产存在', async () => {
    expect((await loadChatImage(attachment())).type).toBe('image/png');
    vi.mocked(getAsset).mockResolvedValueOnce(undefined);
    await expect(loadChatImage(attachment())).rejects.toThrow('已缺失');
    vi.mocked(contentHash).mockResolvedValueOnce('b'.repeat(64));
    await expect(loadChatImage(attachment())).rejects.toThrow('校验失败');
    await expect(loadChatImage({ ...attachment(), size: 1 })).rejects.toThrow('大小');
    vi.mocked(getAsset).mockResolvedValueOnce(new Blob([new Uint8Array(png.length)]));
    await expect(loadChatImage(attachment())).rejects.toThrow('格式');
  });
  it('先核Blob大小和MIME，不读取与记录不符的数据库内容', async () => {
    const wrongSize = new Blob([png, new Uint8Array([0])], { type: 'image/png' });
    const sizeRead = vi.spyOn(wrongSize, 'arrayBuffer');
    vi.mocked(getAsset).mockResolvedValueOnce(wrongSize);
    await expect(loadChatImage(attachment())).rejects.toThrow('大小'); expect(sizeRead).not.toHaveBeenCalled();
    const wrongType = new Blob([png], { type: 'image/jpeg' });
    const typeRead = vi.spyOn(wrongType, 'arrayBuffer');
    vi.mocked(getAsset).mockResolvedValueOnce(wrongType);
    await expect(loadChatImage(attachment())).rejects.toThrow('格式'); expect(typeRead).not.toHaveBeenCalled();
    expect(contentHash).not.toHaveBeenCalled();
  });
  it('绘图图像也占一张，超过4图的批次不部分挂上', async () => {
    const drawing = await drawingQuestionFixture();
    workspace.updateData(data => { data.conversations[conversationId].drawingQuestion = drawing; data.conversations[conversationId].chatImages = ['b', 'c', 'd'].map(letter => attachment(letter.repeat(64))); });
    await expect(attachChatImages(researchId, [file()])).rejects.toThrow('包含所选绘图');
    expect(owner().chatImages).toHaveLength(3);
    workspace.updateData(data => { data.conversations[conversationId].drawingQuestion!.mode = 'text'; });
    await attachChatImages(researchId, [file()]); expect(owner().chatImages).toHaveLength(4);
  });
  it('已有4张普通图后拒绝再附绘图，原草稿引用不丢失', async () => {
    const question = await drawingQuestionFixture();
    const images = ['a', 'b', 'c', 'd'].map(letter => attachment(letter.repeat(64)));
    workspace.updateData(data => { data.conversations[conversationId].chatImages = images; });
    vi.mocked(contentHash).mockImplementation(async bytes => drawingDigest(bytes));
    await expect(attachDrawingQuestion(researchId, 'board-a', { image: drawingPng, width: 1, height: 1, elements: question.snapshot.elements, connections: question.snapshot.connections })).rejects.toThrow('最多 4 张');
    expect(owner().chatImages).toEqual(images); expect(owner().drawingQuestion).toBeUndefined();
  });
  it('文字绘图可以另附4图，切图片模式超限时保留原模式和所有附件', async () => {
    const question = await drawingQuestionFixture(); question.mode = 'text';
    workspace.updateData(data => { data.conversations[conversationId].drawingQuestion = question; });
    vi.mocked(contentHash).mockImplementation(async bytes => drawingDigest(bytes));
    await attachChatImages(researchId, Array.from({ length: 4 }, (_, index) => file(`image-${index}.png`, new Uint8Array([...png.slice(0, 8), index]))));
    const images = structuredClone(owner().chatImages);
    expect(images).toHaveLength(4);
    expect(() => setDrawingQuestionMode(researchId, 'image')).toThrow('最多 4 张');
    expect(owner().drawingQuestion).toEqual(question); expect(owner().chatImages).toEqual(images);
  });
  it('异步写入期间切换会话或研究不会误附；同会话并发按最新草稿合并', async () => {
    vi.mocked(putAsset).mockImplementationOnce(async () => { createResearchConversation(researchId); });
    await expect(attachChatImages(researchId, [file()])).rejects.toThrow('会话已切换');
    expect(owner().chatImages).toBeUndefined(); expect(workspace.getActiveConversation(researchId).chatImages).toBeUndefined();
    workspace.selectConversation(researchId, conversationId, { surface: 'workbench' });
    vi.mocked(putAsset).mockImplementationOnce(async () => { workspace.openResearchView('research-b', 'home'); });
    await expect(attachChatImages(researchId, [file()])).rejects.toThrow('会话已切换');
    workspace.openResearchView(researchId, 'home');
    vi.mocked(contentHash).mockResolvedValueOnce('b'.repeat(64)).mockResolvedValueOnce('c'.repeat(64));
    await Promise.all([attachChatImages(researchId, [file('first.png')]), attachChatImages(researchId, [file('second.png')])]);
    expect(owner().chatImages?.map(image => image.name)).toEqual(['first.png', 'second.png']);
  });
});
