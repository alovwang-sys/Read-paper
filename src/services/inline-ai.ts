import type { Conversation, Evidence, RegionSource } from '../domain/types';
import { hasFullText } from '../domain/knowledge';
import { conversationConnection } from './agents';
import { createCardDraftFromAnswer, getAIConfig, type AIConfig } from './ai';
import { getActiveConversation, uid, workspace } from './workspace';

export type InlineAISelection = { documentId: string; pageIndex: number; quote: string; kind?: 'text' | 'region'; region?: RegionSource };

function inlineConnection(researchId: string): 'model' | 'demo' {
  const conversation = getActiveConversation(workspace.getState().data, researchId);
  return conversation && conversationConnection(conversation) === 'demo' ? 'demo' : 'model';
}

export async function inlineAIConfig(researchId: string, conversationId?: string): Promise<AIConfig> {
  const conversation = conversationId && workspace.getState().data.conversations[conversationId];
  const connection = conversation ? conversationConnection(conversation) : inlineConnection(researchId);
  if (connection === 'demo') return { configured: true, model: '演示模式', provider: '演示', images: true, mode: 'demo', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } };
  const config = await getAIConfig();
  if (!config.configured) throw new Error('请先在设置中配置模型连接；原文旁提问不需要安装本机 CLI。');
  return config;
}

function matchesSelection(evidence: Evidence, selection: InlineAISelection) {
  return evidence.documentId === selection.documentId && evidence.pageIndex === selection.pageIndex
    && (selection.kind === 'region' ? evidence.kind === 'region' && evidence.region?.hash === selection.region?.hash
      && evidence.region?.rotation === selection.region?.rotation && JSON.stringify(evidence.region?.rect) === JSON.stringify(selection.region?.rect)
      : evidence.kind !== 'region' && evidence.quote === selection.quote.trim());
}

export function findInlineConversation(researchId: string, selection: InlineAISelection): Conversation | undefined {
  const { data } = workspace.getState();
  return Object.values(data.conversations).filter(conversation => {
    const source = conversation.inlineSource, evidence = source && data.evidence[source.evidenceId];
    return !conversation.archived && conversation.researchId === researchId && evidence
      && matchesSelection(evidence, selection);
  }).sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))[0];
}

export function createInlineConversation(researchId: string, selection: InlineAISelection): string {
  const { data } = workspace.getState(), research = data.researches[researchId], document = data.documents[selection.documentId];
  if (!research?.documentIds.includes(selection.documentId) || !hasFullText(document)) throw new Error('请先把原 PDF 加入当前研究。');
  if (!Number.isInteger(selection.pageIndex) || selection.pageIndex < 0 || selection.pageIndex >= document.pageCount
    || (selection.kind === 'region' ? !selection.region : !selection.quote.trim())) throw new Error('请选择有效的原文或区域后再提问。');
  const previous = findInlineConversation(researchId, selection);
  if (previous) return previous.id;
  const connectionId = inlineConnection(researchId), id = uid('conversation');
  const existing = Object.values(data.evidence).find(evidence => (!evidence.researchId || evidence.researchId === researchId)
    && matchesSelection(evidence, selection));
  const evidenceId = existing?.id ?? uid('evidence'), now = new Date().toISOString();
  workspace.updateData(next => {
    if (!existing) next.evidence[evidenceId] = { id: evidenceId, researchId, documentId: selection.documentId,
      pageIndex: selection.pageIndex, quote: selection.quote.trim(), kind: selection.kind ?? 'text',
      ...(selection.region ? { region: structuredClone(selection.region) } : {}), contextOnly: true, createdAt: now };
    next.conversations[id] = { id, researchId, connectionId, title: '原文旁提问', contextIds: [evidenceId], requestIds: [],
      input: '', historyRange: 'all', createdAt: now, updatedAt: now,
      inlineSource: { documentId: selection.documentId, pageIndex: selection.pageIndex, evidenceId } };
  });
  return id;
}

export function continueInlineInPanel(conversationId: string) {
  const { data } = workspace.getState(), conversation = data.conversations[conversationId];
  if (!conversation?.inlineSource || conversation.archived) throw new Error('此原文旁问答暂时不可用。');
  if (data.scope.kind === 'research' && data.scope.researchId !== conversation.researchId) throw new Error('请回到原研究后继续此问答。');
  if (data.scope.kind === 'library') workspace.openResource({ kind: 'document', id: conversation.inlineSource.documentId }, {
    scope: { kind: 'research', researchId: conversation.researchId }, target: 'main',
    anchor: { pageIndex: conversation.inlineSource.pageIndex, evidenceId: conversation.inlineSource.evidenceId },
  });
  workspace.updateData(next => { next.conversations[conversationId].inlineSource!.promoted = true; });
  workspace.selectConversation(conversation.researchId, conversationId);
  workspace.setPanel('ai');
}

export function createInlineCardDraft(requestId: string): string {
  const request = workspace.getState().data.requests[requestId];
  if (!request || !workspace.getState().data.conversations[request.conversationId]?.inlineSource) throw new Error('原文旁问答不存在。');
  const id = createCardDraftFromAnswer(requestId);
  workspace.updateData(data => { data.conversations[request.conversationId].inlineSource!.draftId = id; });
  return id;
}
