import { validateTextAnchor } from '../domain/reader-context';
import { evidenceGroup, findEvidenceSelection, type EvidenceFragment } from '../domain/evidence';
import { useContext, useMemo, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { PaneContext } from './pane-context';
import { createSeed, emptySession } from '../data/seed';
import { loadWorkspace, saveWorkspace, saveMigrationBackup, restoreWorkspaceBackup } from '../data/storage';
import { migrateWorkspace } from '../data/migrations';
import { hasFullText, normalizeIdentifier } from '../domain/knowledge';
import { paneGroups, findPaneTab, ensurePaneLayout, replacePane, collapseEmptyPanes, syncPaneSession, isResourceView } from './panes';
export { getReaderPosition } from './panes';
import { recordBoardChanges, type BoardChangeInfo } from '../domain/board-history';
import { flushBoardDrawings } from './drawing-storage';
import { layoutBoardTree } from '../domain/board-layout';
import { researchResourceIds, type ResearchResourceKind } from '../domain/research-order';
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
  PaneNode,
  WorkspaceTab,
  WorkspaceViewRef,
  WorkspaceLayout,
  BoardViewport,
} from '../domain/types';

export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const scopeKey = (scope: WorkspaceScope) =>
  scope.kind === 'research' ? scope.researchId : 'library';
export const sameRef = (a: { kind: string; id: string }, b: { kind: string; id: string }) =>
  a.kind === b.kind && a.id === b.id;
