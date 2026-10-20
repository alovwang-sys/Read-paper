import type { BoardChange, BoardContext, BoardPlacement, BoardPlan, BoardSnapshot, Card, WorkspaceData } from './types';
import { remapCitationNumbers } from './citations';
import { promoteRemovedPlacements, validateBoardStructure } from './board-structure';
import { layoutBoardTree } from './board-layout';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const own = (map: object, id: string) => Object.hasOwn(map, id);
function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const safeId = (value: unknown): value is string => text(value, 200) && !!value && !['__proto__', 'prototype', 'constructor'].includes(value);

export function boardSnapshot(data: WorkspaceData, boardId: string): BoardSnapshot | null {
  if (!own(data.boards, boardId)) return null;
  return structuredClone({ board: data.boards[boardId],
    placements: Object.values(data.placements).filter(p => p.boardId === boardId).sort((a, b) => a.id.localeCompare(b.id)),
    edges: Object.values(data.edges).filter(e => e.boardId === boardId).sort((a, b) => a.id.localeCompare(b.id)) });
}
export function sameBoard(a: BoardSnapshot | null, b: BoardSnapshot | null) { return same(a, b); }
export type BoardChangeInfo = { actor?: string; summary?: string; requestId?: string; restores?: string; documentMerge?: { fromId: string; intoId: string } };

/** Keep knowledge and its recovery record in the same workspace write, including manual edits. */
export function recordBoardChanges(before: WorkspaceData, next: WorkspaceData, info: BoardChangeInfo = {}) {
  if (!info.documentMerge && same(before.boards, next.boards) && same(before.placements, next.placements) && same(before.edges, next.edges)) return;
  for (const id of new Set([...Object.keys(before.boards), ...Object.keys(next.boards)])) {
    const previous = boardSnapshot(before, id), current = boardSnapshot(next, id);
    if (info.documentMerge) for (const placement of previous?.placements ?? []) {
      if (placement.resourceRef.kind === 'document' && placement.resourceRef.id === info.documentMerge.fromId)
        placement.resourceRef.id = info.documentMerge.intoId;
    }
    if (sameBoard(previous, current)) continue;
    if (current) validateBoardSnapshot(current, id, current.board.researchId);
    const revision = (before.boardRevisions?.[id] ?? 0) + 1;
    const change: BoardChange = { id: `board-change-${crypto.randomUUID()}`, boardId: id,
      researchId: (current ?? previous)!.board.researchId, actor: info.actor ?? 'user',
      summary: info.summary ?? (!previous ? '创建白板' : !current ? '删除白板' : '手动修改白板'),
      createdAt: new Date().toISOString(), before: previous, after: current, revision,
      ...(info.requestId ? { requestId: info.requestId } : {}), ...(info.restores ? { restores: info.restores } : {}) };
    const createdCards = [...new Set(current?.placements.filter(p => p.resourceRef.kind === 'card').map(p => p.resourceRef.id) ?? [])]
      .filter(cardId => !own(before.cards, cardId) && own(next.cards, cardId) && next.cards[cardId].provenance?.researchId === change.researchId).map(cardId => structuredClone(next.cards[cardId]));
    if (createdCards.length) change.createdCards = createdCards;
    (next.boardRevisions ??= {})[id] = revision;
    (next.boardChanges ??= {})[change.id] = change;
  }
  // A validated metadata-only merge keeps every recoverable layout pointing to the surviving source.
  if (info.documentMerge) for (const change of Object.values(next.boardChanges ?? {})) {
    for (const snapshot of [change.before, change.after]) for (const placement of snapshot?.placements ?? []) {
      if (placement.resourceRef.kind === 'document' && placement.resourceRef.id === info.documentMerge.fromId)
        placement.resourceRef.id = info.documentMerge.intoId;
    }
  }
}

