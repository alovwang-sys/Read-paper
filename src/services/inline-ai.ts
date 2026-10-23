import { validateTextAnchor } from '../domain/reader-context';
import type { AIConnectionId, Conversation, Evidence, ReaderOperation, RegionSource, TextSourceAnchor } from '../domain/types';
import { hasFullText } from '../domain/knowledge';
import { codexSupportsImages, conversationConnection, getAgents, getCodexCapabilities } from './agents';
import { createCardDraftFromAnswer, getAIConfig, type AIConfig } from './ai';
import { getActiveConversation, uid, workspace } from './workspace';

export type InlineAISelection = { documentId: string; pageIndex: number; quote: string; kind?: 'text' | 'region'; region?: RegionSource; textAnchor?: TextSourceAnchor };
type InlineOptions = { operation?: ReaderOperation; forceNew?: boolean };

function inlineConnection(researchId: string): AIConnectionId {
  const conversation = getActiveConversation(workspace.getState().data, researchId);
  const connection = conversation && conversationConnection(conversation);
  return connection ?? 'model';
}

export async function inlineAIConfig(researchId: string, conversationId?: string): Promise<AIConfig> {
  const conversation = conversationId && workspace.getState().data.conversations[conversationId];
  const connection = conversation ? conversationConnection(conversation) : inlineConnection(researchId);
  if (connection === 'demo') return { configured: true, model: '演示模式', provider: '演示', images: true, mode: 'demo', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } };
  if (connection === 'codex') {
    if (!workspace.getState().data.researches[researchId]?.directory) throw new Error('请先在项目设置中关联研究目录，再使用 Codex 原文旁提问。');
    const capabilities = await getCodexCapabilities();
    const model = conversation && conversation.codex?.model;
    return { configured: true, model: model || capabilities.models.find(model => model.isDefault)?.id || capabilities.models[0]?.id || 'Codex', provider: 'Codex', images: codexSupportsImages(capabilities, model), mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } };
  }
  if (connection === 'claude' || connection === 'opencode') {
    if (!workspace.getState().data.researches[researchId]?.directory) throw new Error('请先在项目设置中关联研究目录。');
    const agent = (await getAgents()).find(item => item.id === connection);
    if (agent?.state !== 'ready') throw new Error(agent?.detail || '当前助手尚未连接，请在设置中检查。');
    return { configured: true, model: agent.name, provider: agent.name, images: agent.capabilities.images, mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } };
  }
  const config = await getAIConfig();
  if (!config.configured) throw new Error('请先在设置中配置模型连接；原文旁提问不需要安装本机 CLI。');
  return config;
}

function matchesSelection(evidence: Evidence, selection: InlineAISelection) {
  return evidence.documentId === selection.documentId && evidence.pageIndex === selection.pageIndex
    && (selection.kind === 'region' ? evidence.kind === 'region' && evidence.region?.hash === selection.region?.hash
      && evidence.region?.rotation === selection.region?.rotation && JSON.stringify(evidence.region?.rect) === JSON.stringify(selection.region?.rect)
      : evidence.kind !== 'region' && evidence.quote === selection.quote.trim()
        && (selection.textAnchor ? evidence.textAnchor?.start === selection.textAnchor.start && evidence.textAnchor?.end === selection.textAnchor.end : !evidence.textAnchor));
}

export function findInlineConversation(researchId: string, selection: InlineAISelection, options: InlineOptions = {}): Conversation | undefined {
  const { data } = workspace.getState();
  return Object.values(data.conversations).filter(conversation => {
    const source = conversation.inlineSource, evidence = source && data.evidence[source.evidenceId];
    return !conversation.archived && !conversation.deletedAt && (source?.operation ?? 'question') === (options.operation ?? 'question') && conversation.researchId === researchId && conversationConnection(conversation) === inlineConnection(researchId) && evidence
      && matchesSelection(evidence, selection);
  }).sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))[0];
}

export function createInlineConversation(researchId: string, selection: InlineAISelection, options: InlineOptions = {}): string {
  const { data } = workspace.getState(), research = data.researches[researchId], document = data.documents[selection.documentId];
  if (!research?.documentIds.includes(selection.documentId) || !hasFullText(document)) throw new Error('请先把原 PDF 加入当前研究。');
  if (!Number.isInteger(selection.pageIndex) || selection.pageIndex < 0 || selection.pageIndex >= document.pageCount
    || (selection.kind === 'region' ? !selection.region : !selection.quote.trim())) throw new Error('请选择有效的原文或区域后再提问。');
  if (selection.textAnchor) validateTextAnchor(selection.textAnchor);
  const previous = !options.forceNew && findInlineConversation(researchId, selection, options);
  if (previous) return previous.id;
  const connectionId = inlineConnection(researchId), id = uid('conversation');
  const active = getActiveConversation(data, researchId);
  const existing = Object.values(data.evidence).find(evidence => (!evidence.researchId || evidence.researchId === researchId)
    && matchesSelection(evidence, selection));
  const evidenceId = existing?.id ?? uid('evidence'), now = new Date().toISOString();
  workspace.updateData(next => {
    if (!existing) next.evidence[evidenceId] = { id: evidenceId, researchId, documentId: selection.documentId,
      pageIndex: selection.pageIndex, quote: selection.quote.trim(), kind: selection.kind ?? 'text',
      ...(selection.region ? { region: structuredClone(selection.region) } : {}), contextOnly: true, createdAt: now };
    if (selection.textAnchor) next.evidence[evidenceId].textAnchor = structuredClone(selection.textAnchor);
    next.conversations[id] = { id, researchId, connectionId, title: '原文旁提问', contextIds: [evidenceId], requestIds: [],
      input: '', historyRange: 'all', createdAt: now, updatedAt: now,
      ...(connectionId === 'codex' && active ? { codex: structuredClone(active.codex ?? {}), skills: structuredClone(active.skills ?? []) } : {}),
      inlineSource: { documentId: selection.documentId, pageIndex: selection.pageIndex, evidenceId, operation: options.operation ?? 'question' } };
  });
  return id;
}

export function continueInlineInPanel(conversationId: string) {
  const { data } = workspace.getState(), conversation = data.conversations[conversationId];
  if (!conversation?.inlineSource || conversation.archived || conversation.deletedAt) throw new Error('此原文旁问答暂时不可用，请先恢复会话。');
  if (data.scope.kind === 'research' && data.scope.researchId !== conversation.researchId) throw new Error('请回到原研究后继续此问答。');
  if (data.scope.kind === 'library') workspace.openResource({ kind: 'document', id: conversation.inlineSource.documentId }, {
    scope: { kind: 'research', researchId: conversation.researchId }, target: 'main',
    anchor: { pageIndex: conversation.inlineSource.pageIndex, evidenceId: conversation.inlineSource.evidenceId },
  });
  workspace.updateData(next => { next.conversations[conversationId].inlineSource!.promoted = true; next.sessions[conversation.researchId].agentChat = { ...next.sessions[conversation.researchId].agentChat, mode: 'side' }; });
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
