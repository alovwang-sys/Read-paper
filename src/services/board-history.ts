import type { AIRequest, BoardContext, BoardSnapshot, Card, Session, WorkspaceData } from '../domain/types';
import { archivedBoardCard, boardSnapshot, parseBoardPlan, previewBoardPlan, sameBoard, validateBoardContext, validateBoardSnapshot } from '../domain/board-history';
import { linkCard, uid, validateEvidence, workspace } from './workspace';
import { remapCitationNumbers } from '../domain/citations';
import { flushBoardDrawings, loadBoardDrawing } from './drawing-storage';
import { collapseEmptyPanes, paneGroups, syncPaneSession } from './panes';
export { captureBoardContext, parseBoardPlan, previewBoardPlan } from '../domain/board-history';

export const boardChanges = (data: WorkspaceData, boardId: string) =>
  Object.values(data.boardChanges ?? {}).filter(c => c.boardId === boardId).sort((a, b) => b.revision - a.revision);

export function createChatBoardContext(data: WorkspaceData, researchId: string, evidenceIds: string[]): BoardContext {
  const research = data.researches[researchId];
  if (!research || validateEvidence(data, evidenceIds).some(e => !research.documentIds.includes(e.documentId))) throw new Error('白板材料不属于当前研究。');
  const boardId = uid('board');
  const context: BoardContext = { intent: 'create', researchId, boardId, revision: 0, snapshot: { board: { id: boardId, researchId, title: '对话白板' }, placements: [], edges: [] }, resources: [], allowedEvidenceIds: [...evidenceIds] };
  validateBoardContext(context, researchId);
  return context;
}

function validateResources(data: WorkspaceData, snapshot: BoardSnapshot) {
  validateBoardSnapshot(snapshot, snapshot.board.id, snapshot.board.researchId);
  const research = data.researches[snapshot.board.researchId];
  if (!research) throw new Error('研究已不存在，无法恢复白板。');
  for (const placement of snapshot.placements) {
    const ref = placement.resourceRef;
    if (ref.kind === 'card') {
      if (!Object.hasOwn(data.cards, ref.id)) throw new Error('历史引用的卡片已缺失，无法恢复；当前资料保留。');
      if (!research.cardIds.includes(ref.id) || validateEvidence(data, data.cards[ref.id].evidenceIds).some(e => !research.documentIds.includes(e.documentId)))
        throw new Error('历史引用的卡片或来源已移出研究，请先重新关联资料。');
    } else {
      if (!Object.hasOwn(data.documents, ref.id)) throw new Error('历史引用的论文已缺失，无法恢复；当前资料保留。');
      if (!research.documentIds.includes(ref.id)) throw new Error('历史引用的论文已移出研究，请先重新关联资料。');
    }
  }
}
function verifyContext(data: WorkspaceData, context: BoardContext) {
  validateBoardContext(context, context.researchId);
  if ((data.boardRevisions?.[context.boardId] ?? 0) !== context.revision || (context.intent === 'create' ? boardSnapshot(data, context.boardId) !== null : !sameBoard(boardSnapshot(data, context.boardId), context.snapshot)))
    throw new Error('白板在提案生成后已修改。当前修改已保留，请重新生成方案。');
  const research = data.researches[context.researchId];
  if (!research || context.snapshot.board.researchId !== research.id) throw new Error('提案的研究已改变。');
  for (const resource of context.resources) {
    const { kind, id } = resource.ref;
    const current = kind === 'card' ? data.cards[id] : data.documents[id];
    const ids = kind === 'card' ? research.cardIds : research.documentIds;
    if (!current || !ids.includes(id) || current.title !== resource.title || kind === 'card' &&
      (data.cards[id].body !== resource.body || JSON.stringify(data.cards[id].evidenceIds) !== JSON.stringify(resource.evidenceIds)))
      throw new Error('提案所用资料已修改或移出研究，请重新生成方案。');
  }
}

function validateCardSources(data: WorkspaceData, card: Card, request: Pick<AIRequest, 'context' | 'researchId'>) {
  remapCitationNumbers(card.body, card.evidenceIds, card.evidenceIds);
  for (const evidence of validateEvidence(data, card.evidenceIds)) {
    const source = request.context.find(item => item.evidenceId === evidence.id), doc = data.documents[evidence.documentId];
    if (!source || source.documentId !== evidence.documentId || source.documentHash !== doc.hash || source.pageIndex !== evidence.pageIndex || source.quote !== evidence.quote || (source.kind === 'region' && JSON.stringify(source.region) !== JSON.stringify(evidence.region)) || !data.researches[request.researchId].documentIds.includes(doc.id))
      throw new Error('白板新卡片引用不属于提交材料，或来源已改变。');
  }
}