export function captureBoardContext(data: WorkspaceData, researchId: string, boardId: string, scope: 'board' | 'research', options: { allowNewCards?: boolean; evidenceIds?: string[] } = {}): BoardContext {
  const snapshot = boardSnapshot(data, boardId), research = data.researches[researchId];
  requireValue(research && snapshot && snapshot.board.researchId === researchId, '白板不属于本次研究。');
  requireValue(scope === 'board' || scope === 'research', '请选择白板材料范围。');
  const refs = scope === 'board' ? snapshot.placements.map(p => p.resourceRef) : [
    ...research.cardIds.map(id => ({ kind: 'card' as const, id })),
    ...research.documentIds.map(id => ({ kind: 'document' as const, id })),
  ];
  const unique = [...new Map(refs.map(ref => [`${ref.kind}:${ref.id}`, ref])).values()];
  requireValue(unique.length > 0 || options.allowNewCards, '所选范围没有资料，请先添加卡片或论文。');
  requireValue(unique.length <= 80 && snapshot.placements.length <= 80 && snapshot.edges.length <= 160, '白板材料过多，请缩小到 80 项资料、160 条连线以内。');
  const resources: BoardContext['resources'] = unique.map(ref => {
    requireValue((ref.kind === 'card' && research.cardIds.includes(ref.id) && own(data.cards, ref.id)) ||
      (ref.kind === 'document' && research.documentIds.includes(ref.id) && own(data.documents, ref.id)), '白板资料缺失或不属于当前研究。');
    if (ref.kind === 'card') {
      const card = data.cards[ref.id];
      return { ref: { kind: 'card', id: ref.id }, title: card.title, body: card.body, evidenceIds: [...card.evidenceIds] };
    }
    return { ref: { kind: 'document', id: ref.id }, title: data.documents[ref.id].title, evidenceIds: [] };
  });
  const evidenceIds = options.evidenceIds ?? [];
  requireValue(evidenceIds.every(id => own(data.evidence, id) && research.documentIds.includes(data.evidence[id].documentId)), '白板新卡片材料不属于本次研究。');
  const result: BoardContext = { researchId, boardId, revision: data.boardRevisions?.[boardId] ?? 0, snapshot, resources,
    ...(options.allowNewCards ? { allowNewCards: true, allowedEvidenceIds: [...evidenceIds] } : {}) };
  requireValue(JSON.stringify(result).length <= 60000, '白板材料超过 60,000 字，请缩小范围后重试。');
  validateBoardContext(result, researchId);
  return result;
}

export function parseBoardPlan(raw: string, context: BoardContext): BoardPlan {
  validateBoardContext(context, context.researchId);
  requireValue(raw.length <= 100000, '白板方案过大，请缩小范围重试。');
  let value: unknown;
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('助手未返回有效的白板方案，请重试；当前白板未改变。'); }
  requireValue(object(value) && text(value.summary, 2000) && !!value.summary.trim() && text(value.title, 200) && !!value.title.trim(), '白板方案标题或说明无效。');
  requireValue(['preserve', 'groups', 'flow', 'tree'].includes(String(value.layout)), '白板布局规则无效。');
  requireValue(Array.isArray(value.nodes) && value.nodes.length <= 80 && Array.isArray(value.edges) && value.edges.length <= 160, '白板节点或连线数量无效。');
  const ids = new Set<string>();
  const nodes: BoardPlan['nodes'] = value.nodes.map((node, index) => {
    requireValue(object(node) && text(node.group, 100), '白板节点格式无效。');
    requireValue(node.parent === undefined || node.parent === null || typeof node.parent === 'number' && Number.isInteger(node.parent) && node.parent >= 0 && node.parent < (value.nodes as unknown[]).length && node.parent !== index, '白板父节点索引无效。');
    requireValue(node.order === undefined || typeof node.order === 'number' && Number.isSafeInteger(node.order) && node.order >= 0, '白板分支顺序无效。');
    const structure = { ...(node.parent !== undefined ? { parent: node.parent as number | null } : {}), ...(node.order !== undefined ? { order: node.order as number } : {}) };
    if (node.card !== undefined) {
      const card = node.card;
      requireValue((context.intent === 'create' || context.allowNewCards === true) && node.resourceRef === undefined && node.placementId === undefined && object(card) && text(card.title, 200) && card.title.trim() && text(card.body, 10000) && card.body.trim() && Array.isArray(card.evidenceIds) && card.evidenceIds.length <= 16 && card.evidenceIds.every(id => safeId(id) && context.allowedEvidenceIds?.includes(id)) && new Set(card.evidenceIds).size === card.evidenceIds.length, '新卡片或引用超出本次白板创建范围。');
      remapCitationNumbers(card.body, card.evidenceIds, card.evidenceIds);
      return { card: { title: card.title.trim(), body: card.body.trim(), evidenceIds: [...card.evidenceIds] }, group: node.group.trim(), ...structure };
    }
    requireValue(object(node.resourceRef), '白板节点缺少资料或卡片草稿。');
    const requestedRef = node.resourceRef;
    const ref = context.resources.find(r => r.ref.kind === requestedRef.kind && r.ref.id === requestedRef.id)?.ref;
    requireValue(ref, '白板方案包含本次范围以外的资料。');
    const existing = node.placementId === undefined ? undefined : context.snapshot.placements.find(p => p.id === node.placementId);
    if (node.placementId !== undefined) {
      requireValue(typeof node.placementId === 'string' && existing && !ids.has(node.placementId) && same(existing.resourceRef, ref), '白板摆放标识重复、越界或来源已改变。');
      ids.add(node.placementId);
    }
    return { ...(existing ? { placementId: existing.id } : {}), resourceRef: { ...ref }, group: node.group.trim(), ...structure };
  });
  requireValue(context.intent !== 'create' || nodes.length > 0, '白板方案为空，请补充要画出的内容。');
  const edgeKeys = new Set<string>();
  const edges = value.edges.map(edge => {
    requireValue(object(edge), '白板连线格式无效。');
    const label = edge.label ?? '';
    requireValue(Number.isInteger(edge.from) && Number.isInteger(edge.to) && typeof edge.from === 'number' && typeof edge.to === 'number' && edge.from >= 0 && edge.from < nodes.length && edge.to >= 0 && edge.to < nodes.length && edge.from !== edge.to && text(label, 200), '白板连线端点或说明无效。');
    const key = `${edge.from}:${edge.to}:${label.trim()}`;
    requireValue(!edgeKeys.has(key), '白板方案包含重复连线。'); edgeKeys.add(key);
    return { from: edge.from, to: edge.to, label: label.trim() };
  });
  const plan = { summary: value.summary.trim(), title: value.title.trim(), layout: value.layout as BoardPlan['layout'], nodes, edges };
  validateBoardStructure(planStructure(context, plan));
  return plan;
}

