import { useSyncExternalStore } from 'react';
import { createSeed, emptySession } from '../data/seed';
import { loadWorkspace, saveWorkspace, saveMigrationBackup } from '../data/storage';
import { migrateWorkspace } from '../data/migrations';
import type {
  BoardPlacement,
  CollectionId,
  Evidence,
  PanelMode,
  ResourceAnchor,
  ResourceRef,
  Session,
  WorkspaceData,
  WorkspaceScope,
  WorkspaceState,
  Selection,
  Conversation,
  CardProvenance,
  RegionSource,
} from '../domain/types';

export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const scopeKey = (scope: WorkspaceScope) =>
  scope.kind === 'research' ? scope.researchId : 'library';
export const sameRef = (a: ResourceRef, b: ResourceRef) =>
  a.kind === b.kind && a.id === b.id;
export function resourceTitle(data: WorkspaceData, ref: ResourceRef) {
  const entities =
    ref.kind === 'research'
      ? data.researches
      : ref.kind === 'document'
        ? data.documents
        : ref.kind === 'card'
          ? data.cards
          : ref.kind === 'board'
            ? data.boards
            : data.drafts;
  return entities[ref.id]?.title ?? '资源已缺失';
}
export function resourceExists(data: WorkspaceData, ref: ResourceRef) {
  return !!(ref.kind === 'research'
    ? data.researches[ref.id]
    : ref.kind === 'document'
      ? data.documents[ref.id]
      : ref.kind === 'card'
        ? data.cards[ref.id]
        : ref.kind === 'board'
          ? data.boards[ref.id]
          : data.drafts[ref.id]);
}
export function validateEvidence(data: WorkspaceData, ids: string[]) {
  return ids.map((id) => {
    const evidence = data.evidence[id];
    const doc = evidence && data.documents[evidence.documentId];
    if (
      !evidence ||
      !doc ||
      (evidence.kind === 'region' ? !validRegion(evidence.region) : !evidence.quote.trim()) ||
      !Number.isInteger(evidence.pageIndex) ||
      evidence.pageIndex < 0 ||
      evidence.pageIndex >= doc.pageCount
    )
      throw new Error('引用的原文或页码缺失，请修复来源后重试。');
    return evidence;
  });
}
function validRegion(region?: RegionSource) {
  if (!region?.assetId || !region.hash) return false;
  const { x, y, width, height } = region.rect;
  return [x, y, width, height, region.rotation, region.width, region.height].every(Number.isFinite) &&
    x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1.00001 && y + height <= 1.00001 &&
    region.width > 0 && region.height > 0 && region.rotation % 90 === 0;
}
export function getActiveConversation(data: WorkspaceData, researchId: string): Conversation | undefined {
  const id = data.sessions[researchId]?.activeConversationId;
  const active = id ? data.conversations[id] : undefined;
  return active && !active.archived && active.researchId === researchId ? active :
    Object.values(data.conversations).find(c => c.researchId === researchId && !c.archived);
}
export function linkCard(
  data: WorkspaceData,
  researchId: string,
  cardId: string,
) {
  const research = data.researches[researchId],
    card = data.cards[cardId];
  if (!research || !card) throw new Error('研究或卡片不存在');
  const evidence = validateEvidence(data, card.evidenceIds);
  research.cardIds = [...new Set([...research.cardIds, cardId])];
  research.documentIds = [
    ...new Set([
      ...research.documentIds,
      ...evidence.map((item) => item.documentId),
    ]),
  ];
}

const listeners = new Set<() => void>();
let state: WorkspaceState = {
  data: createSeed(),
  loaded: false,
  saveStatus: 'saved',
};
let revision = 0,
  journalRevision = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  saving = false;
const JOURNAL = 'papertrail-recovery-v2';
const LEGACY_JOURNAL = 'papertrail-recovery-v1';
function emit() {
  listeners.forEach((listener) => listener());
}
function status(patch: Partial<WorkspaceState>) {
  state = { ...state, ...patch };
  emit();
}
async function persist() {
  if (saving || !state.loaded || state.loadError) return;
  saving = true;
  const currentRevision = revision,
    snapshot = state.data;
  status({ saveStatus: 'saving', saveError: undefined });
  try {
    await saveWorkspace(snapshot);
    if (journalRevision <= currentRevision) localStorage.removeItem(JOURNAL);
    localStorage.removeItem(LEGACY_JOURNAL);
    if (revision === currentRevision) {
      status({ saveStatus: 'saved', saveError: undefined });
    } else status({ saveStatus: 'dirty' });
  } catch (error) {
    status({
      saveStatus: 'error',
      saveError: `本地保存失败：${error instanceof Error ? error.message : '存储不可用'}。编辑内容已保留，可重试。`,
    });
  } finally {
    saving = false;
    if (revision !== currentRevision) timer = setTimeout(persist, 350);
  }
}

