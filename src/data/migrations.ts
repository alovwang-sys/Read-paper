import type { WorkspaceData } from '../domain/types';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const connectionIds = ['model', 'demo', 'codex', 'claude', 'opencode'];

export function migrateWorkspace(value: unknown): WorkspaceData {
  if (!record(value) || ![1, 2].includes(value.schemaVersion as number))
    throw new Error('存储版本不受支持，未覆盖现有数据。');
  const data = structuredClone(value) as unknown as WorkspaceData;
  const legacy = value.schemaVersion === 1;
  for (const key of [
    'researches', 'documents', 'evidence', 'cards', 'boards', 'placements',
    'edges', 'drafts', 'conversations', 'requests', 'sessions',
  ] as const) {
    if (!record(data[key])) throw new Error('本地数据格式不完整，未覆盖现有数据。');
    for (const entity of Object.values(data[key]))
      if (!record(entity)) throw new Error('本地记录格式不完整，未覆盖现有数据。');
  }
  if (!data.scope || !data.sessions[data.scope.kind === 'research' ? data.scope.researchId : 'library'])
    throw new Error('工作区会话缺失。');
  if (!legacy && !record(data.cardDrafts)) throw new Error('卡片草稿数据不完整。');
  data.cardDrafts ??= {};
  for (const collection of [data.researches, data.documents, data.cards, data.boards, data.drafts])
    for (const [id, item] of Object.entries(collection))
      if (item.id !== id || typeof item.title !== 'string') throw new Error('资源标识或标题损坏，未覆盖现有数据。');
  for (const research of Object.values(data.researches))
    if (typeof research.question !== 'string' || !strings(research.documentIds) || !strings(research.cardIds)) throw new Error('研究关联损坏，未覆盖现有数据。');
  for (const research of Object.values(data.researches))
    if (research.directory !== undefined && (!record(research.directory) || ['id', 'projectId', 'path'].some(key => typeof research.directory?.[key as keyof typeof research.directory] !== 'string' || !research.directory[key as keyof typeof research.directory]))) throw new Error('研究目录关联损坏，未覆盖现有数据。');
  for (const doc of Object.values(data.documents))
    if (typeof doc.assetId !== 'string' || typeof doc.hash !== 'string' || typeof doc.filename !== 'string' || !Number.isInteger(doc.pageCount) || doc.pageCount < 1) throw new Error('论文来源损坏，未覆盖现有数据。');
  for (const item of [...Object.values(data.cards), ...Object.values(data.drafts)])
    if (typeof item.body !== 'string' || !strings(item.evidenceIds)) throw new Error('正文或引用损坏，未覆盖现有数据。');
  for (const evidence of Object.values(data.evidence))
    if (typeof evidence.documentId !== 'string' || typeof evidence.quote !== 'string' || !Number.isInteger(evidence.pageIndex) || evidence.pageIndex < 0) throw new Error('证据数据损坏，未覆盖现有数据。');
  for (const session of Object.values(data.sessions))
    if (!session.active || !Array.isArray(session.openItems) || !Array.isArray(session.history) || !record(session.panel) || !record(session.readers) || !record(session.viewports)) throw new Error('工作区状态损坏，未覆盖现有数据。');
  for (const conversation of Object.values(data.conversations)) {
    if (!Array.isArray(conversation.contextIds) || !Array.isArray(conversation.requestIds))
      throw new Error('对话数据不完整，未覆盖现有数据。');
    conversation.title ??= '阅读对话';
    conversation.historyRange ??= 'all';
    conversation.createdAt ??= new Date(0).toISOString();
    conversation.updatedAt ??= conversation.createdAt;
    if (conversation.connectionId !== undefined && !connectionIds.includes(conversation.connectionId))
      throw new Error('助手连接记录不受支持，未覆盖现有数据。');
    if (conversation.nativeSessionRef !== undefined && typeof conversation.nativeSessionRef !== 'string' || conversation.nativeState !== undefined && !['idle', 'busy', 'unknown'].includes(conversation.nativeState) || conversation.nativeCanResume !== undefined && typeof conversation.nativeCanResume !== 'boolean') throw new Error('原生会话关联损坏，未覆盖现有数据。');
    if (conversation.nativeState === 'busy') { conversation.nativeState = 'unknown'; conversation.nativeCanResume = false; }
  }
  for (const request of Object.values(data.requests)) {
    if (typeof request.prompt !== 'string' || typeof request.body !== 'string' || !Array.isArray(request.context) || !Array.isArray(request.evidenceIds))
      throw new Error('问答记录格式不完整，未覆盖现有数据。');
    if (legacy) {
      request.legacy = true;
      request.mode = 'demo';
    }
    request.purpose ??= 'chat';
    request.history ??= [];
    if (request.connectionId !== undefined && !connectionIds.includes(request.connectionId))
      throw new Error('请求的助手连接不受支持，未覆盖现有数据。');
    if (request.status === 'generating') {
      request.status = 'interrupted';
      for (const interaction of request.interactions ?? []) if (interaction.status === 'pending') interaction.status = 'expired';
      request.error = '页面已重新加载，已保留最近保存的内容，请按原范围重试。';
    }
  }
  for (const draft of Object.values(data.cardDrafts)) {
    if (draft.status === 'generating') {
      draft.status = 'error';
      draft.error = '生成已中断，已有草稿保留，可重新整理。';
    }
  }
  for (const research of Object.values(data.researches)) {
    const session = data.sessions[research.id];
    if (!session) throw new Error('研究工作区缺失，未覆盖现有数据。');
    const current = session.activeConversationId && data.conversations[session.activeConversationId];
    if (!current || current.researchId !== research.id || current.archived) {
      const conversation = Object.values(data.conversations).find(item => item.researchId === research.id && !item.archived);
      session.activeConversationId = conversation?.id;
    }
  }
  data.schemaVersion = 2;
  return data;
}
