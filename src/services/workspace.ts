import { useSyncExternalStore } from 'react';
import { createSeed, emptySession } from '../data/seed';
import { loadWorkspace, saveWorkspace, saveMigrationBackup, restoreWorkspaceBackup } from '../data/storage';
import { migrateWorkspace } from '../data/migrations';
import { hasFullText, normalizeIdentifier } from '../domain/knowledge';
export { hasFullText, normalizeIdentifier, conclusionIssues } from '../domain/knowledge';
import type {
  BoardPlacement,
  ReadingPosition,
  ReaderTarget,
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
  ResearchViewId,
  ResearchDirectory,
  SourceCandidate,
  SourceDiscovery,
} from '../domain/types';

export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const scopeKey = (scope: WorkspaceScope) =>
  scope.kind === 'research' ? scope.researchId : 'library';
export const sameRef = (a: { kind: string; id: string }, b: { kind: string; id: string }) =>
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
      !hasFullText(doc) ||
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
let inFlightSave: Promise<void> | undefined;
let restoring = false;
let loadGeneration = 0;
const JOURNAL = 'papertrail-recovery-v3';
const PREVIOUS_JOURNAL = 'papertrail-recovery-v2';
const LEGACY_JOURNAL = 'papertrail-recovery-v1';
function emit() {
  listeners.forEach((listener) => listener());
}
function status(patch: Partial<WorkspaceState>) {
  state = { ...state, ...patch };
  emit();
}
function persist(): Promise<void> {
  if (inFlightSave) return inFlightSave;
  inFlightSave = saveSnapshot().finally(() => { inFlightSave = undefined; });
  return inFlightSave;
}
async function saveSnapshot() {
  if (saving || !state.loaded || state.loadError) return;
  saving = true;
  const currentRevision = revision,
    snapshot = state.data;
  status({ saveStatus: 'saving', saveError: undefined });
  try {
    await saveWorkspace(snapshot);
    if (journalRevision <= currentRevision) localStorage.removeItem(JOURNAL);
    localStorage.removeItem(LEGACY_JOURNAL);
    localStorage.removeItem(PREVIOUS_JOURNAL);
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
  getGeneration: () => loadGeneration,
  getSession: (scope = state.data.scope): Session =>
    state.data.sessions[scopeKey(scope)],
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  async load() {
    loadGeneration++;
    try {
      if (inFlightSave) await inFlightSave;
      const currentJournal = localStorage.getItem(JOURNAL);
      const previousJournal = localStorage.getItem(PREVIOUS_JOURNAL);
      const journal = currentJournal ?? previousJournal;
      const oldJournal = localStorage.getItem(LEGACY_JOURNAL);
      const database = await loadWorkspace();
      for (const candidate of [database, journal && JSON.parse(journal), oldJournal && JSON.parse(oldJournal)]) {
        if (candidate && typeof candidate.schemaVersion === 'number' && candidate.schemaVersion > 3) throw new Error('存储版本不受支持，未覆盖现有数据。请使用创建这些数据的新版应用。');
      }
      const saved = journal ? JSON.parse(journal) : database?.schemaVersion === 3 ? database : oldJournal ? JSON.parse(oldJournal) : database;
      const migrated = saved && saved.schemaVersion < 3;
      const interrupted = saved && (Object.values(saved.requests ?? {}).some(request => (request as { status?: string }).status === 'generating') || Object.values(saved.cardDrafts ?? {}).some(draft => (draft as { status?: string }).status === 'generating') || Object.values(saved.documents ?? {}).some(doc => (doc as { acquisition?: { status?: string } }).acquisition?.status === 'fetching'));
      if (migrated) await saveMigrationBackup({ database, recovery: journal ?? oldJournal });
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
  updateData(change: (data: WorkspaceData) => void, options?: { nativeHistoryRef: string }) {
    if (restoring) throw new Error('正在恢复资料，请稍后再编辑。');
    if (!state.loaded || state.loadError)
      throw new Error('数据尚未成功加载，请重试加载后编辑');
    const data = structuredClone(state.data);
    change(data);
    for (const request of Object.values(state.data.requests)) {
      const next = data.requests[request.id];
      // Native imports are a read-only display cache. Saved cards retain their own source snapshot.
      const nativeRefresh = options?.nativeHistoryRef && request.nativeImported && next?.nativeImported
        && request.nativeMessageId === next.nativeMessageId && request.nativeSessionId === next.nativeSessionId
        && request.prompt === next.prompt && request.conversationId === next.conversationId
        && data.conversations[request.conversationId]?.nativeSessionRef === options.nativeHistoryRef;
      if (request.status !== 'generating' && next && next.body !== request.body && !nativeRefresh)
        throw new Error('原始问答不可改写，请编辑独立卡片草稿。');
    }
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
    if (inFlightSave) void inFlightSave.then(() => { if (state.saveStatus !== 'saved') void persist(); });
    else void persist();
  },
  async flushSave() {
    clearTimeout(timer);
    if (!state.loaded || state.loadError) return;
    do {
      await persist();
      clearTimeout(timer);
      if (state.saveStatus === 'error') throw new Error(state.saveError || '本地保存失败。');
    } while (state.saveStatus !== 'saved');
  },
  async restoreBackup(data: WorkspaceData, assets: Array<{ id: string; blob: Blob }>) {
    if (restoring) throw new Error('已有恢复任务正在进行。');
    restoring = true;
    loadGeneration++;
    try {
      await workspace.flushSave();
      // Refuse the restore if stale recovery buffers cannot be removed first.
      localStorage.removeItem(JOURNAL);
      localStorage.removeItem(LEGACY_JOURNAL);
      localStorage.removeItem(PREVIOUS_JOURNAL);
      await restoreWorkspaceBackup(data, assets);
      await workspace.load();
      if (state.loadError) throw new Error(state.loadError);
    } finally { restoring = false; }
  },
  notice(message?: string) {
    status({ notice: message });
  },
  openResearchView(researchId: string, view: ResearchViewId) {
    workspace.updateData(data => {
      if (!data.researches[researchId]) throw new Error('研究不存在。');
      data.scope = { kind: 'research', researchId };
      const session = data.sessions[researchId];
      session.sourcePreview = undefined;
      if (session.active.kind !== 'researchView' || session.active.id !== view) session.history.push(session.active);
      session.active = { kind: 'researchView', id: view };
      session.researchView = view;
      session.anchor = undefined;
    });
    status({ selection: undefined });
  },
  openSourcePreview(candidate: SourceCandidate, scope: WorkspaceScope, discovery?: SourceDiscovery) {
    const url = new URL(candidate.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('请使用有效的公开网页链接。');
    workspace.updateData(data => {
      const session = data.sessions[scopeKey(scope)];
      if (!session) throw new Error('研究不存在。');
      data.scope = scope;
      session.sourcePreview = { candidate, discovery };
    });
    status({ selection: undefined });
  },
  closeSourcePreview(scope = state.data.scope) {
    workspace.updateData(data => { data.sessions[scopeKey(scope)].sourcePreview = undefined; });
  },
  addSource(input: { kind: 'identifier'; raw: string } | { kind: 'title'; title: string } | { kind: 'library'; documentId: string }, target: WorkspaceScope) {
    let documentId = '', created = false;
    workspace.updateData(data => {
      if (target.kind === 'research' && !data.researches[target.researchId]) throw new Error('研究不存在。');
      if (input.kind === 'library') {
        if (!data.documents[input.documentId]) throw new Error('资料不存在。');
        documentId = input.documentId;
      } else {
        const identifier = input.kind === 'identifier' ? normalizeIdentifier(input.raw) : undefined;
        if (input.kind === 'identifier' && !identifier) throw new Error('无法识别标识，请按标题新建。');
        const title = input.kind === 'title' ? input.title.trim() : identifier!.kind === 'url' ? new URL(identifier!.value).hostname : identifier!.value;
        if (!title) throw new Error('请填写标题。');
        const existing = identifier && Object.values(data.documents).find(doc => doc.identifiers?.[identifier.kind] === identifier.value);
        documentId = existing?.id ?? uid('document');
        if (!existing) {
          created = true;
          data.documents[documentId] = { id: documentId, title, authors: '', year: '', identifiers: identifier ? { [identifier.kind]: identifier.value } : undefined, readingStatus: 'unread', textStatus: 'pending', updatedAt: new Date().toISOString() };
        }
      }
      if (target.kind === 'research') data.researches[target.researchId].documentIds = [...new Set([...data.researches[target.researchId].documentIds, documentId])];
    });
    return { documentId, created };
  },
  mergeDocuments(stubId: string, intoId: string) {
    workspace.updateData(data => {
      const stub = data.documents[stubId], target = data.documents[intoId];
      const sameIdentifier = stub && target && (['doi', 'arxiv'] as const).some(key => stub.identifiers?.[key] && stub.identifiers[key] === target.identifiers?.[key]);
      if (!stub || hasFullText(stub) || !target || !hasFullText(target) && !sameIdentifier || stubId === intoId) throw new Error('只能把无全文条目合并到已有全文或具有相同文献标识的资料。');
      if ((['doi', 'arxiv'] as const).some(key => stub.identifiers?.[key] && target.identifiers?.[key] && stub.identifiers[key] !== target.identifiers[key]) || stub.identifiers?.url && target.identifiers?.url && stub.identifiers.url !== target.identifiers.url && !sameIdentifier) throw new Error('两条资料的标识不一致，无法安全合并；请先核对来源。');
      if (Object.values(data.evidence).some(e => e.documentId === stubId)) throw new Error('无全文条目已有摘录，无法安全合并。');
      for (const research of Object.values(data.researches)) {
        research.documentIds = [...new Set(research.documentIds.map(id => id === stubId ? intoId : id))];
        const source = research.sourceRecords?.[stubId];
        if (source && research.sourceRecords) {
          const targetRecord = research.sourceRecords[intoId];
          research.sourceRecords[intoId] = {
            note: [...new Set([targetRecord?.note, source.note].filter(Boolean))].join('\n\n'),
            discoveries: [...(targetRecord?.discoveries ?? []), ...source.discoveries].filter((item, index, items) => items.findIndex(other => other.url === item.url && other.requestId === item.requestId && other.conversationId === item.conversationId) === index),
          };
          delete research.sourceRecords[stubId];
        }
      }
      const move = (ref: { kind: string; id: string }) => { if (ref.kind === 'document' && ref.id === stubId) ref.id = intoId; };
      for (const placement of Object.values(data.placements)) move(placement.resourceRef);
      for (const session of Object.values(data.sessions)) {
        if (session.documentInfoId === stubId) session.documentInfoId = intoId;
        for (const ref of [session.active, ...session.openItems, ...session.history, ...session.panel.history]) move(ref);
        if (session.panel.ref) move(session.panel.ref);
        if (session.panel.sourceReturnRef) move(session.panel.sourceReturnRef);
        for (const ref of session.recentItems ?? []) move(ref);
        session.openItems = session.openItems.filter((ref, index, items) => items.findIndex(other => sameRef(ref, other)) === index);
        session.pinnedIds = [...new Set(session.pinnedIds.map(id => id === stubId ? intoId : id))];
      }
      target.identifiers = { ...stub.identifiers, ...target.identifiers };
      target.abstract ??= stub.abstract;
      target.abstractAlternatives = [...(target.abstractAlternatives ?? []), ...(stub.abstractAlternatives ?? []), ...(stub.abstract ? [stub.abstract] : [])].filter((item, index, items) => (item.text !== target.abstract?.text || item.url !== target.abstract?.url) && items.findIndex(other => item.text === other.text && item.url === other.url) === index);
      target.metadataSource ??= stub.metadataSource;
      target.sourceKind ??= stub.sourceKind;
      target.pdfUrl ??= stub.pdfUrl;
      delete data.documents[stubId];
    });
    status({ selection: undefined });
  },
  captureExcerpt(researchId: string, range: { documentId: string; pageIndex: number; quote: string }) {
    const existing = Object.values(state.data.evidence).find(e => e.kind !== 'region' && e.researchId === researchId && e.documentId === range.documentId && e.pageIndex === range.pageIndex && e.quote === range.quote.trim());
    if (existing) return existing.id;
    const id = uid('evidence');
    workspace.updateData(data => {
      if (!data.researches[researchId]?.documentIds.includes(range.documentId)) throw new Error('请先把资料加入该研究。');
      data.evidence[id] = { id, ...range, quote: range.quote.trim(), researchId, createdAt: new Date().toISOString() };
      validateEvidence(data, [id]);
    });
    return id;
  },
  removeExcerpt(evidenceId: string) {
    workspace.updateData(data => {
      if (Object.values(data.cards).some(c => c.evidenceIds.includes(evidenceId)) || Object.values(data.drafts).some(d => d.evidenceIds.includes(evidenceId)) || Object.values(data.conversations).some(c => c.contextIds.includes(evidenceId)) || Object.values(data.requests).some(r => r.context.some(c => c.evidenceId === evidenceId)) || Object.values(data.cardDrafts).some(d => d.evidenceIds.includes(evidenceId))) throw new Error('摘录已被引用，请先移除引用。');
      delete data.evidence[evidenceId];
    });
  },
  attachEvidenceToCard(cardId: string, evidenceId: string) {
    workspace.updateData(data => {
      const card = data.cards[cardId];
      if (!card) throw new Error('卡片不存在。');
      validateEvidence(data, [evidenceId]);
      card.evidenceIds = [...new Set([...card.evidenceIds, evidenceId])];
      card.needsReview = true;
      card.evidenceUpdatedAt = new Date().toISOString();
      for (const research of Object.values(data.researches)) if (research.cardIds.includes(cardId)) linkCard(data, research.id, cardId);
    });
    workspace.notice('已添加依据；确认原文确实支持后再标为已核查。');
  },
  findEvidence(cardId: string) {
    workspace.updateData(data => {
      if (data.scope.kind !== 'research' || !data.researches[data.scope.researchId].cardIds.includes(cardId)) throw new Error('请先在卡片所在研究中找依据。');
      const panel = data.sessions[data.scope.researchId].panel;
      panel.open = true; panel.mode = 'cards'; panel.findEvidenceFor = cardId; panel.citation = undefined;
    });
  },
  openCollection(collection: CollectionId) {
    workspace.updateData((data) => {
      const session = data.sessions.library;
      if (data.scope.kind === 'research') session.libraryResearchId = data.scope.researchId;
      data.scope = { kind: 'library' };
      session.sourcePreview = undefined;
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
    if (ref.kind === 'research') { workspace.openResearchView(ref.id, 'home'); return; }
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
        session.sourcePreview = undefined;
        session.documentInfoId = undefined;
        if (JSON.stringify(session.active) !== JSON.stringify(ref))
          session.history.push(session.active);
        if (ref.kind === 'document' && !options.anchor && !session.panel.pinned && !session.panel.findEvidenceFor && !session.panel.citation && session.panel.mode !== 'ai') { session.panel.open = true; session.panel.mode = 'excerpts'; }
        session.active = ref;
        session.recentItems = [ref, ...(session.recentItems ?? []).filter(item => !sameRef(item, ref))].slice(0, 8);
        session.anchor = options.anchor;
        if (!session.openItems.some((item) => sameRef(item, ref)))
          session.openItems.push(ref);
      } else {
        if (session.panel.ref) session.panel.history.push(session.panel.ref);
        session.panel = {
          ...session.panel,
          open: true,
          mode: 'cards',
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
            (!hasFullText(data.documents[ref.id]) || pageIndex >= data.documents[ref.id].pageCount!)
          )
            throw new Error('来源页码无效。');
          const readerKey = `${options.target}:${ref.id}`;
          session.readers[readerKey] = {
            pageIndex,
            scale: session.readers[readerKey]?.scale ?? 1,
            ...(session.readers[readerKey]?.offset !== undefined ? { offset: 0 } : {}),
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
        if (session.sourcePreview) { session.sourcePreview = undefined; return; }
        const previous = session.history.pop();
        if (previous && (previous.kind === 'collection' || previous.kind === 'researchView' || resourceExists(data, previous))) {
          session.active = previous;
          if (previous.kind === 'researchView') session.researchView = previous.id;
          if (previous.kind !== 'collection' && previous.kind !== 'researchView' && !session.openItems.some(ref => sameRef(ref, previous))) session.openItems.push(previous);
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
      if (session.active.kind !== 'collection' && session.active.kind !== 'researchView' && sameRef(session.active, ref))
        session.active =
          session.openItems.at(-1) ??
          (data.scope.kind === 'research'
            ? { kind: 'researchView', id: session.researchView ?? 'home' }
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
  createResearch(title: string, question: string, prepared?: { id: string; directory?: ResearchDirectory }) {
    if (!title.trim()) throw new Error('请填写研究名称');
    const id = prepared?.id ?? uid('research'),
      boardId = uid('board'),
      draftId = uid('draft'),
      conversationId = `conversation-${id}`;
    workspace.updateData((data) => {
      if (data.researches[id]) throw new Error('研究已存在，请恢复原来的创建操作。');
      data.researches[id] = {
        id,
        title: title.trim(),
        question,
        documentIds: [],
        cardIds: [],
        createdAt: new Date().toISOString(),
        ...(prepared?.directory ? { directory: prepared.directory } : {}),
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
      data.sessions[id] = emptySession({ kind: 'researchView', id: 'home' });
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
      data.evidence[id] = { id, ...range, quote: range.quote.trim(), researchId: data.scope.kind === 'research' ? data.scope.researchId : undefined, createdAt: new Date().toISOString() };
      validateEvidence(data, [id]);
    });
    return id;
  },
  createRegionEvidence(range: { documentId: string; pageIndex: number; quote: string; region: RegionSource }): string {
    const id = uid('evidence');
    workspace.updateData(data => {
      data.evidence[id] = { ...range, id, kind: 'region', researchId: data.scope.kind === 'research' ? data.scope.researchId : undefined, createdAt: new Date().toISOString() };
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
    position: ReadingPosition,
    target: ReaderTarget = 'main',
    scope: WorkspaceScope = state.data.scope,
  ) {
    workspace.updateData((data) => {
      const doc = data.documents[documentId];
      const session = data.sessions[scopeKey(scope)];
      if (!session || scope.kind === 'research' && !data.researches[scope.researchId]?.documentIds.includes(documentId)) return;
      if (!hasFullText(doc) || !Number.isFinite(position.pageIndex) || !Number.isFinite(position.scale)) return;
      session.readers[`${target}:${documentId}`] = {
        pageIndex: Math.max(0, Math.min(doc.pageCount - 1, Math.floor(position.pageIndex))),
        scale: Math.max(0.5, Math.min(2, position.scale)),
        ...(position.offset !== undefined && Number.isFinite(position.offset) ? { offset: Math.max(0, Math.min(1, position.offset)) } : {}),
      };
    });
  },
  setReaderSplit(documentId: string, layout?: 'horizontal' | 'vertical') {
    workspace.updateData(data => {
      if (!hasFullText(data.documents[documentId])) return;
      const session = data.sessions[scopeKey(data.scope)];
      if (layout) {
        session.readerSplits ??= {};
        session.readerSplits[documentId] = layout;
        session.readers[`main-secondary:${documentId}`] ??= structuredClone(session.readers[`main:${documentId}`] ?? { pageIndex: 0, scale: 1 });
      } else if (session.readerSplits) delete session.readerSplits[documentId];
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