export const workspace = {
  getState: () => state,
  getSession: (scope = state.data.scope): Session =>
    state.data.sessions[scopeKey(scope)],
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  async load() {
    try {
      const journal = localStorage.getItem(JOURNAL);
      const oldJournal = localStorage.getItem(LEGACY_JOURNAL);
      const database = await loadWorkspace();
      for (const candidate of [database, journal && JSON.parse(journal), oldJournal && JSON.parse(oldJournal)]) {
        if (candidate && typeof candidate.schemaVersion === 'number' && candidate.schemaVersion > 2) throw new Error('存储版本不受支持，未覆盖现有数据。请使用创建这些数据的新版应用。');
      }
      const saved = journal ? JSON.parse(journal) : database?.schemaVersion === 2 ? database : oldJournal ? JSON.parse(oldJournal) : database;
      const migrated = saved && saved.schemaVersion === 1;
      const interrupted = saved && (Object.values(saved.requests ?? {}).some(request => (request as { status?: string }).status === 'generating') || Object.values(saved.cardDrafts ?? {}).some(draft => (draft as { status?: string }).status === 'generating'));
      if (migrated) await saveMigrationBackup({ database, recovery: oldJournal });
      const data = saved ? migrateWorkspace(saved) : createSeed();
      status({
        data,
        loaded: true,
        loadError: undefined,
        saveError: undefined,
        saveStatus: journal || migrated || interrupted ? 'dirty' : 'saved',
      });
      if (journal || migrated || interrupted || !saved) void persist();
    } catch (error) {
      status({
        loaded: true,
        loadError: `无法读取本地数据：${error instanceof Error ? error.message : '未知错误'}。现有存储已保留，请重试加载。`,
      });
    }
  },
  updateData(change: (data: WorkspaceData) => void) {
    if (!state.loaded || state.loadError)
      throw new Error('数据尚未成功加载，请重试加载后编辑');
    const data = structuredClone(state.data);
    change(data);
    for (const request of Object.values(state.data.requests))
      if (request.status !== 'generating' && data.requests[request.id] && data.requests[request.id].body !== request.body)
        throw new Error('原始问答不可改写，请编辑独立卡片草稿。');
    revision++;
    let journalError: string | undefined;
    try {
      // shortcut: large histories rely on IndexedDB checkpoints; use incremental storage if usage outgrows one workspace record.
      const journal = JSON.stringify(data);
      if (journal.length <= 1_500_000) {
        localStorage.setItem(JOURNAL, journal);
        journalRevision = revision;
      } else journalError = '记录较大，正在直接保存到本地数据库。请等待已保存状态后关闭页面。';
    } catch {
      journalError = '恢复缓冲不可用，请保持页面打开并重试保存。';
    }
    state = { ...state, data, saveStatus: 'dirty', saveError: journalError };
    emit();
    clearTimeout(timer);
    timer = setTimeout(persist, 350);
  },
  retrySave() {
    clearTimeout(timer);
    void persist();
  },
  notice(message?: string) {
    status({ notice: message });
  },
  openCollection(collection: CollectionId) {
    workspace.updateData((data) => {
      data.scope = { kind: 'library' };
      const session = data.sessions.library;
      session.history.push(session.active);
      session.active = { kind: 'collection', id: collection };
      session.anchor = undefined;
    });
    status({ selection: undefined });
  },
  openResource(
    ref: ResourceRef,
    options: {
      scope: WorkspaceScope;
      target: 'main' | 'inspector';
      anchor?: ResourceAnchor;
    },
  ) {
    workspace.updateData((data) => {
      if (!resourceExists(data, ref))
        throw new Error('资源不存在，请从资料库重新打开。');
      if (options.scope.kind === 'research') {
        const research = data.researches[options.scope.researchId];
        if (!research) throw new Error('研究不存在');
        if (ref.kind === 'document' && !research.documentIds.includes(ref.id))
          throw new Error('请先将论文加入当前研究。');
        if (ref.kind === 'card' && !research.cardIds.includes(ref.id))
          throw new Error('请先将卡片加入当前研究。');
        if (
          (ref.kind === 'board' &&
            data.boards[ref.id].researchId !== research.id) ||
          (ref.kind === 'draft' &&
            data.drafts[ref.id].researchId !== research.id) ||
          (ref.kind === 'research' && ref.id !== research.id)
        )
          throw new Error('资源不属于当前研究。');
      }
      data.scope = options.scope;
      const session = data.sessions[scopeKey(options.scope)];
      if (options.target === 'main') {
        if (JSON.stringify(session.active) !== JSON.stringify(ref))
          session.history.push(session.active);
        session.active = ref;
        session.anchor = options.anchor;
        if (!session.openItems.some((item) => sameRef(item, ref)))
          session.openItems.push(ref);
      } else {
        if (session.panel.ref) session.panel.history.push(session.panel.ref);
        session.panel = {
          ...session.panel,
          open: true,
          mode: 'references',
          ref,
          anchor: options.anchor,
        };
      }
      if (ref.kind === 'document' && options.anchor) {
        const evidence = options.anchor.evidenceId
          ? data.evidence[options.anchor.evidenceId]
          : undefined;
        if (
          options.anchor.evidenceId &&
          (!evidence || evidence.documentId !== ref.id)
        )
          throw new Error('来源证据缺失或不属于此论文。');
        const pageIndex = evidence?.pageIndex ?? options.anchor.pageIndex;
        if (pageIndex !== undefined) {
          if (
            !Number.isInteger(pageIndex) ||
            pageIndex < 0 ||
            pageIndex >= data.documents[ref.id].pageCount
          )
            throw new Error('来源页码无效。');
          const readerKey = `${options.target}:${ref.id}`;
          session.readers[readerKey] = {
            pageIndex,
            scale: session.readers[readerKey]?.scale ?? 1,
          };
        }
      }
    });
    if (options.target === 'main') status({ selection: undefined });
  },
  back(target: 'main' | 'inspector') {
    workspace.updateData((data) => {
      const session = data.sessions[scopeKey(data.scope)];
      if (target === 'main') {
        const previous = session.history.pop();
        if (previous && (previous.kind === 'collection' || resourceExists(data, previous))) {
          session.active = previous;
          if (previous.kind !== 'collection' && !session.openItems.some(ref => sameRef(ref, previous))) session.openItems.push(previous);
        }
        session.anchor = undefined;
      } else {
        session.panel.ref = session.panel.history.pop();
        session.panel.anchor = undefined;
      }
    });
  },
  closeResource(ref: ResourceRef) {
    workspace.updateData((data) => {
      const session = data.sessions[scopeKey(data.scope)];
      session.openItems = session.openItems.filter(
        (item) => !sameRef(item, ref),
      );
      session.pinnedIds = session.pinnedIds.filter((id) => id !== ref.id);
      if (session.active.kind !== 'collection' && sameRef(session.active, ref))
        session.active =
          session.openItems.at(-1) ??
          (data.scope.kind === 'research'
            ? { kind: 'research', id: data.scope.researchId }
            : { kind: 'collection', id: 'documents' });
    });
  },
  pinResource(ref: ResourceRef) {
    workspace.updateData((data) => {
      const s = data.sessions[scopeKey(data.scope)];
      s.pinnedIds = s.pinnedIds.includes(ref.id)
        ? s.pinnedIds.filter((id) => id !== ref.id)
        : [...s.pinnedIds, ref.id];
    });
  },
  switchResearch(researchId: string) {
    if (!state.data.researches[researchId]) return;
    workspace.updateData((data) => {
      data.scope = { kind: 'research', researchId };
    });
    status({ selection: undefined });
  },
  createResearch(title: string, question: string) {
    if (!title.trim()) throw new Error('请填写研究名称');
    const id = uid('research'),
      boardId = uid('board'),
      draftId = uid('draft'),
      conversationId = `conversation-${id}`;
    workspace.updateData((data) => {
      data.researches[id] = {
        id,
        title: title.trim(),
        question,
        documentIds: [],
        cardIds: [],
        createdAt: new Date().toISOString(),
      };
      data.boards[boardId] = {
        id: boardId,
        researchId: id,
        title: '证据与论证',
      };
      data.drafts[draftId] = {
        id: draftId,
        researchId: id,
        title: '研究结论',
        body: '',
        evidenceIds: [],
      };
      data.conversations[conversationId] = {
        id: conversationId,
        researchId: id,
        contextIds: [],
        requestIds: [],
      };
      data.sessions[id] = emptySession({ kind: 'research', id });
      data.sessions[id].activeConversationId = conversationId;
      data.scope = { kind: 'research', researchId: id };
    });
    return id;
  },
  associateDocument(researchId: string, documentId: string) {
    workspace.updateData((data) => {
      if (!data.researches[researchId] || !data.documents[documentId])
        throw new Error('研究或论文不存在');
      data.researches[researchId].documentIds = [
        ...new Set([...data.researches[researchId].documentIds, documentId]),
      ];
    });
  },
  associateCard(researchId: string, cardId: string) {
    workspace.updateData((data) => linkCard(data, researchId, cardId));
  },
  createEvidence(range: {
    documentId: string;
    pageIndex: number;
    quote: string;
  }): string {
    const existing = Object.values(state.data.evidence).find(e => e.kind !== 'region' && e.documentId === range.documentId && e.pageIndex === range.pageIndex && e.quote === range.quote.trim());
    if (existing) return existing.id;
    const id = uid('evidence');
    workspace.updateData((data) => {
      data.evidence[id] = { id, ...range, quote: range.quote.trim() };
      validateEvidence(data, [id]);
    });
    return id;
  },
  createRegionEvidence(range: { documentId: string; pageIndex: number; quote: string; region: RegionSource }): string {
    const id = uid('evidence');
    workspace.updateData(data => {
      data.evidence[id] = { ...range, id, kind: 'region' };
      validateEvidence(data, [id]);
    });
    return id;
  },
  getActiveConversation(researchId?: string): Conversation {
    const id = researchId ?? (state.data.scope.kind === 'research' ? state.data.scope.researchId : undefined);
    if (!id || !state.data.researches[id]) throw new Error('请先选择一个研究。');
    const existing = getActiveConversation(state.data, id);
    if (existing) return existing;
    const conversationId = workspace.createConversation(id);
    return state.data.conversations[conversationId];
  },
  createConversation(researchId: string): string {
    const id = uid('conversation');
    workspace.updateData(data => {
      if (!data.researches[researchId]) throw new Error('研究不存在。');
      const current = getActiveConversation(data, researchId);
      const connectionId = current?.connectionId ?? (data.sessions[researchId].panel.aiMode === 'demo' ? 'demo' : 'model');
      data.conversations[id] = { id, researchId, connectionId, title: '新的阅读对话', contextIds: [], requestIds: [], input: '', historyRange: 'all', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      data.sessions[researchId].activeConversationId = id;
      data.sessions[researchId].panel.aiView = 'chat';
    });
    return id;
  },
  selectConversation(researchId: string, conversationId: string) {
    workspace.updateData(data => {
      const conversation = data.conversations[conversationId];
      if (!conversation || conversation.researchId !== researchId) throw new Error('会话不属于该研究。');
      conversation.connectionId ??= conversation.requestIds.map(id => data.requests[id]).filter(Boolean).at(-1)?.mode === 'demo' ? 'demo' : 'model';
      data.sessions[researchId].activeConversationId = conversationId;
      data.sessions[researchId].panel.aiView = 'chat';
      data.sessions[researchId].panel.aiMode = conversation.connectionId === 'demo' ? 'demo' : 'live';
    });
  },
  renameConversation(conversationId: string, title: string) {
    if (!title.trim()) throw new Error('会话名称不能为空。');
    workspace.updateData(data => { data.conversations[conversationId].title = title.trim().slice(0, 120); });
  },
  archiveConversation(conversationId: string, archived: boolean) {
    const conversation = state.data.conversations[conversationId];
    if (!conversation) throw new Error('会话不存在。');
    workspace.updateData(data => {
      data.conversations[conversationId].archived = archived;
      if (archived && data.sessions[conversation.researchId].activeConversationId === conversationId)
        data.sessions[conversation.researchId].activeConversationId = Object.values(data.conversations).find(c => c.researchId === conversation.researchId && !c.archived)?.id;
    });
    if (archived && !getActiveConversation(state.data, conversation.researchId)) workspace.createConversation(conversation.researchId);
  },
  openConversationSource(source: CardProvenance, returnRef?: ResourceRef) {
    workspace.updateData(data => {
      const panel = data.sessions[scopeKey(data.scope)].panel;
      panel.open = true;
      panel.mode = 'ai';
      panel.aiView = 'source';
      panel.conversationSource = structuredClone(source);
      panel.sourceReturnRef = returnRef;
    });
  },
  createCard(
    evidenceIds: string[],
    title = '新的观点',
    body = '',
    researchId = state.data.scope.kind === 'research'
      ? state.data.scope.researchId
      : undefined,
  ) {
    const id = uid('card');
    workspace.updateData((data) => {
      validateEvidence(data, evidenceIds);
      data.cards[id] = {
        id,
        title,
        body,
        evidenceIds: [...new Set(evidenceIds)],
        needsReview: true,
      };
      if (researchId) linkCard(data, researchId, id);
    });
    return id;
  },
  setSelection(selection?: Selection) {
    status({ selection });
  },
  setPanel(mode: PanelMode, open = true) {
    workspace.updateData((data) => {
      const panel = data.sessions[scopeKey(data.scope)].panel;
      panel.mode = mode;
      panel.open = open;
    });
  },
  setReader(
    documentId: string,
    position: { pageIndex: number; scale: number },
    target: 'main' | 'inspector' = 'main',
  ) {
    workspace.updateData((data) => {
      const doc = data.documents[documentId];
      if (!doc) return;
      data.sessions[scopeKey(data.scope)].readers[`${target}:${documentId}`] = {
        pageIndex: Math.max(0, Math.min(doc.pageCount - 1, position.pageIndex)),
        scale: Math.max(0.5, Math.min(2, position.scale)),
      };
    });
  },
  addPlacement(boardId: string, ref: ResourceRef): BoardPlacement {
    const id = uid('placement');
    let placement!: BoardPlacement;
    workspace.updateData((data) => {
      const board = data.boards[boardId];
      if (
        !board ||
        !resourceExists(data, ref) ||
        !['card', 'document'].includes(ref.kind)
      )
        throw new Error('白板资料不存在');
      if (ref.kind === 'card') linkCard(data, board.researchId, ref.id);
      else
        data.researches[board.researchId].documentIds = [
          ...new Set([
            ...data.researches[board.researchId].documentIds,
            ref.id,
          ]),
        ];
      const count = Object.values(data.placements).filter(
        (p) => p.boardId === boardId,
      ).length;
      placement = {
        id,
        boardId,
        resourceRef: ref,
        x: 50 + (count % 3) * 310,
        y: 80 + Math.floor(count / 3) * 270,
        group: '',
      };
      data.placements[id] = placement;
    });
    return placement;
  },
  addContext(input: {
    researchId: string;
    conversationId: string;
    evidenceIds: string[];
  }) {
    workspace.updateData((data) => {
      const research = data.researches[input.researchId],
        conversation = data.conversations[input.conversationId];
      if (!research || !conversation || conversation.researchId !== research.id)
        throw new Error('AI 会话与研究不匹配');
      const evidence = validateEvidence(data, input.evidenceIds);
      if (
        evidence.some((item) => !research.documentIds.includes(item.documentId))
      )
        throw new Error('请先将证据论文加入当前研究并用于对话。');
      conversation.contextIds = [
        ...new Set([...conversation.contextIds, ...input.evidenceIds]),
      ];
    });
  },
  contextFromEvidence(evidence: Evidence) {
    const scope = state.data.scope;
    if (scope.kind !== 'research')
      throw new Error('请先打开一个研究，再添加 AI 上下文。');
    workspace.addContext({
      researchId: scope.researchId,
      conversationId: workspace.getActiveConversation(scope.researchId).id,
      evidenceIds: [evidence.id],
    });
    workspace.setPanel('ai');
    workspace.updateData(data => { data.sessions[scope.researchId].panel.aiView = 'chat'; });
  },
};

export function useWorkspace() {
  const snapshot = useSyncExternalStore(
    workspace.subscribe,
    workspace.getState,
  );
  return {
    ...snapshot,
    session: snapshot.data.sessions[scopeKey(snapshot.data.scope)],
    research:
      snapshot.data.scope.kind === 'research'
        ? snapshot.data.researches[snapshot.data.scope.researchId]
        : undefined,
    actions: workspace,
  };
}
