import { hasFullText } from '../domain/knowledge';
import type { ResearchViewId, Session, WorkspaceData } from '../domain/types';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const connectionIds = ['model', 'demo', 'codex', 'claude', 'opencode'];

export function migrateWorkspace(value: unknown): WorkspaceData {
  if (!record(value) || ![1, 2, 3].includes(value.schemaVersion as number))
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
  for (const research of Object.values(data.researches))
    if (research.directory?.name !== undefined && (typeof research.directory.name !== 'string' || !research.directory.name)) throw new Error('研究目录名称损坏，未覆盖现有数据。');
  for (const doc of Object.values(data.documents)) {
    const fields = [doc.assetId, doc.hash, doc.filename, doc.pageCount];
    if (fields.some(field => field !== undefined) && !hasFullText(doc) || value.schemaVersion !== 3 && !hasFullText(doc)) throw new Error('论文来源损坏，未覆盖现有数据。');
    if (!['unread', 'reading', 'skimmed', 'read'].includes(doc.readingStatus)) throw new Error('阅读状态损坏。');
    if (doc.identifiers !== undefined && (!record(doc.identifiers) || Object.entries(doc.identifiers).some(([key, value]) => !['doi', 'arxiv', 'url'].includes(key) || typeof value !== 'string'))) throw new Error('资料标识损坏。');
  }
  for (const item of [...Object.values(data.cards), ...Object.values(data.drafts)])
    if (typeof item.body !== 'string' || !strings(item.evidenceIds)) throw new Error('正文或引用损坏，未覆盖现有数据。');
  for (const evidence of Object.values(data.evidence))
    if (typeof evidence.documentId !== 'string' || typeof evidence.quote !== 'string' || !Number.isInteger(evidence.pageIndex) || evidence.pageIndex < 0) throw new Error('证据数据损坏，未覆盖现有数据。');
  for (const session of Object.values(data.sessions))
    if (!session.active || !Array.isArray(session.openItems) || !Array.isArray(session.history) || !record(session.panel) || !record(session.readers) || !record(session.viewports)) throw new Error('工作区状态损坏，未覆盖现有数据。');
  for (const item of [...Object.values(data.conversations), ...Object.values(data.requests)]) {
    const settings = item.codex;
    if (settings !== undefined && (!record(settings) || Object.keys(settings).some(key => !['model', 'mode', 'effort', 'access'].includes(key))
      || settings.model !== undefined && (typeof settings.model !== 'string' || !settings.model.trim() || settings.model.length > 200)
      || ![undefined, 'chat', 'plan'].includes(settings.mode)
      || settings.effort !== undefined && (typeof settings.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(settings.effort))
      || ![undefined, 'read-only', 'workspace-write', 'full-access'].includes(settings.access))) throw new Error('Codex 设置损坏，未覆盖现有数据。');
  }
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
  if (value.schemaVersion !== 3) {
    for (const evidence of Object.values(data.evidence)) {
      const owners = new Set<string>();
      for (const card of Object.values(data.cards)) if (card.evidenceIds.includes(evidence.id))
        for (const research of Object.values(data.researches)) if (research.cardIds.includes(card.id)) owners.add(research.id);
      for (const item of [...Object.values(data.drafts), ...Object.values(data.conversations)])
        if (('evidenceIds' in item ? item.evidenceIds : item.contextIds).includes(evidence.id)) owners.add(item.researchId);
      for (const request of Object.values(data.requests)) if (request.context.some(context => context.evidenceId === evidence.id)) owners.add(request.researchId);
      if (owners.size === 1) evidence.researchId = [...owners][0];
    }
    for (const draft of Object.values(data.drafts)) draft.cardRefs ??= [...new Set((draft.cardSources ?? []).map(source => source.cardId))].map(cardId => ({ cardId, insertedAt: new Date(0).toISOString() }));
    for (const [key, session] of Object.entries(data.sessions)) {
      if (session.active.kind === 'collection' && (session.active.id as string) === 'inbox') session.libraryFilter = 'unassigned';
      const convert = (ref: Session['active']): Session['active'] => {
        if (ref.kind === 'research') return key === 'library' ? { kind: 'collection', id: 'documents' } : { kind: 'researchView', id: 'home' };
        if (ref.kind === 'collection') {
          return { kind: 'collection', id: ref.id === 'cards' ? 'cards' : 'documents' };
        }
        return ref;
      };
      session.active = convert(session.active);
      session.history = session.history.map(convert);
      session.openItems = session.openItems.filter(ref => ref.kind !== 'research');
      session.researchView ??= 'home';
      if (key !== 'library' && session.active.kind === 'collection') session.active = { kind: 'researchView', id: 'sources' };
      if (session.active.kind === 'researchView') session.researchView = session.active.id;
      const mode = session.panel.mode as string;
      session.panel.mode = mode === 'ai' ? 'ai' : mode === 'references' ? 'cards' : 'excerpts';
    }
  }
  const views: ResearchViewId[] = ['home', 'sources', 'excerpts', 'cards', 'boards', 'drafts'];
  for (const session of Object.values(data.sessions)) {
    if (session.active.kind === 'researchView' && !views.includes(session.active.id) || session.researchView !== undefined && !views.includes(session.researchView) || !['excerpts', 'cards', 'ai'].includes(session.panel.mode)) throw new Error('工作区页面或面板模式损坏。');
  }
  for (const evidence of Object.values(data.evidence)) {
    if (evidence.researchId !== undefined && !data.researches[evidence.researchId] || evidence.note !== undefined && typeof evidence.note !== 'string' || evidence.dismissed !== undefined && typeof evidence.dismissed !== 'boolean') throw new Error('摘录信息损坏。');
  }
  for (const draft of Object.values(data.drafts)) if (draft.cardRefs !== undefined && (!Array.isArray(draft.cardRefs) || draft.cardRefs.some(ref => !record(ref) || typeof ref.cardId !== 'string' || typeof ref.insertedAt !== 'string' || ref.evidenceIds !== undefined && !strings(ref.evidenceIds)))) throw new Error('文稿卡片记录损坏。');
  data.schemaVersion = 3;
  return data;
}
