import type { ChatImageAttachment, WorkspaceData } from './types';

export const CHAT_IMAGE_LIMITS = { maxImages: 4, maxImageBytes: 8 * 1024 * 1024 } as const;
export function validateChatImages(value: unknown): asserts value is ChatImageAttachment[] {
  if (!Array.isArray(value) || value.length > CHAT_IMAGE_LIMITS.maxImages) throw new Error('每条消息最多附 4 张图片。');
  const seen = new Set<string>();
  for (const image of value) {
    if (!image || typeof image !== 'object' || Object.keys(image).some(key => !['assetId', 'hash', 'name', 'mimeType', 'size'].includes(key)) || typeof image.assetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(image.assetId) || image.assetId.includes('..')
      || typeof image.hash !== 'string' || !/^[a-f0-9]{64}$/.test(image.hash) || seen.has(image.assetId)
      || typeof image.name !== 'string' || !image.name.trim() || image.name.length > 200 || /[\x00-\x1f\x7f]/.test(image.name)
      || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)
      || !Number.isInteger(image.size) || image.size <= 0 || image.size > CHAT_IMAGE_LIMITS.maxImageBytes) throw new Error('图片附件格式无效或超过单张 8 MB。');
    seen.add(image.assetId);
  }
}
export function validateChatImageBytes(bytes: Uint8Array, image: ChatImageAttachment) {
  validateChatImages([image]);
  const png = image.mimeType === 'image/png' && bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((byte, index) => bytes[index] === byte);
  const jpeg = image.mimeType === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = image.mimeType === 'image/webp' && String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
  if (bytes.length !== image.size || !(png || jpeg || webp)) throw new Error('图片数据与声明的格式或大小不一致。');
}
export function chatImageReferences(data: Pick<WorkspaceData, 'conversations' | 'requests'>) {
  return [...Object.values(data.conversations).flatMap(item => item.chatImages ?? []), ...Object.values(data.requests).flatMap(item => item.researchRun?.chatImages ?? [])];
}