function planStructure(context: BoardContext, plan: BoardPlan): BoardPlacement[] {
  const retained = new Map(plan.nodes.flatMap((node, index) => node.placementId ? [[node.placementId, index] as const] : []));
  const previous = context.snapshot.placements;
  const removed = new Set(previous.filter(p => !retained.has(p.id)).map(p => p.id));
  const defaults = removed.size && previous.some(p => p.parentPlacementId !== undefined || p.order !== undefined)
    ? promoteRemovedPlacements(previous, removed) : previous;
  return plan.nodes.map((node, index) => {
    const old = defaults.find(p => p.id === node.placementId);
    const parentId = old?.parentPlacementId;
    const parent = node.parent === undefined ? parentId === undefined ? undefined : retained.get(parentId) : node.parent ?? undefined;
    const order = node.order ?? (plan.layout === 'tree' ? index : old?.order);
    return { id: String(index), boardId: context.boardId, resourceRef: old?.resourceRef ?? { kind: 'card', id: String(index) }, x: 0, y: 0, group: node.group,
      ...(parent === undefined ? {} : { parentPlacementId: String(parent) }), ...(order === undefined ? {} : { order }) };
  });
}

export function previewBoardPlan(context: BoardContext, input: BoardPlan): BoardSnapshot {
  const plan = parseBoardPlan(JSON.stringify(input), context);
  const groups = [...new Set(plan.nodes.map(n => n.group))], rows = new Map<number, number>();
  const levels = plan.nodes.map(() => 0), indegree = plan.nodes.map(() => 0);
  plan.edges.forEach(e => indegree[e.to]++);
  const queue = indegree.flatMap((n, i) => n === 0 ? [i] : []);
  for (let i = 0; i < queue.length; i++) for (const edge of plan.edges.filter(e => e.from === queue[i])) {
    levels[edge.to] = Math.max(levels[edge.to], levels[edge.from] + 1);
    if (--indegree[edge.to] === 0) queue.push(edge.to);
  }
  // Cyclic relations share a final column; they stay visible without forcing a false hierarchy.
  const last = Math.max(0, ...levels) + 1;
  indegree.forEach((n, i) => { if (n > 0) levels[i] = last; });
  let newIndex = 0;
  const bottom = Math.max(0, ...context.snapshot.placements.map(p => p.y + 280));
  const reserved = new Set([...context.snapshot.placements, ...context.snapshot.edges, ...context.resources.map(r => r.ref)].map(item => item.id));
  const temporaryId = (prefix: string, index: number) => {
    let id = `${prefix}-${index}`;
    while (reserved.has(id)) id += '-new';
    reserved.add(id); return id;
  };
  let placements: BoardPlacement[] = plan.nodes.map((node, i) => {
    const old = context.snapshot.placements.find(p => p.id === node.placementId);
    const column = plan.layout === 'flow' ? levels[i] : groups.indexOf(node.group);
    const row = rows.get(column) ?? 0; rows.set(column, row + 1);
    const position = plan.layout === 'preserve' ? old ?? { x: 50 + (newIndex % 3) * 340, y: bottom + Math.floor(newIndex++ / 3) * 300 } : { x: 50 + column * 340, y: 80 + row * 300 };
    return { id: old?.id ?? temporaryId('proposal-placement', i), boardId: context.boardId, resourceRef: node.resourceRef ? { ...node.resourceRef } : { kind: 'card' as const, id: temporaryId('proposal-card', i) }, group: node.group, x: position.x, y: position.y };
  });
  const structure = planStructure(context, plan);
  placements.forEach((p, index) => {
    if (structure[index].parentPlacementId !== undefined) p.parentPlacementId = placements[Number(structure[index].parentPlacementId)].id;
    if (structure[index].order !== undefined) p.order = structure[index].order;
  });
  const board = { ...context.snapshot.board, title: plan.title };
  if (plan.layout === 'tree') board.layout = 'tree';
  else if (plan.layout !== 'preserve' && board.layout === 'tree') board.layout = 'free';
  if (board.layout === 'tree') {
    const positioned = new Map(layoutBoardTree(placements).map(p => [p.id, p]));
    placements = placements.map(p => positioned.get(p.id)!);
  }
  const edges = plan.edges.map((edge, i) => {
    const fromPlacementId = placements[edge.from].id, toPlacementId = placements[edge.to].id;
    const old = context.snapshot.edges.find(e => e.fromPlacementId === fromPlacementId && e.toPlacementId === toPlacementId && e.label === edge.label);
    return { id: old?.id ?? temporaryId('proposal-edge', i), boardId: context.boardId, fromPlacementId, toPlacementId, label: edge.label };
  });
  return { board, placements, edges };
}

