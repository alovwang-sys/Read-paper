import { useSyncExternalStore } from 'react';
import { createSeed, emptySession } from '../data/seed';
import { loadWorkspace, saveWorkspace } from '../data/storage';
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
      !evidence.quote.trim() ||
      !Number.isInteger(evidence.pageIndex) ||
      evidence.pageIndex < 0 ||
      evidence.pageIndex >= doc.pageCount
    )
      throw new Error('引用的原文或页码缺失，请修复来源后重试。');
    return evidence;
  });
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
  timer: ReturnType<typeof setTimeout> | undefined,
  saving = false;
const JOURNAL = 'papertrail-recovery-v1';
function emit() {
  listeners.forEach((listener) => listener());
}
function status(patch: Partial<WorkspaceState>) {
  state = { ...state, ...patch };
  emit();
}
function parseSaved(value: unknown): WorkspaceData {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as WorkspaceData).schemaVersion !== 1
  )
    throw new Error('存储版本不受支持，未覆盖现有数据。');
  const data = value as WorkspaceData;
  for (const key of [
    'researches',
    'documents',
    'evidence',
    'cards',
    'boards',
    'placements',
    'edges',
    'drafts',
    'conversations',
    'requests',
    'sessions',
  ] as const) {
    if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key]))
      throw new Error('本地数据格式不完整，未覆盖现有数据。');
  }
  if (!data.scope || !data.sessions[scopeKey(data.scope)])
    throw new Error('工作区会话缺失。');
  return data;
}
async function persist() {
  if (saving || !state.loaded || state.loadError) return;
  saving = true;
  const currentRevision = revision,
    snapshot = state.data;
  status({ saveStatus: 'saving', saveError: undefined });
  try {
    await saveWorkspace(snapshot);
    if (revision === currentRevision) {
      localStorage.removeItem(JOURNAL);
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
      const saved = journal ? JSON.parse(journal) : await loadWorkspace();
      const data = saved ? parseSaved(saved) : createSeed();
      for (const request of Object.values(data.requests))
        if (request.status === 'generating') {
          request.status = 'error';
          request.error = '页面已重新加载，请重试请求。';
        }
      status({
        data,
        loaded: true,
        loadError: undefined,
        saveError: undefined,
        saveStatus: journal ? 'dirty' : 'saved',
      });
      if (journal || !saved) void persist();
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
    revision++;
    let journalError: string | undefined;
    try {
      localStorage.setItem(JOURNAL, JSON.stringify(data));
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
        if (previous) session.active = previous;
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
    const id = uid('evidence');
    workspace.updateData((data) => {
      data.evidence[id] = { id, ...range, quote: range.quote.trim() };
      validateEvidence(data, [id]);
    });
    return id;
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
      conversationId: `conversation-${scope.researchId}`,
      evidenceIds: [evidence.id],
    });
    workspace.setPanel('ai');
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
