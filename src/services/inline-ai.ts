import { validateTextAnchor } from '../domain/reader-context';
import { matchesEvidence, type EvidenceFragment } from '../domain/evidence';
import type { AIConnectionId, Conversation, ReaderOperation } from '../domain/types';
import { hasFullText } from '../domain/knowledge';
import { codexSupportsImages, conversationConnection, getAgents, getCodexCapabilities } from './agents';
import { createCardDraftFromAnswer, getAIConfig, type AIConfig } from './ai';
import { getActiveConversation, uid, workspace } from './workspace';

export type InlineAIFragment = EvidenceFragment;
export type InlineAISelection = InlineAIFragment & { fragments?: InlineAIFragment[] };
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

export function findInlineConversation(researchId: string, selection: InlineAISelection, options: InlineOptions = {}): Conversation | undefined {
  const { data } = workspace.getState();
  const fragments = [...(selection.fragments ?? [selection])].sort((a, b) => a.pageIndex - b.pageIndex);
  return Object.values(data.conversations).filter(conversation => {
    const source = conversation.inlineSource, ids = source && (source.evidenceIds ?? [source.evidenceId]);
    return !conversation.archived && !conversation.deletedAt && (source?.operation ?? 'question') === (options.operation ?? 'question') && conversation.researchId === researchId && conversationConnection(conversation) === inlineConnection(researchId) && ids
      && ids.length === fragments.length && ids.every((id, index) => data.evidence[id] && matchesEvidence(data.evidence[id], fragments[index]));
  }).sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))[0];
}

export function createInlineConversation(researchId: string, selection: InlineAISelection, options: InlineOptions = {}): string {
  const { data } = workspace.getState(), research = data.researches[researchId], document = data.documents[selection.documentId];
  if (!research?.documentIds.includes(selection.documentId) || !hasFullText(document)) throw new Error('请先把原 PDF 加入当前研究。');
  const fragments = [...(selection.fragments ?? [selection])].sort((a, b) => a.pageIndex - b.pageIndex);
  if (!fragments.length || fragments.some(fragment => fragment.documentId !== selection.documentId || !Number.isInteger(fragment.pageIndex) || fragment.pageIndex < 0 || fragment.pageIndex >= document.pageCount
    || (fragment.kind === 'region' ? !fragment.region : !fragment.quote.trim()))) throw new Error('请选择有效的原文或区域后再提问。');
  for (const fragment of fragments) if (fragment.textAnchor) validateTextAnchor(fragment.textAnchor);
  const previous = !options.forceNew && findInlineConversation(researchId, selection, options);
  if (previous) return previous.id;
  const connectionId = inlineConnection(researchId), id = uid('conversation');
  const active = getActiveConversation(data, researchId);
  const evidenceIds = workspace.captureReaderSelection(researchId, fragments, { contextOnly: true });
  const evidenceId = evidenceIds[0], now = new Date().toISOString();
  workspace.updateData(next => {
    next.conversations[id] = { id, researchId, connectionId, title: '原文旁提问', contextIds: evidenceIds, requestIds: [],
      input: '', historyRange: 'all', createdAt: now, updatedAt: now,
      ...(connectionId === 'codex' && active ? { codex: structuredClone(active.codex ?? {}), skills: structuredClone(active.skills ?? []) } : {}),
      inlineSource: { documentId: selection.documentId, pageIndex: fragments[0].pageIndex, evidenceId, ...(evidenceIds.length > 1 ? { evidenceIds } : {}), operation: options.operation ?? 'question' } };
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
