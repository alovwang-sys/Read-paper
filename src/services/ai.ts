import type {
  AIRequest,
  ContextSnapshot,
  WorkspaceData,
} from '../domain/types';
import { getAsset } from '../data/storage';
import { remapCitationNumbers } from '../domain/citations';
import { uid, validateEvidence, workspace } from './workspace';

export function snapshotContext(
  data: WorkspaceData,
  researchId: string,
  conversationId: string,
): ContextSnapshot[] {
  const research = data.researches[researchId],
    conversation = data.conversations[conversationId];
  if (!research || !conversation || conversation.researchId !== researchId)
    throw new Error('会话不属于当前研究');
  const evidence = validateEvidence(data, conversation.contextIds);
  if (!evidence.length) throw new Error('请先显式添加至少一条证据');
  if (evidence.some((item) => !research.documentIds.includes(item.documentId)))
    throw new Error('上下文来源不属于当前研究');
  if (
    evidence.reduce((total, item) => total + item.quote.length, 0) > 24000 ||
    evidence.length > 16
  )
    throw new Error('上下文过大，请缩小到 16 条、24,000 字以内');
  return evidence.map((item) => {
    const doc = data.documents[item.documentId];
    if (!doc.hash) throw new Error('来源文件尚未就绪，请先打开相应 PDF');
    return {
      evidenceId: item.id,
      documentId: doc.id,
      documentHash: doc.hash,
      title: doc.title,
      pageIndex: item.pageIndex,
      quote: item.quote,
    };
  });
}
export function validateResponse(
  data: WorkspaceData,
  request: AIRequest,
  evidenceIds: string[],
  body = request.body,
) {
  const allowed = new Set(request.context.map((item) => item.evidenceId));
  if (evidenceIds.some((id) => !allowed.has(id)))
    throw new Error('回答包含本次上下文之外的引用，已阻止保存');
  validateEvidence(data, evidenceIds);
  remapCitationNumbers(body, evidenceIds, evidenceIds);
  for (const snapshot of request.context)
    if (
      !data.documents[snapshot.documentId] ||
      data.documents[snapshot.documentId].hash !== snapshot.documentHash ||
      data.evidence[snapshot.evidenceId]?.quote !== snapshot.quote ||
      data.evidence[snapshot.evidenceId]?.pageIndex !== snapshot.pageIndex
    )
      throw new Error('请求来源已变化，请重新选择证据');
}
export function appendAIToDraft(
  data: WorkspaceData,
  draftId: string,
  request: AIRequest,
) {
  validateResponse(data, request, request.evidenceIds);
  const draft = data.drafts[draftId];
  if (!draft || draft.researchId !== request.researchId)
    throw new Error('结论不属于本次请求的研究');
  const merged = [...new Set([...draft.evidenceIds, ...request.evidenceIds])];
  const body = remapCitationNumbers(request.body, request.evidenceIds, merged);
  draft.body += `\n\n${body}`;
  draft.evidenceIds = merged;
}
export type AIResponder = (
  request: AIRequest,
) => Promise<{ body: string; evidenceIds: string[] }>;
export const demoResponder: AIResponder = async (request) => {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return {
    body: `演示草稿：${request.prompt}\n\n${request.context.map((item, index) => `材料 ${index + 1}（${item.title}，PDF 第 ${item.pageIndex + 1} 页）：\n“${item.quote}” [${index + 1}]`).join('\n\n')}\n\n请基于上述原文补充你的比较、适用条件与限制。本段为固定演示响应，未调用真实模型。`,
    evidenceIds: request.context.map((item) => item.evidenceId),
  };
};
export async function submitAI(
  researchId: string,
  conversationId: string,
  prompt: string,
  responder: AIResponder = demoResponder,
) {
  if (!prompt.trim()) throw new Error('请输入问题');
  if (prompt.length > 4000) throw new Error('问题过长，请限制在 4,000 字以内');
  const context = snapshotContext(
    workspace.getState().data,
    researchId,
    conversationId,
  );
  for (const item of context) {
    const document = workspace.getState().data.documents[item.documentId];
    if (!document || !(await getAsset(document.assetId)))
      throw new Error('上下文的原 PDF 文件缺失，请重新导入同一文件后重试');
  }
  const id = uid('request');
  const request: AIRequest = {
    id,
    researchId,
    conversationId,
    prompt: prompt.trim(),
    context,
    createdAt: new Date().toISOString(),
    status: 'generating',
    body: '',
    evidenceIds: [],
  };
  workspace.updateData((data) => {
    data.requests[id] = request;
    data.conversations[conversationId].requestIds.push(id);
  });
  try {
    const response = await responder(structuredClone(request));
    validateResponse(
      workspace.getState().data,
      request,
      response.evidenceIds,
      response.body,
    );
    workspace.updateData((data) => {
      data.requests[id] = { ...data.requests[id], ...response, status: 'done' };
    });
  } catch (error) {
    workspace.updateData((data) => {
      data.requests[id].status = 'error';
      data.requests[id].error =
        error instanceof Error ? error.message : '生成失败，请重试';
    });
  }
  return id;
}
