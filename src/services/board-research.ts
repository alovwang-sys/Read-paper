import type { BoardPlacement, Conversation, LiteratureCandidate, LiteratureSearch, ResearchMaterial, ResourceRef, WorkspaceData } from '../domain/types';
import { getActiveConversation, linkCard, resourceTitle, sameRef, uid, validateEvidence, workspace } from './workspace';
import { normalizeIdentifier } from '../domain/knowledge';
import { searchLiterature } from './literature';
import { validateResearchMaterials } from '../domain/research';

function version(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}-${(hash >>> 0).toString(16)}`;
}
function assertResource(data: WorkspaceData, researchId: string, ref: ResourceRef) {
  const research = data.researches[researchId];
  if (!research || !(ref.kind === 'card' ? research.cardIds.includes(ref.id) && data.cards[ref.id] : ref.kind === 'document' && research.documentIds.includes(ref.id) && data.documents[ref.id]))
    throw new Error('材料已缺失或不属于本研究，请重新选择。');
}
export function resourceMaterial(data: WorkspaceData, researchId: string, ref: ResourceRef): ResearchMaterial {
  assertResource(data, researchId, ref);
  if (ref.kind === 'card') {
    const card = data.cards[ref.id];
    return { id: `card:${card.id}`, kind: 'card_note', title: card.title, text: card.body, version: version(card.title + card.body), resourceRef: { ...ref },
      ...(card.provenance ? { derivedFrom: card.provenance.derivedFrom ?? { sourceIds: [...card.provenance.context.map(item => `evidence:${item.evidenceId}`), ...(card.provenance.materials?.map(item => item.id) ?? [])], requestIds: [card.provenance.requestId] } } : {}) };
  }
  const document = data.documents[ref.id], source = document.discovery;
  const text = `${document.authors || '作者未提供'} · ${document.year || '年份未提供'}\n${source?.abstract || '没有可用摘要；未附送 PDF 全文。'}`;
  return { id: source?.id ?? `document:${document.id}`, kind: 'abstract', title: document.title, text, version: version(document.title + text), resourceRef: { ...ref },
    ...(source ? { provider: source.provider, providerId: source.providerId, retrievedAt: source.retrievedAt, url: source.url } : document.identifiers?.url ? { url: document.identifiers.url } : {}) };
}
export function candidateMaterial(candidate: LiteratureCandidate): ResearchMaterial {
  const text = `${candidate.authors.join(', ') || '作者未提供'} · ${candidate.year ?? '年份未提供'}\n${candidate.abstract || '来源没有提供摘要；未读取 PDF 全文。'}`;
  return { id: candidate.id, kind: 'abstract', title: candidate.title, text, version: version(candidate.title + text), provider: candidate.provider, providerId: candidate.providerId, url: candidate.url, retrievedAt: candidate.retrievedAt };
}
export function researchMaterials(data: WorkspaceData, conversationId: string): ResearchMaterial[] {
  const conversation = data.conversations[conversationId], state = conversation?.boardResearch;
  if (!state) return [];
  const research = data.researches[conversation.researchId], board = data.boards[state.origin.boardId];
  if (!research || !board || board.researchId !== research.id) throw new Error('这段讨论的白板已缺失，请先恢复白板。');
  const items: ResearchMaterial[] = [];
  if (state.includeBackground) {
    const root = state.origin.rootRef;
    const description = root?.kind === 'card' && research.cardIds.includes(root.id) ? data.cards[root.id]?.body ?? '' : '';
    const text = `研究问题：${research.question}\n白板：${board.title}\n原问题：${state.origin.rootTitle}\n${description}`;
    items.push({ id: `background:${board.id}:${state.origin.rootPlacementId ?? root?.id ?? 'question'}`, kind: 'background', title: '研究背景与原问题', text, version: version(text) });
  }
  for (const item of [...state.automatic, ...state.pinned]) {
    if (state.excludedSourceIds.includes(item.id)) continue;
    items.push(item.resourceRef ? resourceMaterial(data, research.id, item.resourceRef) : structuredClone(item));
  }
  return [...new Map(items.map(item => [item.id, item])).values()].filter(item => !state.excludedSourceIds.includes(item.id));
}
function showConversation(data: WorkspaceData, conversation: Conversation) {
  const session = data.sessions[conversation.researchId];
  session.activeConversationId = conversation.id;
  Object.assign(session.panel, { open: true, mode: 'ai', aiView: 'chat', aiMode: conversation.connectionId === 'demo' ? 'demo' : 'live' });
  delete conversation.boardSkill;
}
export function openBoardResearch(input: { boardId: string; placementIds: string[]; mode: 'ask' | 'literature'; fresh?: boolean }): { conversationId: string; rootPlacementId?: string } {
  let result!: { conversationId: string; rootPlacementId?: string };
  workspace.updateData(data => {
    const board = data.boards[input.boardId];
    if (!board || !input.placementIds.length || input.placementIds.length > 40) throw new Error('请选择 1–40 项白板材料。');
    const placements = [...new Set(input.placementIds)].map(id => data.placements[id]);
    if (placements.some(item => !item || item.boardId !== board.id)) throw new Error('选中的白板材料已改变，请重新选择。');
    placements.forEach(item => assertResource(data, board.researchId, item.resourceRef));
    const first = placements[0];
    const related = first.researchConversationId ? data.conversations[first.researchConversationId] : undefined;
    const previous = !input.fresh && (related?.researchId === board.researchId && related.boardResearch?.origin.boardId === board.id ? related : Object.values(data.conversations).filter(c => !c.archived && c.researchId === board.researchId && c.boardResearch?.origin.boardId === board.id && c.boardResearch.origin.rootPlacementId === first.id).at(-1));
    const current = getActiveConversation(data, board.researchId);
    const conversation: Conversation = previous || { id: uid('conversation'), researchId: board.researchId, title: resourceTitle(data, first.resourceRef).slice(0, 120), contextIds: [], requestIds: [], input: '', historyRange: 'guided', connectionId: current?.connectionId ?? 'model', createdAt: new Date().toISOString(),
      boardResearch: { origin: { boardId: board.id, rootTitle: resourceTitle(data, first.resourceRef), rootRef: { ...first.resourceRef }, rootPlacementId: first.id }, focus: [], automatic: [], pinned: [], excludedSourceIds: [], includeBackground: true } };
    const state = conversation.boardResearch!;
    state.focus = placements.map(item => ({ ...item.resourceRef }));
    state.automatic = placements.map(item => resourceMaterial(data, board.researchId, item.resourceRef));
    state.view = input.mode === 'literature' ? 'literature' : 'chat';
    state.literatureQuery ??= state.origin.rootTitle;
    conversation.updatedAt = new Date().toISOString();
    data.conversations[conversation.id] = conversation;
    showConversation(data, conversation);
    result = { conversationId: conversation.id, rootPlacementId: state.origin.rootPlacementId };
  });
  return result;
}
export function createBoardQuestion(input: { boardId: string; title: string; body: string; position?: { x: number; y: number }; drawingOrigin?: { elementIds: string[]; text: string } }) {
  const cardId = uid('card'), placementId = uid('placement');
  if (!input.title.trim() || input.title.length > 200 || input.body.length > 20000) throw new Error('请填写 200 字以内的问题标题，正文不超过 20,000 字。');
  if (input.drawingOrigin && (input.drawingOrigin.text.length > 20000 || input.drawingOrigin.elementIds.length > 1000 || input.drawingOrigin.elementIds.some(id => !id || id.length > 500))) throw new Error('所选绘图文字过多，请缩小到 20,000 字和 1,000 个元素以内。');
  workspace.updateData(data => {
    const board = data.boards[input.boardId];
    if (!board) throw new Error('白板已不存在。');
    const position = input.position ?? { x: 50, y: Math.max(50, ...Object.values(data.placements).filter(p => p.boardId === board.id).map(p => p.y + 280)) };
    if (![position.x, position.y].every(value => Number.isFinite(value) && value >= 0)) throw new Error('问题位置无效。');
    data.cards[cardId] = { id: cardId, title: input.title.trim(), body: input.body.trim(), evidenceIds: [], needsReview: true, ...(input.drawingOrigin ? { drawingOrigin: { boardId: board.id, ...structuredClone(input.drawingOrigin) } } : {}) };
    linkCard(data, board.researchId, cardId);
    data.placements[placementId] = { id: placementId, boardId: board.id, resourceRef: { kind: 'card', id: cardId }, ...position, group: '' };
    delete data.sessions[board.researchId].boardQuestionDrafts?.[board.id];
  });
  return { cardId, placementId };
}
export function setResearchMaterial(conversationId: string, material: ResearchMaterial, included: boolean, pin = true) {
  validateResearchMaterials([material]);
  workspace.updateData(data => {
    const conversation = data.conversations[conversationId], state = conversation?.boardResearch;
    if (!state) throw new Error('请从白板打开局部讨论。');
    if (material.resourceRef) assertResource(data, conversation.researchId, material.resourceRef);
    if (material.kind === 'background') state.includeBackground = included;
    state.excludedSourceIds = included ? state.excludedSourceIds.filter(id => id !== material.id) : [...new Set([...state.excludedSourceIds, material.id])];
    if (included && pin && material.kind !== 'background') {
      state.pinned = state.pinned.filter(item => item.id !== material.id);
      if (state.pinned.length >= 100) state.pinned = state.pinned.filter(item => !state.excludedSourceIds.includes(item.id));
      if (state.pinned.length >= 100) throw new Error('主动保留的材料最多 100 项，请先移除部分材料。');
      state.pinned.push(structuredClone(material));
    }
  });
}
export function focusLiteratureCandidate(conversationId: string, candidate: LiteratureCandidate) {
  workspace.updateData(data => {
    const conversation = data.conversations[conversationId], state = conversation?.boardResearch;
    if (!state) throw new Error('请先打开白板问题。');
    state.automatic = [candidateMaterial(candidate)];
    state.focus = candidate.documentId ? [{ kind: 'document', id: candidate.documentId }] : [];
    state.view = 'chat';
    showConversation(data, conversation);
  });
}
export function returnToResearchRoot(conversationId: string) {
  workspace.updateData(data => {
    const conversation = data.conversations[conversationId], state = conversation?.boardResearch;
    if (!state) throw new Error('原问题已不存在。');
    state.focus = state.origin.rootRef ? [{ ...state.origin.rootRef }] : [];
    state.automatic = state.focus.map(ref => resourceMaterial(data, conversation.researchId, ref));
    state.view = 'chat';
    showConversation(data, conversation);
  });
}
export function branchBoardResearch(conversationId: string) {
  const old = workspace.getState().data.conversations[conversationId];
  if (!old?.boardResearch) throw new Error('这不是白板讨论。');
  const id = uid('conversation');
  workspace.updateData(data => {
    const original = data.conversations[conversationId];
    const next: Conversation = { id, researchId: original.researchId, title: `${original.title || '问题'} · 新分支`.slice(0, 120), contextIds: [...original.contextIds], requestIds: [], input: original.input, historyRange: 'guided', connectionId: original.connectionId, boardResearch: structuredClone(original.boardResearch), createdAt: new Date().toISOString() };
    data.conversations[id] = next;
    showConversation(data, next);
  });
  return id;
}
const searches = new Map<string, { controller: AbortController; done: Promise<void> }>();
export async function searchBoardLiterature(conversationId: string, query: string, filters: { yearFrom?: number; yearTo?: number } = {}) {
  const id = uid('literature'), generation = workspace.getGeneration();
  const controller = new AbortController();
  workspace.updateData(data => {
    const conversation = data.conversations[conversationId], state = conversation?.boardResearch;
    if (!state) throw new Error('请先打开一个白板问题。');
    if (!query.trim() || query.length > 500) throw new Error('检索词需为 1–500 字。');
    if ([filters.yearFrom, filters.yearTo].some(year => year !== undefined && (!Number.isInteger(year) || year < 1 || year > 9999)) || filters.yearFrom !== undefined && filters.yearTo !== undefined && filters.yearFrom > filters.yearTo) throw new Error('年份条件无效，请核对起止年份。');
    if (conversation.literatureSearches?.some(item => item.status === 'searching')) throw new Error('本问题正在检索，请等待或停止。');
    const batch: LiteratureSearch = { id, researchId: conversation.researchId, conversationId, boardId: state.origin.boardId, rootPlacementId: state.origin.rootPlacementId, rootTitle: state.origin.rootTitle, query: query.trim(), ...filters, createdAt: new Date().toISOString(), status: 'searching', candidates: [] };
    (conversation.literatureSearches ??= []).push(batch);
    state.literatureQuery = query;
    state.literatureBatchId = id;
    state.literatureScrollTop = 0;
  });
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  searches.set(id, { controller, done });
  try {
    const result = await searchLiterature(query.trim(), { signal: controller.signal, ...filters });
    if (workspace.getGeneration() !== generation) return id;
    workspace.updateData(data => {
      const batch = data.conversations[conversationId]?.literatureSearches?.find(item => item.id === id);
      if (batch?.status === 'searching') { batch.candidates = structuredClone(result.candidates); batch.warnings = result.warnings; batch.partial = result.partial; batch.status = 'done'; }
    });
  } catch (caught) {
    if (workspace.getGeneration() !== generation) return id;
    workspace.updateData(data => {
      const batch = data.conversations[conversationId]?.literatureSearches?.find(item => item.id === id);
      if (batch?.status === 'searching') { batch.status = controller.signal.aborted ? 'stopped' : 'error'; batch.error = caught instanceof Error ? caught.message : '检索失败，请重试。'; batch.errorCode = caught && typeof caught === 'object' && 'code' in caught ? String(caught.code) : 'network'; }
    });
  } finally { searches.delete(id); finish(); }
  return id;
}
export function stopLiteratureSearch(id: string) { searches.get(id)?.controller.abort(); }
export async function stopAllLiteratureSearches() {
  const active = [...searches.values()];
  active.forEach(item => item.controller.abort());
  await Promise.allSettled(active.map(item => item.done));
}
export function findResearchEvidence(conversationId: string, scope: 'selected' | 'board' | 'research', query: string) {
  const id = uid('evidence-search');
  workspace.updateData(data => {
    const conversation = data.conversations[conversationId], state = conversation?.boardResearch;
    if (!state || !['selected', 'board', 'research'].includes(scope) || query.length > 500) throw new Error('查找范围或查询无效。');
    const research = data.researches[conversation.researchId];
    const boardRefs = Object.values(data.placements).filter(p => p.boardId === state.origin.boardId).map(p => p.resourceRef);
    const selected = researchMaterials(data, conversationId).flatMap(item => item.resourceRef ? [item.resourceRef] : []);
    const refs = scope === 'research' ? [...research.cardIds.map(id => ({ kind: 'card' as const, id })), ...research.documentIds.map(id => ({ kind: 'document' as const, id }))] : scope === 'board' ? boardRefs : selected;
    const cards = [...new Set(refs.filter(ref => ref.kind === 'card').map(ref => ref.id))].filter(id => research.cardIds.includes(id) && data.cards[id]);
    const documents = new Set(refs.filter(ref => ref.kind === 'document' && research.documentIds.includes(ref.id)).map(ref => ref.id));
    const allowedEvidence = new Set(cards.flatMap(id => data.cards[id].evidenceIds));
    if (scope === 'selected') conversation.contextIds.forEach(id => allowedEvidence.add(id));
    const evidence = Object.values(data.evidence).filter(item => research.documentIds.includes(item.documentId) && (scope === 'research' || documents.has(item.documentId) || allowedEvidence.has(item.id)));
    const pool = [...cards.map(id => ({ id: `card:${id}`, title: data.cards[id].title, material: resourceMaterial(data, research.id, { kind: 'card', id }) })), ...evidence.flatMap(item => {
      try {
        validateEvidence(data, [item.id]);
        const doc = data.documents[item.documentId];
        return [{ id: `evidence:${item.id}`, title: `${doc.title} · PDF 第 ${item.pageIndex + 1} 页`, evidence: { evidenceId: item.id, documentId: doc.id, documentHash: doc.hash!, title: doc.title, pageIndex: item.pageIndex, quote: item.quote, ...(item.kind === 'region' ? { kind: 'region' as const, region: item.region } : {}) } }];
      } catch { return []; }
    })];
    if (pool.length > 500 || JSON.stringify(pool).length > 500000) throw new Error('查找范围过大，请改为当前白板或已选材料。');
    const needle = query.trim().toLocaleLowerCase();
    const candidates = pool.filter(item => `${item.title} ${'material' in item ? item.material.text : item.evidence.quote}`.toLocaleLowerCase().includes(needle)).slice(0, 20);
    (conversation.evidenceSearches ??= []).push({ id, researchId: research.id, conversationId, boardId: state.origin.boardId, scope, query: query.trim(), createdAt: new Date().toISOString(), scannedIds: pool.map(item => item.id), candidates: structuredClone(candidates) });
  });
  return id;
}
function findBatch(data: WorkspaceData, conversationId: string, batchId: string, candidateId: string) {
  const conversation = data.conversations[conversationId], batch = conversation?.literatureSearches?.find(item => item.id === batchId);
  const candidate = batch?.candidates.find(item => item.id === candidateId);
  if (!batch || !candidate || batch.conversationId !== conversationId || batch.researchId !== conversation.researchId || !data.researches[batch.researchId]) throw new Error('检索结果或所属研究已不存在。');
  return { batch, candidate };
}
function saveCandidate(data: WorkspaceData, researchId: string, candidate: LiteratureCandidate) {
  const doi = candidate.doi ? normalizeIdentifier(candidate.doi) : undefined;
  const existing = Object.values(data.documents).find(doc => doc.discovery?.providerId === candidate.providerId || doi?.kind === 'doi' && doc.identifiers?.doi && normalizeIdentifier(doc.identifiers.doi)?.value === doi.value);
  const id = existing?.id ?? uid('document');
  if (!existing) data.documents[id] = { id, title: candidate.title, authors: candidate.authors.join(', '), year: candidate.year ? String(candidate.year) : '', identifiers: { ...(doi?.kind === 'doi' ? { doi: doi.value } : {}), url: candidate.url }, readingStatus: 'unread', textStatus: 'pending', discovery: structuredClone(candidate), updatedAt: new Date().toISOString() };
  else {
    existing.discovery ??= structuredClone(candidate);
    existing.authors ||= candidate.authors.join(', ');
    existing.year ||= candidate.year ? String(candidate.year) : '';
  }
  const research = data.researches[researchId];
  research.documentIds = [...new Set([...research.documentIds, id])];
  candidate.documentId = id;
  return id;
}
export function importLiteratureCandidate(conversationId: string, batchId: string, candidateId: string) {
  let id = '';
  workspace.updateData(data => { const { batch, candidate } = findBatch(data, conversationId, batchId, candidateId); id = saveCandidate(data, batch.researchId, candidate); });
  return id;
}
function placeNearRoot(data: WorkspaceData, conversation: Conversation, ref: ResourceRef, anchorId: string | undefined): BoardPlacement {
  const origin = conversation.boardResearch?.origin, board = origin && data.boards[origin.boardId], anchor = anchorId ? data.placements[anchorId] : undefined;
  if (!board || board.researchId !== conversation.researchId || !anchor || anchor.boardId !== board.id) throw new Error('原问题的摆放已缺失，请恢复原问题后再放回。检索结果仍保留。');
  assertResource(data, conversation.researchId, anchor.resourceRef);
  assertResource(data, conversation.researchId, ref);
  const existing = Object.values(data.placements).find(p => p.boardId === board.id && p.researchConversationId === conversation.id && sameRef(p.resourceRef, ref));
  if (existing) return existing;
  const occupied = Object.values(data.placements).filter(p => p.boardId === board.id);
  const position = { x: anchor.x + 340, y: anchor.y };
  const height = (resource: ResourceRef) => resource.kind === 'document' ? 360 : 320;
  let collision: BoardPlacement | undefined;
  while ((collision = occupied.find(p => position.x < p.x + 280 && position.x + 280 > p.x && position.y < p.y + height(p.resourceRef) + 24 && position.y + height(ref) + 24 > p.y))) position.y = collision.y + height(collision.resourceRef) + 24;
  const placement: BoardPlacement = { id: uid('placement'), boardId: board.id, resourceRef: { ...ref }, ...position, group: anchor.group, researchConversationId: conversation.id };
  data.placements[placement.id] = placement;
  const edgeId = uid('edge');
  data.edges[edgeId] = { id: edgeId, boardId: board.id, fromPlacementId: anchor.id, toPlacementId: placement.id, label: ref.kind === 'document' ? '相关文献 · 待核查' : '新的理解 · 待核查' };
  data.sessions[conversation.researchId].anchor = { placementId: placement.id };
  return placement;
}
export function placeLiteratureCandidate(conversationId: string, batchId: string, candidateId: string) {
  let placementId = '';
  workspace.updateData(data => {
    const { batch, candidate } = findBatch(data, conversationId, batchId, candidateId);
    if (data.conversations[conversationId].boardResearch?.origin.boardId !== batch.boardId) throw new Error('检索起点与讨论不一致。');
    const id = saveCandidate(data, batch.researchId, candidate);
    placementId = placeNearRoot(data, data.conversations[conversationId], { kind: 'document', id }, batch.rootPlacementId).id;
  });
  return placementId;
}
export function placeResearchCard(conversationId: string, cardId: string) {
  let id = '';
  workspace.updateData(data => {
    const conversation = data.conversations[conversationId];
    if (!conversation?.boardResearch) throw new Error('这段讨论没有白板起点。');
    id = placeNearRoot(data, conversation, { kind: 'card', id: cardId }, conversation.boardResearch.origin.rootPlacementId).id;
  });
  return id;
}