export function canAutoApplyBoardProposal(requestId: string): boolean {
  const request = workspace.getState().data.requests[requestId];
  if (!request?.boardContext || !request.boardProposal || request.status !== 'done' || request.validationError || request.superseded) return false;
  try {
    const context = request.boardContext, after = previewBoardPlan(context, request.boardProposal);
    if (context.intent === 'create') return true;
    if (request.boardProposal.nodes.some(n => n.card) || after.board.title !== context.snapshot.board.title || after.board.layout !== context.snapshot.board.layout) return false;
    const rearranged = context.snapshot.placements.filter(p => {
      const next = after.placements.find(item => item.id === p.id);
      return next && (next.x !== p.x || next.y !== p.y || next.group !== p.group || next.parentPlacementId !== p.parentPlacementId || next.order !== p.order);
    }).length;
    if (rearranged > 0) return false;
    return context.snapshot.placements.every(p => after.placements.some(next => next.id === p.id)) &&
      context.snapshot.edges.every(e => after.edges.some(next => next.fromPlacementId === e.fromPlacementId && next.toPlacementId === e.toPlacementId && next.label === e.label));
  } catch { return false; }
}
function installSnapshot(data: WorkspaceData, snapshot: BoardSnapshot, source: BoardSnapshot | null, copy = false): string {
  const target = structuredClone(snapshot);
  const boardId = copy ? uid('board') : snapshot.board.id;
  if (copy) target.board = { ...target.board, id: boardId, title: `${target.board.title}（恢复副本）` };
  const ids = new Map<string, string>();
  target.placements = target.placements.map(p => {
    const preserve = !copy && source?.placements.some(old => old.id === p.id);
    const id = preserve ? p.id : uid('placement'); ids.set(p.id, id);
    if (data.placements[id] && data.placements[id].boardId !== boardId) throw new Error('摆放标识冲突，未修改白板。');
    return { ...p, id, boardId };
  });
  target.placements.forEach(p => { if (p.parentPlacementId !== undefined) p.parentPlacementId = ids.get(p.parentPlacementId)!; });
  target.edges = target.edges.map(e => {
    const id = !copy && source?.edges.some(old => old.id === e.id) ? e.id : uid('edge');
    if (data.edges[id] && data.edges[id].boardId !== boardId) throw new Error('连线标识冲突，未修改白板。');
    return { ...e, id, boardId, fromPlacementId: ids.get(e.fromPlacementId)!, toPlacementId: ids.get(e.toPlacementId)! };
  });
  validateResources(data, target);
  for (const p of Object.values(data.placements)) if (p.boardId === boardId) delete data.placements[p.id];
  for (const e of Object.values(data.edges)) if (e.boardId === boardId) delete data.edges[e.id];
  data.boards[boardId] = target.board;
  target.placements.forEach(p => { data.placements[p.id] = p; });
  target.edges.forEach(e => { data.edges[e.id] = e; });
  return boardId;
}