export function validateBoardSnapshot(value: unknown, boardId: string, researchId: string): asserts value is BoardSnapshot {
  requireValue(safeId(boardId) && safeId(researchId), '白板历史标识无效。');
  requireValue(object(value) && object(value.board) && value.board.id === boardId && value.board.researchId === researchId && text(value.board.title, 10000) && Array.isArray(value.placements) && Array.isArray(value.edges), '白板历史结构损坏，未覆盖现有数据。');
  requireValue([undefined, 'free', 'tree'].includes(value.board.layout as string | undefined), '白板布局类型无效。');
  const ids = new Set<string>();
  for (const p of value.placements) {
    requireValue(object(p) && safeId(p.id) && !ids.has(p.id) && p.boardId === boardId && object(p.resourceRef) && ['card', 'document'].includes(String(p.resourceRef.kind)) && safeId(p.resourceRef.id) && Number.isFinite(p.x) && Number.isFinite(p.y) && typeof p.group === 'string', '白板历史摆放损坏。'); ids.add(p.id);
  }
  validateBoardStructure(value.placements as BoardPlacement[]);
  const edges = new Set<string>();
  for (const e of value.edges) {
    requireValue(object(e) && safeId(e.id) && !edges.has(e.id) && e.boardId === boardId && typeof e.fromPlacementId === 'string' && ids.has(e.fromPlacementId) && typeof e.toPlacementId === 'string' && ids.has(e.toPlacementId) && typeof e.label === 'string', '白板历史连线损坏。'); edges.add(e.id);
  }
}
export function validateBoardHistory(data: WorkspaceData) {
  requireValue(data.boardChanges === undefined || object(data.boardChanges), '白板版本记录损坏。');
  requireValue(data.boardRevisions === undefined || object(data.boardRevisions), '白板版本号损坏。');
  for (const [id, revision] of Object.entries(data.boardRevisions ?? {})) requireValue(safeId(id) && Number.isSafeInteger(revision) && revision >= 0, '白板版本号损坏。');
  for (const [id, change] of Object.entries(data.boardChanges ?? {})) {
    requireValue(safeId(id) && object(change) && change.id === id && safeId(change.boardId) && safeId(change.researchId) && typeof change.actor === 'string' && typeof change.summary === 'string' && typeof change.createdAt === 'string' && Number.isSafeInteger(change.revision) && change.revision > 0 && (change.before !== null || change.after !== null), '白板版本记录损坏。');
    requireValue((change.requestId === undefined || typeof change.requestId === 'string') && (change.restores === undefined || typeof change.restores === 'string') && (data.boardRevisions?.[change.boardId] ?? 0) >= change.revision, '白板版本关联或版本号损坏。');
    for (const snapshot of [change.before, change.after]) if (snapshot !== null) validateBoardSnapshot(snapshot, change.boardId, change.researchId);
    if (change.createdCards !== undefined) {
      requireValue(Array.isArray(change.createdCards) && change.createdCards.length <= 80 && new Set(change.createdCards.map(card => card?.id)).size === change.createdCards.length, '白板新卡片档案损坏。');
      for (const card of change.createdCards) {
        requireValue(object(card) && safeId(card.id) && text(card.title, 200) && text(card.body, 10000) && Array.isArray(card.evidenceIds) && card.evidenceIds.every(safeId) && typeof card.needsReview === 'boolean' && change.after?.placements.some(p => p.resourceRef.kind === 'card' && p.resourceRef.id === card.id), '白板新卡片档案损坏。');
        remapCitationNumbers(card.body, card.evidenceIds, card.evidenceIds);
        const source = card.provenance;
        requireValue(object(source) && source.researchId === change.researchId && safeId(source.conversationId) && safeId(source.requestId) && typeof source.conversationTitle === 'string' && typeof source.prompt === 'string' && typeof source.answer === 'string' && typeof source.selection === 'string' && typeof source.createdAt === 'string' && Array.isArray(source.generationRequestIds) && source.generationRequestIds.every(safeId) && Array.isArray(source.context) && source.context.every(item => object(item) && safeId(item.evidenceId) && safeId(item.documentId) && typeof item.documentHash === 'string' && typeof item.title === 'string' && typeof item.quote === 'string' && Number.isInteger(item.pageIndex) && item.pageIndex >= 0), '白板新卡片出处损坏。');
        requireValue(card.evidenceIds.every(id => source.context.some(item => item.evidenceId === id)), '白板历史卡片引用越界。');
      }
    }
  }
}

