import type { ChatImageAttachment } from '../domain/types';
import { CHAT_IMAGE_LIMITS, validateChatImageBytes, validateChatImages } from '../domain/chat-images';
import { contentHash, getAsset, putAsset } from '../data/storage';
import { getActiveConversation, workspace } from './workspace';
import { isResearchConversation } from './research-agent';

export async function loadChatImage(image: ChatImageAttachment) {
  validateChatImages([image]);
  const blob = await getAsset(image.assetId);
  if (!blob) throw new Error(`图片「${image.name}」已缺失，请重新添加或恢复备份。`);
  if (blob.size !== image.size || blob.type !== image.mimeType) throw new Error(`图片「${image.name}」的数据格式或大小与附件记录不一致，未发送。`);
  const bytes = await blob.arrayBuffer();
  validateChatImageBytes(new Uint8Array(bytes), image);
  if (await contentHash(bytes) !== image.hash) throw new Error(`图片「${image.name}」校验失败，未发送。`);
  return new Blob([bytes], { type: image.mimeType });
}

export async function attachChatImages(researchId: string, files: File[]) {
  if (!files.length) return;
  const data = workspace.getState().data, conversation = getActiveConversation(data, researchId), generation = workspace.getGeneration();
  if (data.scope.kind !== 'research' || data.scope.researchId !== researchId) throw new Error('研究已切换，请在目标研究中重新添加图片。');
  if (!conversation || !isResearchConversation(data, conversation)) throw new Error('请先在研究工作台新建会话，再添加图片；原会话已保留。');
  if (files.length > CHAT_IMAGE_LIMITS.maxImages) throw new Error('每条消息最多附 4 张图片。');
  const prepared: { image: ChatImageAttachment; blob: Blob }[] = [];
  for (const file of files) {
    const image: ChatImageAttachment = { assetId: 'pending', hash: '0'.repeat(64), name: file.name, mimeType: file.type as ChatImageAttachment['mimeType'], size: file.size };
    validateChatImages([image]);
    const bytes = await file.arrayBuffer();
    validateChatImageBytes(new Uint8Array(bytes), image);
    if (typeof createImageBitmap === 'function') {
      try { const decoded = await createImageBitmap(file); decoded.close(); }
      catch { throw new Error(`图片「${file.name}」无法解码，请换一张有效的 PNG、JPEG 或 WebP。`); }
    }
    image.hash = await contentHash(bytes); image.assetId = `chat-image-${image.hash}`;
    if (!prepared.some(item => item.image.hash === image.hash)) prepared.push({ image, blob: new Blob([bytes], { type: image.mimeType }) });
  }
  for (const item of prepared) await putAsset(item.image.assetId, item.blob);
  const current = workspace.getState().data;
  if (workspace.getGeneration() !== generation || current.scope.kind !== 'research' || current.scope.researchId !== researchId || getActiveConversation(current, researchId)?.id !== conversation.id) throw new Error('会话已切换，请在目标会话中重新添加图片。');
  workspace.updateData(next => {
    const owner = next.conversations[conversation.id];
    const images = [...(owner.chatImages ?? [])];
    for (const { image } of prepared) if (!images.some(item => item.hash === image.hash)) images.push(image);
    validateChatImages(images);
    if (images.length + (owner.drawingQuestion?.mode === 'image' ? 1 : 0) > CHAT_IMAGE_LIMITS.maxImages) throw new Error('每条消息最多附 4 张图片，包含所选绘图。');
    owner.chatImages = images;
  });
}

export function removeChatImage(researchId: string, assetId: string) {
  const conversation = getActiveConversation(workspace.getState().data, researchId);
  if (conversation) workspace.updateData(data => {
    const owner = data.conversations[conversation.id];
    owner.chatImages = owner.chatImages?.filter(image => image.assetId !== assetId);
    if (!owner.chatImages?.length) delete owner.chatImages;
  });
}