export async function applyBoardProposal(requestId: string): Promise<string> {
  await flushBoardDrawings();
  const data = workspace.getState().data;
  const existing = Object.values(data.boardChanges ?? {}).find(c => c.requestId === requestId);
  if (existing) {
    if (data.requests[requestId]?.boardApplyError) workspace.updateData(next => { delete next.requests[requestId].boardApplyError; });
    await workspace.flushSave(); return existing.id;
  }
  const request = data.requests[requestId];
  if (!request || request.status !== 'done' || !request.boardContext || !request.boardProposal || request.superseded || request.validationError)
    throw new Error('请等待有效白板提案完成后再应用。');
  const context = request.boardContext;
  if (context.researchId !== request.researchId || data.conversations[request.conversationId]?.researchId !== request.researchId)
    throw new Error('白板提案与研究会话不匹配。');
  const plan = parseBoardPlan(JSON.stringify(request.boardProposal), context);
  verifyContext(data, context);
  workspace.updateData(next => {
    verifyContext(next, context);
    const snapshot = previewBoardPlan(context, plan);
    plan.nodes.forEach((node, index) => {
      if (!node.card) return;
      const card: Card = { id: uid('card'), ...structuredClone(node.card), needsReview: true,
        provenance: { researchId: request.researchId, conversationId: request.conversationId, conversationTitle: next.conversations[request.conversationId].title ?? '研究对话', requestId, prompt: request.prompt, answer: request.body, selection: node.card.body, answerEvidenceIds: [], context: structuredClone(request.context), createdAt: request.createdAt, model: request.model, connectionId: request.connectionId, generationRequestIds: [requestId] } };
      validateCardSources(next, card, request);
      next.cards[card.id] = card;
      linkCard(next, request.researchId, card.id);
      snapshot.placements[index].resourceRef = { kind: 'card', id: card.id };
    });
    installSnapshot(next, snapshot, context.intent === 'create' ? null : context.snapshot);
    delete next.requests[requestId].boardApplyError;
  }, { boardChange: { actor: request.connectionId ?? 'model', summary: plan.summary, requestId } });
  const change = Object.values(workspace.getState().data.boardChanges ?? {}).find(c => c.requestId === requestId);
  if (!change) throw new Error('方案与当前白板相同，没有需要保存的修改。');
  await workspace.flushSave();
  return change.id;
}

function cleanRemovedResources(data: WorkspaceData, boardId: string, cardIds: Set<string>) {
  const removed = (ref: Session['active']) => ref.kind === 'board' && ref.id === boardId || ref.kind === 'card' && cardIds.has(ref.id);
  const removedViews = new Set<string>();
  for (const [id, session] of Object.entries(data.sessions)) {
    session.openItems = session.openItems.filter(ref => !removed(ref));
    session.history = session.history.filter(ref => !removed(ref));
    session.recentItems = session.recentItems?.filter(ref => !removed(ref));
    session.pinnedIds = session.pinnedIds.filter(id => id !== boardId && !cardIds.has(id));
    if (removed(session.active)) { session.active = session.openItems.at(-1) ?? (id === 'library' ? { kind: 'collection', id: 'cards' } : { kind: 'researchView', id: 'boards' }); session.anchor = undefined; }
    session.panel.history = session.panel.history.filter(ref => !removed(ref));
    if (session.panel.ref && removed(session.panel.ref)) { delete session.panel.ref; delete session.panel.anchor; session.panel.pinned = false; }
    if (session.panel.sourceReturnRef && removed(session.panel.sourceReturnRef)) delete session.panel.sourceReturnRef;
    if (session.panel.findEvidenceFor && cardIds.has(session.panel.findEvidenceFor)) delete session.panel.findEvidenceFor;
    if (session.mainSplit && removed(session.mainSplit.ref)) delete session.mainSplit;
    if (session.layout) {
      let changed = false;
      for (const pane of paneGroups(session.layout.root)) {
        for (const tab of pane.tabs) {
          if (removed(tab.ref)) { removedViews.add(`view:${tab.id}`); changed = true; }
          if (tab.anchor?.placementId && !data.placements[tab.anchor.placementId]) delete tab.anchor.placementId;
        }
        pane.tabs = pane.tabs.filter(tab => !removed(tab.ref));
      }
      if (changed) {
        session.layout.root = collapseEmptyPanes(session.layout.root);
        syncPaneSession(session);
      }
    }
    for (const anchor of [session.anchor, session.panel.anchor]) if (anchor?.placementId && !data.placements[anchor.placementId]) delete anchor.placementId;
    delete session.viewports[boardId];
    delete session.viewports[`drawing:${boardId}`];
    if (session.boardModes) delete session.boardModes[boardId];
  }
  for (const conversation of Object.values(data.conversations)) if (conversation.boardSkill?.boardId === boardId) delete conversation.boardSkill;
  return removedViews;
}