export function validateBoardContext(value: unknown, researchId: string): asserts value is BoardContext {
  requireValue(object(value) && value.researchId === researchId && typeof value.boardId === 'string' && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 && [undefined, 'create'].includes(value.intent as undefined | string) && (value.allowNewCards === undefined || typeof value.allowNewCards === 'boolean') && Array.isArray(value.resources) && (value.intent === 'create' || value.allowNewCards === true || value.resources.length > 0) && value.resources.length <= 80, '白板请求快照损坏。');
  validateBoardSnapshot(value.snapshot, value.boardId, researchId);
  requireValue(value.allowedEvidenceIds === undefined || Array.isArray(value.allowedEvidenceIds) && value.allowedEvidenceIds.length <= 16 && value.allowedEvidenceIds.every(safeId) && new Set(value.allowedEvidenceIds).size === value.allowedEvidenceIds.length, '白板请求的引用范围损坏。');
  requireValue(value.intent !== 'create' || value.revision === 0 && value.snapshot.placements.length === 0 && value.snapshot.edges.length === 0, '新建白板快照必须为空。');
  requireValue(value.snapshot.placements.length <= 80 && value.snapshot.edges.length <= 160 && JSON.stringify(value).length <= 60000, '白板请求快照过大。');
  const refs = new Set<string>();
  for (const resource of value.resources) {
    requireValue(object(resource) && object(resource.ref) && ['card', 'document'].includes(String(resource.ref.kind)) && safeId(resource.ref.id) && typeof resource.title === 'string' && (resource.body === undefined || typeof resource.body === 'string') && Array.isArray(resource.evidenceIds) && resource.evidenceIds.every(safeId), '白板请求资料损坏。');
    const key = `${resource.ref.kind}:${resource.ref.id}`;
    requireValue(!refs.has(key), '白板请求资料重复。'); refs.add(key);
  }
  requireValue(value.snapshot.placements.every(p => refs.has(`${p.resourceRef.kind}:${p.resourceRef.id}`)), '白板快照包含授权范围之外的资料。');
}

export function archivedBoardCard(data: WorkspaceData, researchId: string, id: string): Card | undefined {
  return Object.values(data.boardChanges ?? {}).filter(change => change.researchId === researchId).flatMap(change => change.createdCards ?? []).find(card => card.id === id);
}
