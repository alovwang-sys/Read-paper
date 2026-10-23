import type { DrawingSnapshot } from '../domain/types';
import { drawingSnapshotContent, hasDrawingText, validateDrawingPng, validateDrawingQuestion } from '../domain/drawing-question';
import { contentHash, getAsset, putAsset } from '../data/storage';
import { getActiveConversation, uid, workspace } from './workspace';
import { createResearchConversation, isResearchConversation } from './research-agent';

export { hasDrawingText };

export async function verifyDrawingSnapshot(snapshot: DrawingSnapshot) {
  validateDrawingQuestion({ snapshot, mode: 'image' });
  if (await contentHash(new TextEncoder().encode(drawingSnapshotContent(snapshot)).buffer) !== snapshot.hash) throw new Error('绘图快照校验失败，请重新框选。');
}

export async function loadDrawingImage(snapshot: DrawingSnapshot) {
  await verifyDrawingSnapshot(snapshot);
  const blob = await getAsset(snapshot.image.assetId);
  if (!blob) throw new Error('当时的绘图图片已缺失，请恢复备份或重新框选。');
  const bytes = await blob.arrayBuffer();
  validateDrawingPng(bytes, snapshot.image);
  if (await contentHash(bytes) !== snapshot.image.hash) throw new Error('绘图图片校验失败，未发送。');
  return new Blob([bytes], { type: 'image/png' });
}

/** One click lands in a thread: a single selected card continues that card's thread, anything else the board's. */
export function openDrawingConversation(researchId: string, boardId: string, selection: { placementIds: string[]; elementIds: string[] }) {
  const data = workspace.getState().data;
  const ref = selection.elementIds.length === 1 && selection.placementIds.length === 1 ? data.placements[selection.placementIds[0]]?.resourceRef : undefined;
  const anchor = ref?.kind === 'card' && data.cards[ref.id] ? { kind: 'card' as const, id: ref.id } : { kind: 'board' as const, id: boardId };
  const existing = Object.values(data.conversations)
    .filter(item => item.researchId === researchId && !item.archived && item.anchor?.kind === anchor.kind && item.anchor.id === anchor.id && isResearchConversation(data, item))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
  const id = existing?.id ?? createResearchConversation(researchId, undefined, { navigate: false });
  if (existing) workspace.selectConversation(researchId, id, { surface: 'workbench' });
  workspace.updateData(next => {
    if (!existing) Object.assign(next.conversations[id], { anchor, title: anchor.kind === 'card' ? `卡片：${next.cards[anchor.id].title}` : `白板：${next.boards[boardId].title}` });
    const session = next.sessions[researchId];
    if (session.agentChat?.mode !== 'float') session.agentChat = { ...session.agentChat, mode: 'side' };
  });
  return id;
}

export async function attachDrawingQuestion(researchId: string, boardId: string, capture: {
  image: Blob; width: number; height: number;
  elements: DrawingSnapshot['elements']; connections: DrawingSnapshot['connections'];
  conversationId?: string; generation?: number;
}) {
  const data = workspace.getState().data, conversation = getActiveConversation(data, researchId);
  const generation = workspace.getGeneration();
  if (data.scope.kind !== 'research' || data.scope.researchId !== researchId) throw new Error('研究已切换，请在目标研究中重新框选。');
  if (!conversation || !isResearchConversation(data, conversation)) throw new Error('请先在研究工作台新建会话，再框选问 Agent；原会话已保留。');
  if (data.boards[boardId]?.researchId !== researchId) throw new Error('白板不属于这个研究。');
  if ((capture.conversationId && capture.conversationId !== conversation.id) || (capture.generation !== undefined && capture.generation !== generation)) throw new Error('会话已切换，请在目标会话中重新框选。');
  const snapshot: DrawingSnapshot = {
    id: uid('drawing-question'), boardId, boardTitle: data.boards[boardId].title, createdAt: new Date().toISOString(), hash: '0'.repeat(64),
    image: { assetId: 'pending', hash: '0'.repeat(64), width: capture.width, height: capture.height },
    elements: structuredClone(capture.elements), connections: structuredClone(capture.connections),
  };
  validateDrawingQuestion({ snapshot, mode: 'image' });
  const research = data.researches[researchId];
  if (snapshot.elements.some(element => element.resource && !(element.resource.ref.kind === 'card' ? research.cardIds.includes(element.resource.ref.id) : research.documentIds.includes(element.resource.ref.id)))) throw new Error('选区中的资源不属于这个研究，请重新选择。');
  const bytes = await capture.image.arrayBuffer();
  validateDrawingPng(bytes, snapshot.image);
  snapshot.image.hash = await contentHash(bytes); snapshot.image.assetId = `drawing-question-${snapshot.image.hash}`;
  snapshot.hash = await contentHash(new TextEncoder().encode(drawingSnapshotContent(snapshot)).buffer);
  await putAsset(snapshot.image.assetId, new Blob([bytes], { type: 'image/png' }));
  const current = workspace.getState().data;
  if (workspace.getGeneration() !== generation || current.scope.kind !== 'research' || current.scope.researchId !== researchId || getActiveConversation(current, researchId)?.id !== conversation.id) throw new Error('会话已切换，请在目标会话中重新框选。');
  workspace.updateData(next => {
    if (next.boards[boardId]?.researchId !== researchId) throw new Error('白板已移出当前研究，请重新选择。');
    const owner = next.conversations[conversation.id];
    if ((owner.chatImages?.length ?? 0) >= 4) throw new Error('每条消息最多 4 张图片，绘图选区也占一张；请先移除一张附件。');
    owner.drawingQuestion = { snapshot, mode: 'image' };
    delete owner.researchFocus;
  });
  workspace.notice(`已附到「${workspace.getState().data.conversations[conversation.id].title ?? '当前会话'}」，直接输入问题即可；未追加论文原文。`);
}

export function removeDrawingQuestion(researchId: string) {
  const conversation = getActiveConversation(workspace.getState().data, researchId);
  if (conversation) workspace.updateData(data => { delete data.conversations[conversation.id].drawingQuestion; });
}
export function setDrawingQuestionMode(researchId: string, mode: 'image' | 'text') {
  const conversation = getActiveConversation(workspace.getState().data, researchId);
  if (conversation) workspace.updateData(data => {
    const question = data.conversations[conversation.id].drawingQuestion;
    if (!question) return;
    if (mode === 'image' && (data.conversations[conversation.id].chatImages?.length ?? 0) >= 4) throw new Error('每条消息最多 4 张图片，请先移除一张附件。');
    validateDrawingQuestion({ ...question, mode });
    question.mode = mode;
  });
}