export async function undoBoardCreation(requestId: string): Promise<void> {
  await flushBoardDrawings();
  const data = workspace.getState().data;
  const creation = Object.values(data.boardChanges ?? {}).find(change => change.requestId === requestId && !change.before && change.after);
  if (!creation) throw new Error('没有可撤销的白板创建。');
  const prior = boardChanges(data, creation.boardId).find(change => change.restores === creation.id && !change.after);
  if (prior && !data.boards[creation.boardId] && data.boardRevisions?.[creation.boardId] === prior.revision) { await workspace.flushSave(); return; }
  if (data.boardRevisions?.[creation.boardId] !== creation.revision || !sameBoard(boardSnapshot(data, creation.boardId), creation.after)) throw new Error('白板已发生后续修改，无法撤销创建；请从版本历史恢复或保留当前内容。');
  const removed = new Set<string>();
  let removedViews = new Set<string>();
  workspace.updateData(next => {
    for (const card of creation.createdCards ?? []) {
      const reused = Object.values(next.researches).some(r => r.id !== creation.researchId && r.cardIds.includes(card.id)) ||
        Object.values(next.placements).some(p => p.boardId !== creation.boardId && p.resourceRef.kind === 'card' && p.resourceRef.id === card.id) ||
        Object.values(next.boardChanges ?? {}).some(change => change.boardId !== creation.boardId && [change.before, change.after].some(snapshot => snapshot?.placements.some(p => p.resourceRef.kind === 'card' && p.resourceRef.id === card.id))) ||
        Object.values(next.drafts).some(d => d.cardRefs?.some(ref => ref.cardId === card.id) || d.cardSources?.some(source => source.cardId === card.id)) ||
        Object.values(next.cardDrafts).some(d => d.cardId === card.id);
      if (!reused && JSON.stringify(next.cards[card.id]) === JSON.stringify(card)) {
        delete next.cards[card.id]; removed.add(card.id);
        next.researches[creation.researchId].cardIds = next.researches[creation.researchId].cardIds.filter(id => id !== card.id);
      }
    }
    for (const p of Object.values(next.placements)) if (p.boardId === creation.boardId) delete next.placements[p.id];
    for (const e of Object.values(next.edges)) if (e.boardId === creation.boardId) delete next.edges[e.id];
    delete next.boards[creation.boardId];
    removedViews = cleanRemovedResources(next, creation.boardId, removed);
  }, { boardChange: { actor: 'user', summary: '撤销创建白板', restores: creation.id } });
  const selection = workspace.getState().selection;
  if (selection && (removedViews.has(selection.viewInstanceId) || selection.viewInstanceId === `board:${creation.boardId}` || selection.selectedItems.some(item => item.resourceRef.kind === 'board' && item.resourceRef.id === creation.boardId || item.resourceRef.kind === 'card' && removed.has(item.resourceRef.id)))) workspace.setSelection(undefined);
  await workspace.flushSave();
}

export async function restoreBoardChange(changeId: string, mode: 'safe' | 'copy' = 'safe'): Promise<string> {
  await flushBoardDrawings();
  const data = workspace.getState().data, change = data.boardChanges?.[changeId];
  if (!change?.before) throw new Error('这条记录没有更早的白板版本，请选择后续修改记录。');
  if (change.before.board.drawing) await loadBoardDrawing('', change.before.board.drawing);
  if (mode !== 'safe' && mode !== 'copy') throw new Error('恢复方式无效。');
  // A failed save leaves one paired state/history update; retry it, never create a second restore.
  const prior = Object.values(data.boardChanges ?? {}).find(c => c.restores === changeId && (mode === 'copy' ? c.boardId !== change.boardId : c.boardId === change.boardId));
  if (prior && (data.boardRevisions?.[prior.boardId] ?? 0) === prior.revision && sameBoard(boardSnapshot(data, prior.boardId), prior.after)) {
    await workspace.flushSave(); return prior.boardId;
  }
  if (mode === 'safe' && ((data.boardRevisions?.[change.boardId] ?? 0) !== change.revision || !sameBoard(boardSnapshot(data, change.boardId), change.after)))
    throw new Error('白板已有后续修改，恢复会发生冲突。请保留当前白板，或恢复为独立副本。');
  let boardId = '';
  workspace.updateData(next => {
    for (const p of change.before!.placements) {
      if (p.resourceRef.kind !== 'card' || Object.hasOwn(next.cards, p.resourceRef.id)) continue;
      const archived = archivedBoardCard(next, change.researchId, p.resourceRef.id);
      if (archived) {
        validateCardSources(next, archived, { researchId: change.researchId, context: archived.provenance?.context ?? [] });
        next.cards[archived.id] = structuredClone(archived); linkCard(next, change.researchId, archived.id);
      }
    }
    boardId = installSnapshot(next, change.before!, change.before, mode === 'copy');
  },
    { boardChange: { actor: 'user', summary: mode === 'copy' ? '将历史白板恢复为副本' : '恢复修改前的白板', restores: changeId } });
  await workspace.flushSave();
  return boardId;
}
