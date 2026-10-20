import { hasFullText } from '../domain/knowledge';
import { ensurePaneLayout, validatePaneLayout, syncPaneSession } from '../services/panes';
import { boardSnapshot, parseBoardPlan, validateBoardContext, validateBoardHistory, validateBoardSnapshot } from '../domain/board-history';
import type { ResearchViewId, Session, WorkspaceData } from '../domain/types';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const nativeUserInput = (value: unknown) => record(value) && typeof value.id === 'string' && typeof value.text === 'string' && typeof value.createdAt === 'string' && (value.afterItemId === undefined || typeof value.afterItemId === 'string');
const connectionIds = ['model', 'demo', 'codex', 'claude', 'opencode'];
function webLink(value: unknown) {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function validAbstract(value: unknown) {
  return record(value) && typeof value.text === 'string' && webLink(value.url) && typeof value.retrievedAt === 'string' && Number.isFinite(Date.parse(value.retrievedAt));
}

export function migrateWorkspace(value: unknown): WorkspaceData {
  if (!record(value) || ![1, 2, 3].includes(value.schemaVersion as number))
    throw new Error('存储版本不受支持，未覆盖现有数据。');
  const data = structuredClone(value) as unknown as WorkspaceData;
  validateBoardHistory(data);
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
  for (const board of Object.values(data.boards)) validateBoardSnapshot(boardSnapshot(data, board.id), board.id, board.researchId);
  for (const research of Object.values(data.researches))
    if (typeof research.question !== 'string' || !strings(research.documentIds) || !strings(research.cardIds)) throw new Error('研究关联损坏，未覆盖现有数据。');
  for (const research of Object.values(data.researches))
    if (research.directory !== undefined && (!record(research.directory) || ['id', 'projectId', 'path'].some(key => typeof research.directory?.[key as keyof typeof research.directory] !== 'string' || !research.directory[key as keyof typeof research.directory]))) throw new Error('研究目录关联损坏，未覆盖现有数据。');
  for (const research of Object.values(data.researches))
    if (research.directory?.name !== undefined && (typeof research.directory.name !== 'string' || !research.directory.name)) throw new Error('研究目录名称损坏，未覆盖现有数据。');
  for (const research of Object.values(data.researches)) {
    if (research.sourceRecords !== undefined && (!record(research.sourceRecords) || Object.entries(research.sourceRecords).some(([id, value]) => !research.documentIds.includes(id) || !record(value) || typeof value.note !== 'string' || !Array.isArray(value.discoveries) || value.discoveries.some(item => !record(item) || typeof item.url !== 'string' || typeof item.createdAt !== 'string' || !['ai', 'link'].includes(item.kind as string) || (['requestId', 'conversationId', 'recommendation'] as const).some(key => item[key] !== undefined && typeof item[key] !== 'string'))))) throw new Error('研究收录记录损坏，未覆盖现有数据。');
  }
  for (const research of Object.values(data.researches)) {
    for (const [field, resources] of [['boardOrder', data.boards], ['draftOrder', data.drafts]] as const) {
      const order = research[field];
      if (order !== undefined && (!strings(order) || new Set(order).size !== order.length || order.some(id => Object.hasOwn(resources, id) && resources[id].researchId !== research.id)))
        throw new Error('研究资源顺序损坏，未覆盖现有数据。');
    }
  }
  for (const doc of Object.values(data.documents)) {
    const fields = [doc.assetId, doc.hash, doc.filename, doc.pageCount];
    if (fields.some(field => field !== undefined) && !hasFullText(doc) || value.schemaVersion !== 3 && !hasFullText(doc)) throw new Error('论文来源损坏，未覆盖现有数据。');
    if (!['unread', 'reading', 'skimmed', 'read'].includes(doc.readingStatus)) throw new Error('阅读状态损坏。');
    if (doc.identifiers !== undefined && (!record(doc.identifiers) || Object.entries(doc.identifiers).some(([key, value]) => !['doi', 'arxiv', 'url'].includes(key) || typeof value !== 'string'))) throw new Error('资料标识损坏。');
    if (doc.abstract !== undefined && !validAbstract(doc.abstract) || doc.abstractAlternatives !== undefined && (!Array.isArray(doc.abstractAlternatives) || !doc.abstractAlternatives.every(validAbstract))) throw new Error('资料摘要来源损坏。');
    if (doc.sourceKind !== undefined && !['paper', 'web'].includes(doc.sourceKind) || doc.pdfUrl !== undefined && !webLink(doc.pdfUrl) || doc.metadataSource !== undefined && !webLink(doc.metadataSource)) throw new Error('资料来源信息损坏。');
    if (doc.acquisition !== undefined && (!record(doc.acquisition) || !['fetching', 'unavailable', 'error', 'conflict'].includes(doc.acquisition.status) || ['message', 'url', 'conflictDocumentId'].some(key => doc.acquisition?.[key as keyof typeof doc.acquisition] !== undefined && typeof doc.acquisition[key as keyof typeof doc.acquisition] !== 'string'))) throw new Error('全文获取记录损坏。');
    if (doc.acquisition?.status === 'fetching') doc.acquisition = { ...doc.acquisition, status: 'unavailable', message: '上次获取已中断，资料已保留，可重试或添加 PDF。' };
  }
  for (const item of [...Object.values(data.cards), ...Object.values(data.drafts)])
    if (typeof item.body !== 'string' || !strings(item.evidenceIds)) throw new Error('正文或引用损坏，未覆盖现有数据。');
  for (const evidence of Object.values(data.evidence))
    if (typeof evidence.documentId !== 'string' || typeof evidence.quote !== 'string' || !Number.isInteger(evidence.pageIndex) || evidence.pageIndex < 0 || evidence.contextOnly !== undefined && typeof evidence.contextOnly !== 'boolean' || evidence.annotationHidden !== undefined && typeof evidence.annotationHidden !== 'boolean') throw new Error('证据数据损坏，未覆盖现有数据。');
  for (const session of Object.values(data.sessions))
    if (!session.active || !Array.isArray(session.openItems) || !Array.isArray(session.history) || !record(session.panel) || !record(session.readers) || !record(session.viewports)) throw new Error('工作区状态损坏，未覆盖现有数据。');
  for (const session of Object.values(data.sessions)) {
    if (session.collapsedNav !== undefined && (!Array.isArray(session.collapsedNav) || session.collapsedNav.some(id => !['boards', 'drafts'].includes(id)) || new Set(session.collapsedNav).size !== session.collapsedNav.length))
      throw new Error('导航折叠状态损坏，未覆盖现有数据。');
    for (const [key, position] of Object.entries(session.readers)) {
      if (!record(position) || !Number.isInteger(position.pageIndex) || position.pageIndex < 0 || !Number.isFinite(position.scale) || position.scale < 0.5 || position.scale > 2 || position.offset !== undefined && (!Number.isFinite(position.offset) || position.offset < 0 || position.offset > 1)) throw new Error('阅读位置损坏，未覆盖现有数据。');
      const id = key.replace(/^(main|main-secondary|inspector):/, '');
      if (id !== key && data.documents[id] && !hasFullText(data.documents[id])) delete session.readers[key];
    }
    if (session.readerSplits !== undefined && (!record(session.readerSplits) || Object.entries(session.readerSplits).some(([id, layout]) => !hasFullText(data.documents[id]) || !['horizontal', 'vertical'].includes(layout)))) throw new Error('阅读分屏状态损坏，未覆盖现有数据。');
    if (!session.mainSplit && session.readerSplits) {
      const id = session.active.kind === 'document' && session.readerSplits[session.active.id] ? session.active.id : session.openItems.find(ref => ref.kind === 'document' && session.readerSplits?.[ref.id])?.id;
      if (id) session.mainSplit = { layout: session.readerSplits[id], ref: { kind: 'document', id } };
    }
    delete session.readerSplits;
    if (session.mainSplit !== undefined) {
      const split = session.mainSplit;
      const ref = split?.ref;
      const exists = ref?.kind === 'document' ? !!data.documents[ref.id] : ref?.kind === 'card' && !!data.cards[ref.id];
      if (!record(split) || split.open !== undefined && typeof split.open !== 'boolean' || !['horizontal', 'vertical'].includes(split.layout) || !record(ref) || !exists) throw new Error('工作区分屏资源损坏，未覆盖现有数据。');
      if (split.anchor !== undefined && (!record(split.anchor) || ref.kind !== 'document' || split.anchor.pageIndex !== undefined && (!Number.isInteger(split.anchor.pageIndex) || split.anchor.pageIndex < 0 || !hasFullText(data.documents[ref.id]) || split.anchor.pageIndex >= data.documents[ref.id].pageCount!))) throw new Error('对照来源定位损坏，未覆盖现有数据。');
      if (split.anchor?.evidenceId !== undefined && (typeof split.anchor.evidenceId !== 'string' || data.evidence[split.anchor.evidenceId]?.documentId !== ref.id)) throw new Error('对照来源不属于该文献，未覆盖现有数据。');
    }
  }
  for (const [key, session] of Object.entries(data.sessions)) {
    const ref = session.mainSplit?.ref;
    if (ref && key !== 'library' && !(ref.kind === 'document' ? data.researches[key]?.documentIds : data.researches[key]?.cardIds)?.includes(ref.id)) throw new Error('对照资源不属于本研究，未覆盖现有数据。');
  }
  for (const item of [...Object.values(data.conversations), ...Object.values(data.requests)]) {
    const settings = item.codex;
    if (settings !== undefined && (!record(settings) || Object.keys(settings).some(key => !['model', 'mode', 'effort', 'access'].includes(key))
      || settings.model !== undefined && (typeof settings.model !== 'string' || !settings.model.trim() || settings.model.length > 200)
      || ![undefined, 'chat', 'plan'].includes(settings.mode)
      || settings.effort !== undefined && (typeof settings.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(settings.effort))
      || ![undefined, 'read-only', 'workspace-write', 'full-access'].includes(settings.access))) throw new Error('Codex 设置损坏，未覆盖现有数据。');
  }
  for (const conversation of Object.values(data.conversations)) {
    if (conversation.boardSuggestionRequestId !== undefined && typeof conversation.boardSuggestionRequestId !== 'string' || conversation.boardSuggestionDismissed !== undefined && typeof conversation.boardSuggestionDismissed !== 'boolean') throw new Error('白板建议状态损坏。');
    if (conversation.boardSkill !== undefined && (!record(conversation.boardSkill) || typeof conversation.boardSkill.boardId !== 'string' || !['board', 'research'].includes(conversation.boardSkill.scope) || conversation.boardSkill.allowNewCards !== undefined && typeof conversation.boardSkill.allowNewCards !== 'boolean')) throw new Error('白板技能选择损坏，未覆盖现有数据。');
    if (!Array.isArray(conversation.contextIds) || !Array.isArray(conversation.requestIds))
      throw new Error('对话数据不完整，未覆盖现有数据。');
    conversation.title ??= '阅读对话';
    conversation.historyRange ??= 'all';
    conversation.createdAt ??= new Date(0).toISOString();
    conversation.updatedAt ??= conversation.createdAt;
    if (conversation.connectionId !== undefined && !connectionIds.includes(conversation.connectionId))
      throw new Error('助手连接记录不受支持，未覆盖现有数据。');
    if (conversation.nativeSessionRef !== undefined && typeof conversation.nativeSessionRef !== 'string' || conversation.nativeState !== undefined && !['idle', 'busy', 'unknown'].includes(conversation.nativeState) || conversation.nativeCanResume !== undefined && typeof conversation.nativeCanResume !== 'boolean') throw new Error('原生会话关联损坏，未覆盖现有数据。');
    if (conversation.nativeHistoryCursor !== undefined && (typeof conversation.nativeHistoryCursor !== 'string' || conversation.nativeHistoryCursor.length > 8192)) throw new Error('原生历史分页位置损坏，未覆盖现有数据。');
    if (conversation.nativeState === 'busy') { conversation.nativeState = 'unknown'; conversation.nativeCanResume = false; }
    if (conversation.inlineSource !== undefined) {
      const source = conversation.inlineSource, evidence = data.evidence[source?.evidenceId];
      if (!record(source) || !evidence || source.documentId !== evidence.documentId || source.pageIndex !== evidence.pageIndex
        || source.promoted !== undefined && typeof source.promoted !== 'boolean'
        || source.draftId !== undefined && typeof source.draftId !== 'string') throw new Error('原文旁问答来源损坏，未覆盖现有数据。');
    }
  }
  for (const request of Object.values(data.requests)) {
    if (request.boardApplyError !== undefined && typeof request.boardApplyError !== 'string') throw new Error('白板保存状态损坏。');
    if (request.boardContext !== undefined) validateBoardContext(request.boardContext, request.researchId);
    if (request.boardProposal !== undefined) {
      if (!request.boardContext) throw new Error('白板提案缺少请求快照。');
      request.boardProposal = parseBoardPlan(JSON.stringify(request.boardProposal), request.boardContext);
    }
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
    if (request.historyRequestIds !== undefined && !strings(request.historyRequestIds)) throw new Error('对话历史索引损坏，未覆盖现有数据。');
    if (request.nativeTurnId !== undefined && typeof request.nativeTurnId !== 'string') throw new Error('原生回合标识损坏，未覆盖现有数据。');
    if (request.supplementalInputs !== undefined && (!Array.isArray(request.supplementalInputs) || !request.supplementalInputs.every(nativeUserInput))) throw new Error('原生补充输入损坏，未覆盖现有数据。');
    if (request.nativeRun !== undefined) {
      const run = request.nativeRun;
      if (request.connectionId !== 'codex' || request.purpose !== 'chat' || !record(run) || run.managed !== true
        || !Number.isSafeInteger(run.cursor) || run.cursor < 0
        || !['pending', 'accepted', 'unknown'].includes(run.delivery)
        || !['running', 'waiting-input', 'compacting', 'stopping', 'completed', 'failed', 'interrupted', 'unknown'].includes(run.state)
        || !['connected', 'reconnecting', 'offline'].includes(run.transport)
        || run.turnId !== undefined && typeof run.turnId !== 'string'
        || run.pendingSteer !== undefined && !nativeUserInput(run.pendingSteer)
        || !Array.isArray(run.items) || run.items.length > 2000 || run.items.some(item => !record(item) || typeof item.id !== 'string'
          || !['agentMessage', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'contextCompaction', 'plan'].includes(item.type)
          || !['running', 'done', 'error'].includes(item.status)
          || item.contentComplete !== undefined && typeof item.contentComplete !== 'boolean'
          || (['text', 'toolName', 'command', 'output'] as const).some(key => item[key] !== undefined && typeof item[key] !== 'string')
          || item.phase !== undefined && !['commentary', 'partial_answer', 'final_answer'].includes(item.phase)
          || item.exitCode !== undefined && !Number.isInteger(item.exitCode))) throw new Error('原生运行记录损坏，未覆盖现有数据。');
    }
    if (request.status === 'generating') {
      if (request.nativeRun?.managed) {
        request.nativeRun.transport = 'reconnecting';
        continue;
      }
      request.status = 'interrupted';
      for (const interaction of request.interactions ?? []) if (interaction.status === 'pending') interaction.status = 'expired';
      request.error = request.nativeImported ? '正在同步原生记录，已收到的内容保留。' : '页面已重新加载，已保留最近保存的内容，请按原范围重试。';
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
      const conversation = Object.values(data.conversations).find(item => item.researchId === research.id && !item.archived && (!item.inlineSource || item.inlineSource.promoted));
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
    const preview = session.sourcePreview;
    if (preview !== undefined && (!record(preview) || !record(preview.candidate) || !webLink(preview.candidate.url) || typeof preview.candidate.title !== 'string' || !['paper', 'web'].includes(preview.candidate.kind))) throw new Error('文献预览记录损坏。');
    if (session.active.kind === 'researchView' && !views.includes(session.active.id) || session.researchView !== undefined && !views.includes(session.researchView) || !['excerpts', 'cards', 'ai'].includes(session.panel.mode)) throw new Error('工作区页面或面板模式损坏。');
  }
  for (const evidence of Object.values(data.evidence)) {
    if (evidence.researchId !== undefined && !data.researches[evidence.researchId] || evidence.note !== undefined && typeof evidence.note !== 'string' || evidence.dismissed !== undefined && typeof evidence.dismissed !== 'boolean') throw new Error('摘录信息损坏。');
  }
  for (const draft of Object.values(data.drafts)) if (draft.cardRefs !== undefined && (!Array.isArray(draft.cardRefs) || draft.cardRefs.some(ref => !record(ref) || typeof ref.cardId !== 'string' || typeof ref.insertedAt !== 'string' || ref.evidenceIds !== undefined && !strings(ref.evidenceIds)))) throw new Error('文稿卡片记录损坏。');
  data.schemaVersion = 3;
  for (const [key, session] of Object.entries(data.sessions)) {
    validatePaneLayout(data, key);
    ensurePaneLayout(session, key);
    validatePaneLayout(data, key);
    syncPaneSession(session);
    delete session.mainSplit;
  }
  return data;
}