const readerFlushes = new Map<string, () => void>();
export function registerReaderFlush(key: string, flush: () => void) {
  readerFlushes.set(key, flush);
  return () => { if (readerFlushes.get(key) === flush) readerFlushes.delete(key); };
}
function flushPaneReaders() { for (const flush of [...readerFlushes.values()]) flush(); }
type PaneSide = 'left' | 'right' | 'up' | 'down';
function splitLayout(session: Session, paneId: string, side: PaneSide, tab?: WorkspaceTab) {
  const layout = ensurePaneLayout(session);
  if (!['left', 'right', 'up', 'down'].includes(side) || !paneGroups(layout.root).some(pane => pane.id === paneId)) throw new Error('目标窗格不存在。');
  const pane = { kind: 'group' as const, id: uid('pane'), tabs: tab ? [tab] : [], activeTabId: tab?.id };
  const old = paneGroups(layout.root).find(pane => pane.id === paneId)!;
  const first = side === 'left' || side === 'up';
  layout.root = replacePane(layout.root, paneId, { kind: 'split', id: uid('split'), axis: side === 'left' || side === 'right' ? 'row' : 'column', ratio: 0.5, first: first ? pane : old, second: first ? old : pane });
  layout.focusedPaneId = pane.id;
  delete layout.zoomedPaneId;
}
function activateTab(session: Session, pane: import('../domain/types').PaneGroup, tab: WorkspaceTab, history = true) {
  if (history && pane.activeTabId && pane.activeTabId !== tab.id) pane.history = [...(pane.history ?? []), pane.activeTabId].slice(-100);
  pane.activeTabId = tab.id;
  pane.recentTabIds = [tab.id, ...(pane.recentTabIds ?? []).filter(id => id !== tab.id)].slice(0, 100);
  const layout = ensurePaneLayout(session); layout.focusedPaneId = pane.id;
  if (layout.zoomedPaneId) layout.zoomedPaneId = pane.id;
  syncPaneSession(session);
}
function openPaneView(session: Session, ref: WorkspaceViewRef, options: { anchor?: ResourceAnchor; paneId?: string; split?: PaneSide; viewId?: string; preview?: WorkspaceTab['preview']; reading?: ReadingPosition } = {}) {
  const layout = ensurePaneLayout(session);
  const pane = paneGroups(layout.root).find(pane => pane.id === (options.paneId ?? (options.viewId ? findPaneTab(layout, options.viewId)?.pane.id : undefined) ?? layout.focusedPaneId));
  if (!pane) throw new Error('原窗格已关闭，请重新打开。');
  const anchor = options.anchor;
  let tab = !options.split && (options.viewId ? pane.tabs.find(t => t.id === options.viewId && sameRef(t.ref, ref)) :
    [...(pane.recentTabIds ?? []), ...pane.tabs.map(t => t.id)].map(id => pane.tabs.find(t => t.id === id)).find(t => t && sameRef(t.ref, ref) && (!anchor || t.anchor && JSON.stringify(t.anchor) === JSON.stringify(anchor))));
  if (!tab) {
    tab = { id: uid('view'), ref: { ...ref }, ...(ref.kind === 'document' && session.readers[`main:${ref.id}`] ? { reading: { ...session.readers[`main:${ref.id}`] } } : {}) };
    if (!options.split) pane.tabs.push(tab);
  }
  if (anchor) { tab.anchor = { ...anchor }; if (ref.kind === 'document' && session.readers[`main:${ref.id}`]) tab.reading = { ...session.readers[`main:${ref.id}`] }; }
  if (options.reading && ref.kind === 'document') tab.reading = { ...options.reading };
  if (isResourceView(ref)) tab.documentInfo = false;
  if (options.preview) tab.preview = structuredClone(options.preview);
  if (options.split) { splitLayout(session, pane.id, options.split, tab); syncPaneSession(session); }
  else activateTab(session, pane, tab);
  return tab;
}
const layoutUndo = new Map<string, WorkspaceLayout>();
function structure(layout?: WorkspaceLayout): string {
  const walk = (node: PaneNode): unknown => node.kind === 'split' ? [node.id, node.axis, node.ratio, walk(node.first), walk(node.second)] : [node.id, node.tabs.map(t => [t.id, t.ref])];
  return layout ? JSON.stringify([walk(layout.root), layout.zoomedPaneId]) : '';
}
function rememberLayoutUndo(key: string, before: WorkspaceLayout) { layoutUndo.set(key, before); emit(); }
export function resourceTitle(data: WorkspaceData, ref: WorkspaceViewRef) {
  if (ref.kind === 'researchView') return ({ home: '研究主页', sources: '资料', excerpts: '摘录', cards: '卡片', boards: '白板', drafts: '文稿' })[ref.id];
  if (ref.kind === 'collection') return ref.id === 'cards' ? '资料库 · 卡片' : '资料库';
  if (ref.kind === 'sourcePreview') return Object.values(data.sessions).flatMap(s => s.layout ? paneGroups(s.layout.root).flatMap(p => p.tabs) : []).find(t => sameRef(t.ref, ref))?.preview?.candidate.title ?? '来源预览';
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
export function resourceExists(data: WorkspaceData, ref: WorkspaceViewRef) {
  if (!isResourceView(ref)) return false;
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
function closeDocumentViews(session: Session, documentId: string, fallback: WorkspaceViewRef) {
  const matches = (ref?: { kind: string; id: string }) => ref?.kind === 'document' && ref.id === documentId;
  session.history = session.history.filter(ref => !matches(ref));
  session.openItems = session.openItems.filter(ref => !matches(ref));
  session.recentItems = session.recentItems?.filter(ref => !matches(ref));
  session.pinnedIds = session.pinnedIds.filter(id => id !== documentId);
  session.panel.history = session.panel.history.filter(ref => !matches(ref));
  if (matches(session.panel.ref)) { session.panel.ref = undefined; session.panel.anchor = undefined; session.panel.pinned = false; }
  if (matches(session.panel.sourceReturnRef)) session.panel.sourceReturnRef = undefined;
  if (matches(session.mainSplit?.ref)) session.mainSplit = undefined;
  if (session.documentInfoId === documentId) session.documentInfoId = undefined;
  for (const key of Object.keys(session.readers)) if (key.endsWith(`:${documentId}`)) delete session.readers[key];
  if (session.layout && paneGroups(session.layout.root).some(pane => pane.tabs.some(tab => matches(tab.ref)))) {
    for (const pane of paneGroups(session.layout.root)) pane.tabs = pane.tabs.filter(tab => !matches(tab.ref));
    session.layout.root = collapseEmptyPanes(session.layout.root);
    syncPaneSession(session);
    const focused = paneGroups(session.layout.root).find(pane => pane.id === session.layout!.focusedPaneId)!;
    if (!focused.tabs.length) openPaneView(session, fallback);
  } else if (matches(session.active)) { session.active = fallback; session.anchor = undefined; }
}
function clearEvidenceAnchors(data: WorkspaceData, evidenceId: string) {
  for (const session of Object.values(data.sessions)) {
    const anchors = [session.anchor, session.panel.anchor, session.mainSplit?.anchor,
      ...(session.layout ? paneGroups(session.layout.root).flatMap(pane => pane.tabs.map(tab => tab.anchor)) : [])];
    for (const anchor of anchors) if (anchor?.evidenceId === evidenceId) delete anchor.evidenceId;
    if (session.panel.citation?.evidenceId === evidenceId) session.panel.citation = undefined;
  }
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
  return active && !active.archived && !active.deletedAt && active.researchId === researchId ? active :
    Object.values(data.conversations).find(c => c.researchId === researchId && !c.archived && !c.deletedAt && (!c.inlineSource || c.inlineSource.promoted));
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
  evidence.forEach(item => { delete item.contextOnly; });
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
    layoutUndo.clear();
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
      const migrated = saved && (saved.schemaVersion < 3 || Object.values(saved.sessions ?? {}).some(session => (!(session as Session).layout?.version || (session as Session).agentFocus !== undefined)));
      const interrupted = saved && (Object.values(saved.requests ?? {}).some(request => (request as { status?: string }).status === 'generating') || Object.values(saved.cardDrafts ?? {}).some(draft => (draft as { status?: string }).status === 'generating') || Object.values(saved.documents ?? {}).some(doc => (doc as { acquisition?: { status?: string } }).acquisition?.status === 'fetching'));
      if (migrated) await saveMigrationBackup({ database, recovery: journal ?? oldJournal });
      const data = migrateWorkspace(saved ?? createSeed());
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
  updateData(change: (data: WorkspaceData) => void, options?: { nativeHistoryRef?: string; nativeRunRef?: string; boardChange?: BoardChangeInfo }) {
    if (restoring) throw new Error('正在恢复资料，请稍后再编辑。');
    if (!state.loaded || state.loadError)
      throw new Error('数据尚未成功加载，请重试加载后编辑');
    const data = structuredClone(state.data);
    change(data);
    for (const key of layoutUndo.keys()) {
      const old = state.data.sessions[key];
      const membership = (d: WorkspaceData) => JSON.stringify([Object.keys(d.documents),Object.keys(d.cards),Object.keys(d.boards),Object.keys(d.drafts),Object.keys(d.evidence),Object.keys(d.placements),d.researches[key]?.documentIds.slice().sort(),d.researches[key]?.cardIds.slice().sort()]);
      if (scopeKey(data.scope) !== scopeKey(state.data.scope) || structure(old.layout) !== structure(data.sessions[key]?.layout) || membership(data) !== membership(state.data)) layoutUndo.delete(key);
    }
    for (const request of Object.values(state.data.requests)) {
      const next = data.requests[request.id];
      // Native imports are a read-only display cache. Saved cards retain their own source snapshot.
      const nativeRefresh = options?.nativeHistoryRef && request.nativeImported && next?.nativeImported
        && request.nativeMessageId === next.nativeMessageId && request.nativeSessionId === next.nativeSessionId
        && request.prompt === next.prompt && request.conversationId === next.conversationId
        && data.conversations[request.conversationId]?.nativeSessionRef === options.nativeHistoryRef;
      const nativeRecovery = options?.nativeRunRef === request.id && request.nativeRun?.managed && next?.nativeRun?.managed
        && request.status !== 'done' && request.connectionId === 'codex' && next.connectionId === request.connectionId
        && request.researchId === next.researchId && request.conversationId === next.conversationId && request.prompt === next.prompt
        && (!request.nativeSessionId || request.nativeSessionId === next.nativeSessionId)
        && (!request.nativeTurnId || request.nativeTurnId === next.nativeTurnId)
        && JSON.stringify(request.context) === JSON.stringify(next.context);
      const nativeHistoryRecovery = options?.nativeHistoryRef && request.nativeRun?.managed && next?.nativeRun?.managed
        && request.status !== 'done' && request.connectionId === 'codex' && next.connectionId === request.connectionId
        && request.nativeSessionId && request.nativeSessionId === next.nativeSessionId && next.nativeTurnId
        && (!request.nativeTurnId || request.nativeTurnId === next.nativeTurnId)
        && request.prompt === next.prompt && request.researchId === next.researchId && request.conversationId === next.conversationId
        && data.conversations[request.conversationId]?.nativeSessionRef === options.nativeHistoryRef
        && JSON.stringify(request.context) === JSON.stringify(next.context);
      if (request.status !== 'generating' && next && next.body !== request.body && !nativeRefresh && !nativeRecovery && !nativeHistoryRecovery)
        throw new Error('原始问答不可改写，请编辑独立卡片草稿。');
    }
    recordBoardChanges(state.data, data, options?.boardChange);
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
    await flushBoardDrawings();
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
  openResearchView(researchId: string, view: ResearchViewId, paneId?: string) {
    flushPaneReaders();
    workspace.updateData(data => {
      if (!data.researches[researchId]) throw new Error('研究不存在。');
      data.scope = { kind: 'research', researchId };
      const session = data.sessions[researchId];
      session.sourcePreview = undefined;
      if (session.active.kind !== 'researchView' || session.active.id !== view) session.history.push(session.active);
      openPaneView(session, { kind: 'researchView', id: view }, { paneId });
      session.researchView = view;
      session.anchor = undefined;
    });
    status({ selection: undefined });
  },
  openSourcePreview(candidate: SourceCandidate, scope: WorkspaceScope, discovery?: SourceDiscovery, paneId?: string) {
    const url = new URL(candidate.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('请使用有效的公开网页链接。');
    flushPaneReaders();
    workspace.updateData(data => {
      const session = data.sessions[scopeKey(scope)];
      if (!session) throw new Error('研究不存在。');
      data.scope = scope;
      const layout = ensurePaneLayout(session);
      const pane = paneGroups(layout.root).find(p => p.id === (paneId ?? layout.focusedPaneId));
      const existing = pane?.tabs.find(t => t.preview?.candidate.url === candidate.url);
      openPaneView(session, existing?.ref ?? { kind: 'sourcePreview', id: uid('preview') }, { paneId, preview: { candidate, discovery } });
    });
    status({ selection: undefined });
  },
  closeSourcePreview(scope = state.data.scope, tabId?: string) {
    const session = state.data.sessions[scopeKey(scope)], layout = session.layout;
    const found = layout && (tabId ? findPaneTab(layout, tabId) : paneGroups(layout.root).map(pane => ({ pane, tab: pane.tabs.find(t => t.id === pane.activeTabId) })).find(item => item.pane.id === layout.focusedPaneId));
    if (found?.tab?.ref.kind === 'sourcePreview') workspace.closePaneTab(found.pane.id, found.tab.id);
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
  removeDocumentFromResearch(researchId: string, documentId: string) {
    flushPaneReaders();
    workspace.updateData(data => {
      const research = data.researches[researchId];
      if (!research || !data.documents[documentId]) throw new Error('研究或资料不存在。');
      const cites = (ids: string[]) => ids.some(id => data.evidence[id]?.documentId === documentId);
      if (research.cardIds.some(id => data.cards[id] && cites(data.cards[id].evidenceIds))
        || Object.values(data.drafts).some(draft => draft.researchId === researchId && cites(draft.evidenceIds))
        || Object.values(data.cardDrafts).some(draft => draft.researchId === researchId && cites(draft.evidenceIds))
        || Object.values(data.placements).some(placement => data.boards[placement.boardId]?.researchId === researchId && placement.resourceRef.kind === 'document' && placement.resourceRef.id === documentId)
        || Object.values(data.requests).some(request => request.researchId === researchId && (request.context.some(item => item.documentId === documentId) || request.history?.some(turn => turn.context.some(item => item.documentId === documentId))))
        || Object.values(data.conversations).some(conversation => conversation.researchId === researchId && (conversation.inlineSource?.documentId === documentId || conversation.sentContext?.some(item => item.documentId === documentId))))
        throw new Error('这份资料仍被本研究的卡片、文稿、白板或对话引用，请先处理相关引用。');
      research.documentIds = research.documentIds.filter(id => id !== documentId);
      if (research.sourceRecords) delete research.sourceRecords[documentId];
      for (const conversation of Object.values(data.conversations)) if (conversation.researchId === researchId) conversation.contextIds = conversation.contextIds.filter(id => data.evidence[id]?.documentId !== documentId);
      closeDocumentViews(data.sessions[researchId], documentId, { kind: 'researchView', id: 'sources' });
    });
    status({ selection: undefined });
  },
  deleteDocument(documentId: string) {
    flushPaneReaders();
    workspace.updateData(data => {
      if (!data.documents[documentId]) throw new Error('资料不存在。');
      if (Object.values(data.researches).some(research => research.documentIds.includes(documentId))
        || Object.values(data.evidence).some(evidence => evidence.documentId === documentId)
        || Object.values(data.placements).some(placement => placement.resourceRef.kind === 'document' && placement.resourceRef.id === documentId)
        || Object.values(data.boardChanges ?? {}).some(change => [change.before, change.after].some(snapshot => snapshot?.placements.some(p => p.resourceRef.kind === 'document' && p.resourceRef.id === documentId)) || change.createdCards?.some(card => card.provenance?.context.some(source => source.documentId === documentId)))
        || Object.values(data.requests).some(request => request.context.some(item => item.documentId === documentId) || request.history?.some(turn => turn.context.some(item => item.documentId === documentId)))
        || Object.values(data.conversations).some(conversation => conversation.inlineSource?.documentId === documentId || conversation.sentContext?.some(item => item.documentId === documentId)))
        throw new Error('这份资料仍被研究、摘录或对话引用，无法删除。请先移出研究并处理相关引用。');
      for (const [key, session] of Object.entries(data.sessions)) closeDocumentViews(session, documentId, key === 'library' ? { kind: 'collection', id: 'documents' } : { kind: 'researchView', id: 'sources' });
      // shortcut: cached PDF assets stay for recovery snapshots; reclaim them when recovery retention is defined.
      delete data.documents[documentId];
    });
    status({ selection: undefined });
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
        if (session.mainSplit) move(session.mainSplit.ref);
        if (session.layout) for (const pane of paneGroups(session.layout.root)) for (const tab of pane.tabs) move(tab.ref);
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
    }, { boardChange: { summary: '合并重复资料', documentMerge: { fromId: stubId, intoId } } });
    status({ selection: undefined });
  },
  captureExcerpt(researchId: string, range: { documentId: string; pageIndex: number; quote: string; textAnchor?: import('../domain/types').TextSourceAnchor }) {
    if (range.textAnchor) validateTextAnchor(range.textAnchor);
    const existing = Object.values(state.data.evidence).find(e => e.kind !== 'region' && e.researchId === researchId && e.documentId === range.documentId && e.pageIndex === range.pageIndex && e.quote === range.quote.trim() && (range.textAnchor ? e.textAnchor?.start === range.textAnchor.start && e.textAnchor?.end === range.textAnchor.end : !e.textAnchor));
    if (existing) {
      if (existing.contextOnly || existing.annotationHidden) workspace.updateData(data => { delete data.evidence[existing.id].contextOnly; delete data.evidence[existing.id].annotationHidden; });
      return existing.id;
    }
    const id = uid('evidence');
    workspace.updateData(data => {
      if (!data.researches[researchId]?.documentIds.includes(range.documentId)) throw new Error('请先把资料加入该研究。');
      data.evidence[id] = { id, ...range, quote: range.quote.trim(), researchId, createdAt: new Date().toISOString() };
      validateEvidence(data, [id]);
    });
    return id;
  },
  captureReaderSelection(researchId: string, fragments: EvidenceFragment[], options: { contextOnly?: boolean } = {}): string[] {
    if (!Array.isArray(fragments) || !fragments.length || fragments.length > 2000) throw new Error('请选择有效的原文或区域。');
    const ordered = [...fragments].sort((a, b) => a.pageIndex - b.pageIndex);
    if (new Set(ordered.map(item => item.pageIndex)).size !== ordered.length || ordered.some(item => item.documentId !== ordered[0].documentId
      || (item.kind ?? 'text') !== (ordered[0].kind ?? 'text') || typeof item.quote !== 'string')) throw new Error('一次选区只能包含同一论文中各页的文字或区域。');
    for (const item of ordered) if (item.textAnchor) validateTextAnchor(item.textAnchor);
    const existing = findEvidenceSelection(state.data, researchId, ordered);
    const ids = existing?.map(item => item.id) ?? ordered.map(() => uid('evidence'));
    const selectionGroupId = ordered.length > 1 ? uid('selection') : undefined;
    workspace.updateData(data => {
      const research = data.researches[researchId];
      if (!research || !hasFullText(data.documents[ordered[0].documentId])) throw new Error('研究或原 PDF 已不存在。');
      if (!research.documentIds.includes(ordered[0].documentId)) research.documentIds.push(ordered[0].documentId);
      ordered.forEach((item, index) => {
        if (!existing) data.evidence[ids[index]] = { ...structuredClone(item), id: ids[index], researchId, quote: item.quote.trim(), createdAt: new Date().toISOString(),
          ...(selectionGroupId ? { selectionGroupId } : {}), ...(options.contextOnly ? { contextOnly: true } : {}) };
        if (!options.contextOnly) { delete data.evidence[ids[index]].contextOnly; delete data.evidence[ids[index]].annotationHidden; }
      });
      validateEvidence(data, ids);
    });
    return ids;
  },
  setExcerptMarked(evidenceId: string, marked: boolean) {
    workspace.updateData(data => {
      const evidence = data.evidence[evidenceId];
      if (!evidence) throw new Error('摘录不存在，请重新打开原文。');
      for (const fragment of evidenceGroup(data, evidence)) {
        if (marked) delete fragment.annotationHidden;
        else { fragment.annotationHidden = true; clearEvidenceAnchors(data, fragment.id); }
      }
    });
  },
  removeExcerpt(evidenceId: string) {
    workspace.updateData(data => {
      const evidence = data.evidence[evidenceId];
      if (!evidence) throw new Error('摘录不存在，请重新打开原文。');
      const ids = evidenceGroup(data, evidence).map(item => item.id);
      if (Object.values(data.cards).some(c => c.evidenceIds.some(id => ids.includes(id))) || Object.values(data.drafts).some(d => d.evidenceIds.some(id => ids.includes(id)) || d.cardRefs?.some(ref => ref.evidenceIds?.some(id => ids.includes(id)))) || Object.values(data.conversations).some(c => c.contextIds.some(id => ids.includes(id)) || ids.includes(c.inlineSource?.evidenceId ?? '') || c.inlineSource?.evidenceIds?.some(id => ids.includes(id))) || Object.values(data.requests).some(r => r.context.some(c => ids.includes(c.evidenceId))) || Object.values(data.cardDrafts).some(d => d.evidenceIds.some(id => ids.includes(id)))) throw new Error('摘录已被引用，请先移除引用。');
      for (const id of ids) { clearEvidenceAnchors(data, id); delete data.evidence[id]; }
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
  openCollection(collection: CollectionId, paneId?: string) {
    flushPaneReaders();
    workspace.updateData((data) => {
      const session = data.sessions.library;
      if (data.scope.kind === 'research') session.libraryResearchId = data.scope.researchId;
      data.scope = { kind: 'library' };
      session.sourcePreview = undefined;
      session.history.push(session.active);
      openPaneView(session, { kind: 'collection', id: collection }, { paneId });
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
      paneId?: string;
      split?: PaneSide;
      viewId?: string;
      reading?: ReadingPosition;
    },
  ) {
    if (options.target !== 'inspector') flushPaneReaders();
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
      const previousScope = data.scope;
      data.scope = options.scope;
      const session = data.sessions[scopeKey(options.scope)];
      if (options.scope.kind === 'library' && previousScope.kind === 'research') session.libraryResearchId = previousScope.researchId;
      if (options.target === 'main') {
        session.sourcePreview = undefined;
        session.documentInfoId = undefined;
        if (JSON.stringify(session.active) !== JSON.stringify(ref))
          session.history.push(session.active);
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
      if (options.reading && (ref.kind !== 'document' || !hasFullText(data.documents[ref.id]) || !Number.isInteger(options.reading.pageIndex) || options.reading.pageIndex < 0 || options.reading.pageIndex >= data.documents[ref.id].pageCount! || !Number.isFinite(options.reading.scale) || options.reading.scale < .5 || options.reading.scale > 2 || options.reading.offset !== undefined && (!Number.isFinite(options.reading.offset) || options.reading.offset < 0 || options.reading.offset > 1))) throw new Error('阅读位置无效，请重新打开来源。');
      if (options.target === 'main') openPaneView(session, ref, options);
    });
    if (options.target === 'main') status({ selection: undefined });
  },
  back(target: 'main' | 'inspector') {
    if (target === 'main') flushPaneReaders();
    workspace.updateData((data) => {
      const session = data.sessions[scopeKey(data.scope)];
      if (target === 'main') {
        const layout = ensurePaneLayout(session), pane = paneGroups(layout.root).find(p => p.id === layout.focusedPaneId)!;
        const previous = pane.history?.pop();
        const tab = pane.tabs.find(t => t.id === previous);
        if (tab) activateTab(session, pane, tab, false);
      } else {
        session.panel.ref = session.panel.history.pop();
        session.panel.anchor = undefined;
      }
    });
  },
  closeResource(ref: ResourceRef) {
    flushPaneReaders();
    workspace.updateData((data) => {
      const session = data.sessions[scopeKey(data.scope)];
      session.openItems = session.openItems.filter(
        (item) => !sameRef(item, ref),
      );
      session.pinnedIds = session.pinnedIds.filter((id) => id !== ref.id);
      if (session.mainSplit && sameRef(session.mainSplit.ref, ref)) session.mainSplit = undefined;
      if (session.active.kind !== 'collection' && session.active.kind !== 'researchView' && sameRef(session.active, ref))
        session.active =
          session.openItems.at(-1) ??
          (data.scope.kind === 'research'
            ? { kind: 'researchView', id: session.researchView ?? 'home' }
            : { kind: 'collection', id: 'documents' });
      if (session.layout) {
        for (const group of paneGroups(session.layout.root)) group.tabs = group.tabs.filter(tab => !sameRef(tab.ref, ref));
        session.layout.root = collapseEmptyPanes(session.layout.root);
        syncPaneSession(session);
      }
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
    flushPaneReaders();
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
      ensurePaneLayout(data.sessions[id], id);
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
  moveResearchResource(researchId: string, kind: ResearchResourceKind, id: string, targetId: string, position: 'before' | 'after') {
    const ids = researchResourceIds(state.data, researchId, kind);
    if (!['before', 'after'].includes(position) || !ids.includes(id) || !ids.includes(targetId))
      throw new Error('只能调整同一研究内、同一类型资源的顺序。');
    if (id === targetId) return;
    const ordered = ids.filter(item => item !== id);
    ordered.splice(ordered.indexOf(targetId) + (position === 'after' ? 1 : 0), 0, id);
    if (ordered.every((item, index) => item === ids[index])) return;
    workspace.updateData(data => {
      const research = data.researches[researchId];
      if (kind === 'card') research.cardIds = ordered;
      else if (kind === 'board') research.boardOrder = ordered;
      else research.draftOrder = ordered;
    });
  },
  createEvidence(range: {
    documentId: string;
    pageIndex: number;
    quote: string;
    textAnchor?: import('../domain/types').TextSourceAnchor;
  }): string {
    if (range.textAnchor) validateTextAnchor(range.textAnchor);
    const existing = Object.values(state.data.evidence).find(e => e.kind !== 'region' && e.documentId === range.documentId && e.pageIndex === range.pageIndex && e.quote === range.quote.trim() && (range.textAnchor ? e.textAnchor?.start === range.textAnchor.start && e.textAnchor?.end === range.textAnchor.end : !e.textAnchor));
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
  createConversation(researchId: string, options?: { surface: 'workbench' }): string {
    const id = uid('conversation');
    workspace.updateData(data => {
      if (!data.researches[researchId]) throw new Error('研究不存在。');
      const current = getActiveConversation(data, researchId);
      const connectionId = current?.connectionId ?? (options?.surface === 'workbench' ? 'codex' : data.sessions[researchId].panel.aiMode === 'demo' ? 'demo' : 'model');
      data.conversations[id] = { id, researchId, connectionId, title: '新的阅读对话', contextIds: [], requestIds: [], input: '', historyRange: 'all', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      data.sessions[researchId].activeConversationId = id;
      data.sessions[researchId].panel.aiView = options?.surface === 'workbench' ? 'history' : 'chat';
    });
    return id;
  },
  selectConversation(researchId: string, conversationId: string, options?: { surface: 'workbench' }) {
    workspace.updateData(data => {
      const conversation = data.conversations[conversationId];
      if (!conversation || conversation.researchId !== researchId) throw new Error('会话不属于该研究。');
      if (conversation.deletedAt) throw new Error('此会话已删除，请先从“已删除会话”恢复。');
      const last = conversation.requestIds.map(id => data.requests[id]).filter(Boolean).at(-1);
      conversation.connectionId ??= last?.connectionId ?? (last?.mode === 'demo' ? 'demo' : options?.surface === 'workbench' && !last ? 'codex' : 'model');
      data.sessions[researchId].activeConversationId = conversationId;
      const anchor = conversation.anchor && !conversation.promoted ? conversation.anchor
        : conversation.inlineSource && !conversation.inlineSource.promoted ? { kind: 'document', id: conversation.inlineSource.documentId } : undefined;
      if (anchor) (data.sessions[researchId].discussionGroups ??= {})[anchor.kind === 'card' ? 'card' : `${anchor.kind}:${anchor.id}`] = true;
      data.sessions[researchId].panel.aiView = options?.surface === 'workbench' ? 'history' : 'chat';
      data.sessions[researchId].panel.aiMode = conversation.connectionId === 'demo' ? 'demo' : 'live';
    });
  },
  renameConversation(conversationId: string, title: string) {
    if (!title.trim()) throw new Error('会话名称不能为空。');
    const conversation = state.data.conversations[conversationId];
    if (!conversation) throw new Error('会话不存在。');
    if (conversation.deletedAt) throw new Error('此会话已删除，请先恢复后重命名。');
    workspace.updateData(data => { Object.assign(data.conversations[conversationId], { title: title.trim().slice(0, 120), titleEdited: true }); });
  },
  renameBoard(boardId: string, title: string) {
    const name = title.trim(), board = state.data.boards[boardId];
    if (!name) throw new Error('白板名称不能为空。');
    if (name.length > 160) throw new Error('白板名称最多 160 个字符。');
    if (!board || !state.data.researches[board.researchId]) throw new Error('白板或所属研究不存在。');
    workspace.updateData(data => { data.boards[boardId].title = name; });
  },
  archiveConversation(conversationId: string, archived: boolean) {
    const conversation = state.data.conversations[conversationId];
    if (!conversation) throw new Error('会话不存在。');
    if (conversation.deletedAt) throw new Error('此会话已删除，请先从“已删除会话”恢复。');
    workspace.updateData(data => {
      data.conversations[conversationId].archived = archived;
      if (archived && data.sessions[conversation.researchId].activeConversationId === conversationId)
        data.sessions[conversation.researchId].activeConversationId = Object.values(data.conversations).find(c => c.researchId === conversation.researchId && !c.archived && (!c.inlineSource || c.inlineSource.promoted))?.id;
    });
    if (archived && !getActiveConversation(state.data, conversation.researchId)) workspace.createConversation(conversation.researchId);
  },
  deleteConversation(conversationId: string) {
    const conversation = state.data.conversations[conversationId];
    if (!conversation) throw new Error('会话不存在。');
    if (conversation.deletedAt) return;
    if (conversation.nativeState === 'busy' || conversation.requestIds.some(id => {
      const request = state.data.requests[id];
      return request?.status === 'generating' || request?.nativeRun?.managed && !['completed', 'failed', 'interrupted'].includes(request.nativeRun.state);
    }) || Object.values(state.data.cardDrafts).some(draft => draft.conversationId === conversationId && draft.status === 'generating'))
      throw new Error('此会话仍有任务进行中，请先停止并确认结束后再删除。');
    workspace.updateData(data => {
      const current = data.conversations[conversationId];
      current.deletedAt = new Date().toISOString();
      current.archived = true;
      const session = data.sessions[current.researchId];
      if (session.activeConversationId === conversationId) session.activeConversationId = undefined;
      session.activeConversationId ??= getActiveConversation(data, current.researchId)?.id;
    });
    if (!getActiveConversation(state.data, conversation.researchId)) {
      const id = workspace.createConversation(conversation.researchId);
      workspace.updateData(data => { data.conversations[id].connectionId = conversation.connectionId; });
    }
  },
  restoreDeletedConversation(conversationId: string) {
    workspace.updateData(data => {
      const conversation = data.conversations[conversationId];
      if (!conversation) throw new Error('会话不存在。');
      if (!conversation.deletedAt) return;
      delete conversation.deletedAt;
      conversation.archived = false;
    });
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
      const next = {
        pageIndex: Math.max(0, Math.min(doc.pageCount - 1, Math.floor(position.pageIndex))),
        scale: Math.max(0.5, Math.min(2, position.scale)),
        ...(position.offset !== undefined && Number.isFinite(position.offset) ? { offset: Math.max(0, Math.min(1, position.offset)) } : {}),
      };
      if (target.startsWith('view:')) {
        const found = session.layout && findPaneTab(session.layout, target.slice(5));
        if (!found || found.tab.ref.kind !== 'document' || found.tab.ref.id !== documentId) return;
        found.tab.reading = next;
        if (found.pane.id === session.layout!.focusedPaneId && found.tab.id === found.pane.activeTabId) session.readers[`main:${documentId}`] = next;
      } else {
        session.readers[`${target}:${documentId}`] = next;
        if (target === 'main' && session.layout) {
          const group = paneGroups(session.layout.root).find(pane => pane.id === session.layout!.focusedPaneId);
          const tab = group?.tabs.find(tab => tab.id === group.activeTabId && tab.ref.kind === 'document' && tab.ref.id === documentId);
          if (tab) tab.reading = next;
        }
      }
    });
  },
  openInPane(ref: ResourceRef, paneId: string, side: 'center' | PaneSide = 'center') {
    workspace.openResource(ref, { scope: state.data.scope, target: 'main', paneId, ...(side !== 'center' ? { split: side } : {}) });
  },
  closePane(paneId: string) {
    flushPaneReaders();
    const key = scopeKey(state.data.scope), before = structuredClone(ensurePaneLayout(state.data.sessions[key]));
    workspace.updateData(data => {
      const session = data.sessions[key], layout = ensurePaneLayout(session), pane = paneGroups(layout.root).find(p => p.id === paneId);
      if (!pane) return;
      pane.tabs = []; pane.activeTabId = undefined;
      layout.root = collapseEmptyPanes(layout.root); syncPaneSession(session);
    });
    rememberLayoutUndo(key, before);
  },
  canUndoPaneLayout() { return layoutUndo.has(scopeKey(state.data.scope)); },
  undoPaneLayout() {
    flushPaneReaders();
    const key = scopeKey(state.data.scope), before = layoutUndo.get(key);
    if (!before) return;
    workspace.updateData(data => {
      const session = data.sessions[key], current = session.layout;
      const live = new Map(current ? paneGroups(current.root).flatMap(p => p.tabs).map(t => [t.id, t]) : []);
      session.layout = structuredClone(before);
      for (const pane of paneGroups(session.layout.root)) pane.tabs = pane.tabs.map(t => live.get(t.id) ?? t);
      syncPaneSession(session);
    });
  },
  setViewState(patch: NonNullable<WorkspaceTab['viewState']>, tabId?: string, scope = state.data.scope) {
    if (!tabId || restoring || !state.loaded || state.loadError) return;
    const current = state.data.sessions[scopeKey(scope)]?.layout;
    const tab = current && findPaneTab(current, tabId)?.tab;
    if (!tab || Object.entries(patch).every(([key, value]) => tab.viewState?.[key] === value)) return;
    workspace.updateData(data => { const layout = data.sessions[scopeKey(scope)]?.layout, tab = layout && findPaneTab(layout, tabId)?.tab; if (tab) tab.viewState = { ...tab.viewState, ...patch }; });
  },
  getBoardViewport(boardId: string, tabId?: string, scope = state.data.scope): BoardViewport {
    const session = state.data.sessions[scopeKey(scope)], tab = tabId && session.layout && findPaneTab(session.layout, tabId)?.tab;
    return tab && tab.ref.kind === 'board' && tab.ref.id === boardId ? tab.boardViewport ?? session.viewports[boardId] ?? { x: 0, y: 0, scale: 1 } : session.viewports[boardId] ?? { x: 0, y: 0, scale: 1 };
  },
  setBoardViewport(boardId: string, position: BoardViewport, tabId?: string, scope = state.data.scope) {
    if (restoring || !state.loaded || state.loadError) return;
    workspace.updateData(data => {
      const session = data.sessions[scopeKey(scope)]; if (!session || !data.boards[boardId] || ![position.x,position.y,position.scale].every(Number.isFinite)) return;
      if (tabId) { const tab = session.layout && findPaneTab(session.layout, tabId)?.tab; if (tab?.ref.kind === 'board' && tab.ref.id === boardId) tab.boardViewport = position; }
      else session.viewports[boardId] = position;
    });
  },
  activatePane(paneId: string, tabId?: string) {
    flushPaneReaders();
    workspace.updateData(data => {
      const session = data.sessions[scopeKey(data.scope)], layout = ensurePaneLayout(session);
      const pane = paneGroups(layout.root).find(pane => pane.id === paneId);
      if (!pane || tabId && !pane.tabs.some(tab => tab.id === tabId)) return;
      const next = pane.tabs.find(tab => tab.id === (tabId ?? pane.activeTabId));
      if (next) activateTab(session, pane, next);
      layout.focusedPaneId = paneId;
      if (layout.zoomedPaneId) layout.zoomedPaneId = paneId;
      syncPaneSession(session);
    });
  },
  splitPane(paneId: string, direction: PaneSide, tabId?: string) {
    flushPaneReaders();
    workspace.updateData(data => {
      const session = data.sessions[scopeKey(data.scope)], layout = ensurePaneLayout(session);
      const pane = paneGroups(layout.root).find(pane => pane.id === paneId);
      const source = pane?.tabs.find(tab => tab.id === (tabId ?? pane.activeTabId));
      if (!pane) return;
      splitLayout(session, paneId, direction, source ? { ...structuredClone(source), id: uid('view') } : undefined);
      syncPaneSession(session);
    });
  },
  movePaneTab(tabId: string, paneId: string, side: 'center' | PaneSide = 'center', copy = false, index?: number) {
    flushPaneReaders();
    workspace.updateData(data => {
      const session = data.sessions[scopeKey(data.scope)], layout = ensurePaneLayout(session);
      const source = findPaneTab(layout, tabId), destination = paneGroups(layout.root).find(pane => pane.id === paneId);
      if (!source || !destination || !['center', 'left', 'right', 'up', 'down'].includes(side)) return;
      const copying = copy || source.pane === destination && side !== 'center';
      if (!copying && source.pane === destination && side === 'center' && index === undefined) return;
      const oldIndex = source.pane.tabs.indexOf(source.tab);
      const tab = copying ? { ...structuredClone(source.tab), id: uid('view') } : source.tab;
      if (!copying) { source.pane.tabs.splice(oldIndex, 1); if (source.pane.activeTabId === tabId) source.pane.activeTabId = source.pane.tabs[Math.min(oldIndex, source.pane.tabs.length - 1)]?.id; }
      if (side === 'center') {
        const raw = Number.isInteger(index) ? index! : destination.tabs.length;
        const at = source.pane === destination && !copying && index !== undefined && oldIndex < raw ? raw - 1 : raw;
        destination.tabs.splice(Math.max(0, Math.min(destination.tabs.length, at)), 0, tab);
        destination.activeTabId = tab.id; layout.focusedPaneId = destination.id;
        if (layout.zoomedPaneId) layout.zoomedPaneId = destination.id;
      } else splitLayout(session, paneId, side, tab);
      layout.root = collapseEmptyPanes(layout.root);
      syncPaneSession(session);
    });
  },
  closePaneTab(paneId: string, tabId: string) {
    flushPaneReaders();
    const key = scopeKey(state.data.scope), before = structuredClone(ensurePaneLayout(state.data.sessions[key]));
    workspace.updateData(data => {
      const session = data.sessions[scopeKey(data.scope)], layout = ensurePaneLayout(session);
      const pane = paneGroups(layout.root).find(pane => pane.id === paneId);
      if (!pane) return;
      const index = pane.tabs.findIndex(tab => tab.id === tabId);
      if (index < 0) return;
      pane.tabs.splice(index, 1);
      if (pane.activeTabId === tabId) pane.activeTabId = pane.recentTabIds?.find(id => pane.tabs.some(t => t.id === id)) ?? pane.tabs[Math.min(index, pane.tabs.length - 1)]?.id;
      layout.root = collapseEmptyPanes(layout.root); syncPaneSession(session);
      if (!paneGroups(layout.root).some(p => p.tabs.length)) session.active = data.scope.kind === 'research' ? { kind: 'researchView', id: session.researchView ?? 'home' } : { kind: 'collection', id: 'documents' };
    });
    rememberLayoutUndo(key, before);
  },
  mergePanes(paneId: string) {
    flushPaneReaders();
    const key = scopeKey(state.data.scope), before = structuredClone(ensurePaneLayout(state.data.sessions[key]));
    workspace.updateData(data => {
      const session = data.sessions[scopeKey(data.scope)], layout = ensurePaneLayout(session);
      const groups = paneGroups(layout.root), pane = groups.find(pane => pane.id === paneId);
      if (!pane) return;
      pane.tabs.push(...groups.filter(group => group !== pane).flatMap(group => group.tabs));
      layout.root = pane; layout.focusedPaneId = pane.id; delete layout.zoomedPaneId; syncPaneSession(session);
    });
    rememberLayoutUndo(key, before);
  },
  togglePaneZoom(paneId: string) {
    flushPaneReaders();
    workspace.updateData(data => {
      const session = data.sessions[scopeKey(data.scope)], layout = ensurePaneLayout(session);
      if (!paneGroups(layout.root).some(pane => pane.id === paneId)) return;
      layout.focusedPaneId = paneId;
      if (layout.zoomedPaneId === paneId) delete layout.zoomedPaneId; else layout.zoomedPaneId = paneId;
      syncPaneSession(session);
    });
  },
  resizePane(splitId: string, ratio: number) {
    if (!Number.isFinite(ratio)) return;
    flushPaneReaders();
    workspace.updateData(data => {
      const layout = ensurePaneLayout(data.sessions[scopeKey(data.scope)]);
      const resize = (node: PaneNode) => { if (node.kind !== 'split') return; if (node.id === splitId) node.ratio = Math.max(0.1, Math.min(0.9, ratio)); else { resize(node.first); resize(node.second); } };
      resize(layout.root);
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
      if (board.layout === 'tree') {
        const items = Object.values(data.placements).filter(p => p.boardId === boardId);
        placement.order = Math.max(-1, ...items.filter(p => !p.parentPlacementId).map(p => p.order ?? 0)) + 1;
        layoutBoardTree(items).forEach(p => { data.placements[p.id] = p; });
        placement = data.placements[id];
      }
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
      if (conversation.boardResearch) conversation.boardResearch.excludedSourceIds = conversation.boardResearch.excludedSourceIds.filter(id => !input.evidenceIds.some(evidenceId => id === `evidence:${evidenceId}`));
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
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getState);
  const pane = useContext(PaneContext);
  const generation = workspace.getGeneration();
  const actions = useMemo(() => pane ? {
    ...workspace,
    openResource: (ref: ResourceRef, options: Parameters<typeof workspace.openResource>[1]) => generation === workspace.getGeneration() && workspace.openResource(ref, { ...options, paneId: options.paneId ?? (scopeKey(options.scope) === scopeKey(pane.scope) ? pane.paneId : undefined) }),
    openResearchView: (researchId: string, view: ResearchViewId) => generation === workspace.getGeneration() && workspace.openResearchView(researchId, view, scopeKey(pane.scope) === researchId ? pane.paneId : undefined),
    openCollection: (collection: CollectionId) => generation === workspace.getGeneration() && workspace.openCollection(collection, pane.scope.kind === 'library' ? pane.paneId : undefined),
    openSourcePreview: (candidate: SourceCandidate, scope: WorkspaceScope, discovery?: SourceDiscovery) => generation === workspace.getGeneration() && workspace.openSourcePreview(candidate, scope, discovery, scopeKey(scope) === scopeKey(pane.scope) ? pane.paneId : undefined),
    closeSourcePreview: (scope = pane.scope) => generation === workspace.getGeneration() && workspace.closeSourcePreview(scope, pane.tabId),
    setViewState: (patch: NonNullable<WorkspaceTab['viewState']>) => { if (generation === workspace.getGeneration()) workspace.setViewState(patch, pane.tabId, pane.scope); },
    getBoardViewport: (id: string) => workspace.getBoardViewport(id, pane.tabId, pane.scope),
    setBoardViewport: (id: string, position: BoardViewport) => { if (generation === workspace.getGeneration()) workspace.setBoardViewport(id, position, pane.tabId, pane.scope); },
  } : workspace, [pane?.paneId, pane?.tabId, pane && scopeKey(pane.scope), generation]);
  const ownSession = snapshot.data.sessions[scopeKey(pane?.scope ?? snapshot.data.scope)];
  return {
    ...snapshot,
    session: ownSession,
    research: snapshot.data.scope.kind === 'research' ? snapshot.data.researches[snapshot.data.scope.researchId] : undefined,
    pane,
    view: pane && ownSession.layout ? findPaneTab(ownSession.layout, pane.tabId)?.tab : undefined,
    actions,
  };
}
export function usePaneViewState<T extends string | number | boolean>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const { pane, view, actions } = useWorkspace();
  const [local, setLocal] = useState(initial);
  const value = (view?.viewState?.[key] ?? initial) as T;
  return pane ? [value, next => actions.setViewState({ [key]: typeof next === 'function' ? next(value) : next })] : [local, setLocal];
}
