import type { AIRequest, CardProvenance, LiteratureCandidate, ResearchMaterial, WorkspaceData } from './types';

export function requestProvenance(data: WorkspaceData, request: AIRequest, selection: string): CardProvenance {
  const knownHistory = (request.history ?? []).map(turn => data.requests[turn.requestId] ?? turn);
  const lineage = [request, ...knownHistory];
  const materials = [...new Map([...(request.history ?? []).flatMap(turn => turn.materials ?? []), ...(request.materials ?? [])].map(item => [item.id, item])).values()];
  return { researchId: request.researchId, conversationId: request.conversationId, conversationTitle: data.conversations[request.conversationId]?.title || '阅读对话', requestId: request.id, prompt: request.prompt + (request.supplementalInputs?.length ? '\n\n' + request.supplementalInputs.map(input => `本轮补充：${input.text}`).join('\n\n') : ''), answer: request.body, answerEvidenceIds: [...request.evidenceIds], selection, context: structuredClone(request.context), createdAt: new Date().toISOString(), model: request.model, ...(request.codex?.model ? { codexModel: request.codex.model } : {}), connectionId: request.connectionId, generationRequestIds: [], incomplete: request.status !== 'done' || !!request.legacy,
    ...(materials.length ? { materials: structuredClone(materials) } : {}),
    derivedFrom: { sourceIds: [...new Set(lineage.flatMap(item => [...item.context.map(source => `evidence:${source.evidenceId}`), ...(item.materials ?? []).flatMap(material => [material.id, ...(material.derivedFrom?.sourceIds ?? [])])]))], requestIds: [...new Set([request.id, ...(request.history ?? []).map(turn => turn.requestId), ...lineage.flatMap(item => (item.materials ?? []).flatMap(material => material.derivedFrom?.requestIds ?? []))])] } };
}

export function researchMaterialsMarkdown(items: ResearchMaterial[] = []) {
  const labels = { background: '研究背景', card_note: '卡片正文', abstract: '题录与来源摘要', discussion: '其他讨论的结论' };
  return items.map(item => `### ${item.title} · ${labels[item.kind]}\n\n来源 ID：${item.id}  \n版本：${item.version}${item.retrievedAt ? `  \n获取时间：${item.retrievedAt}` : ''}\n\n${item.url ? `[来源链接](${item.url})\n\n` : ''}${item.text.split('\n').map(line => `> ${line}`).join('\n')}\n\n非 PDF 原文证据。${item.derivedFrom ? `派生来源：${item.derivedFrom.sourceIds.join('、')}；问答轮次：${item.derivedFrom.requestIds.join('、')}。` : ''}\n`).join('\n');
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const strings = (value: unknown, max = 1000): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => text(item, 500));
const yearRange = (from: unknown, to: unknown) => [from, to].every(year => year === undefined || Number.isInteger(year) && Number(year) >= 1 && Number(year) <= 9999) && (from === undefined || to === undefined || Number(from) <= Number(to));
const ref = (value: unknown) => object(value) && ['card', 'document', 'board'].includes(String(value.kind)) && text(value.id, 500) && !!value.id;
const url = (value: unknown) => { try { const parsed = typeof value === 'string' ? new URL(value) : undefined; return !!parsed && String(value).length <= 4000 && ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; } };
function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function validateResearchMaterials(value: unknown): asserts value is ResearchMaterial[] {
  requireValue(Array.isArray(value) && value.length <= 100, '研究材料清单无效。');
  const ids = new Set<string>();
  for (const item of value) {
    requireValue(object(item) && text(item.id, 500) && !!item.id && !ids.has(item.id) && ['background', 'card_note', 'abstract', 'discussion'].includes(String(item.kind)) && text(item.title, 2000) && text(item.text, 120000) && text(item.version, 200), '研究材料内容或版本无效。');
    ids.add(item.id);
    requireValue(item.resourceRef === undefined || ref(item.resourceRef), '研究材料引用无效。');
    requireValue(item.url === undefined || url(item.url), '研究材料链接无效。');
    requireValue(item.provider === undefined || item.provider === 'openalex', '研究材料来源无效。');
    requireValue(item.providerId === undefined || text(item.providerId, 500), '研究材料来源标识无效。');
    requireValue(item.retrievedAt === undefined || text(item.retrievedAt, 100), '研究材料获取时间无效。');
    if (item.derivedFrom !== undefined) requireValue(object(item.derivedFrom) && strings(item.derivedFrom.sourceIds) && strings(item.derivedFrom.requestIds), '派生来源记录无效。');
  }
}
export function validateLiteratureCandidate(value: unknown): asserts value is LiteratureCandidate {
  requireValue(object(value) && text(value.id, 500) && !!value.id && value.provider === 'openalex' && text(value.providerId, 500) && !!value.providerId && text(value.title, 2000) && !!value.title.trim() && strings(value.authors, 100) && url(value.url) && text(value.retrievedAt, 100), '文献候选数据无效。');
  requireValue(value.abstract === undefined || text(value.abstract, 100000), '文献摘要无效。');
  requireValue(value.doi === undefined || text(value.doi, 500), '文献 DOI 无效。');
  requireValue(value.pdfUrl === undefined || url(value.pdfUrl), '文献全文链接无效。');
  requireValue(value.year === undefined || Number.isInteger(value.year) && Number(value.year) > 0 && Number(value.year) <= 9999, '文献年份无效。');
  requireValue(value.documentId === undefined || text(value.documentId, 500), '文献收录标识无效。');
}
function validateOrigin(value: unknown) {
  requireValue(object(value) && text(value.boardId, 500) && !!value.boardId && text(value.rootTitle, 1000) && (value.rootRef === undefined || ref(value.rootRef)) && (value.rootPlacementId === undefined || text(value.rootPlacementId, 500)) && (value.drawingElementId === undefined || text(value.drawingElementId, 500)), '局部讨论起点无效。');
}
export function validateResearchData(data: WorkspaceData) {
  for (const document of Object.values(data.documents)) if (document.discovery !== undefined) validateLiteratureCandidate(document.discovery);
  for (const card of Object.values(data.cards)) {
    if (card.drawingOrigin !== undefined) requireValue(text(card.drawingOrigin.boardId, 500) && strings(card.drawingOrigin.elementIds) && text(card.drawingOrigin.text, 20000), '问题绘图出处无效。');
  }
  for (const placement of Object.values(data.placements)) if (placement.researchConversationId !== undefined) {
    const conversation = data.conversations[placement.researchConversationId];
    requireValue(text(placement.researchConversationId, 500) && conversation && conversation.researchId === data.boards[placement.boardId]?.researchId, '白板讨论归属无效。');
  }
  for (const conversation of Object.values(data.conversations)) {
    requireValue(conversation.historyRange === undefined || ['all', 'latest', 'none', 'guided', 'selected'].includes(conversation.historyRange), '会话历史范围无效。');
    requireValue(conversation.historyRequestIds === undefined || strings(conversation.historyRequestIds), '会话历史轮次无效。');
    const state = conversation.boardResearch;
    if (state !== undefined) {
      validateOrigin(state.origin);
      requireValue(!data.boards[state.origin.boardId] || data.boards[state.origin.boardId].researchId === conversation.researchId, '白板讨论跨研究。');
      requireValue(Array.isArray(state.focus) && state.focus.length <= 40 && state.focus.every(ref) && strings(state.excludedSourceIds) && typeof state.includeBackground === 'boolean' && [undefined, 'chat', 'literature'].includes(state.view) && (state.literatureQuery === undefined || text(state.literatureQuery, 500)), '局部讨论范围无效。');
      validateResearchMaterials(state.automatic);
      validateResearchMaterials(state.pinned);
      requireValue(state.literatureBatchId === undefined || text(state.literatureBatchId, 500), '当前文献批次无效。');
      requireValue(state.literatureScrollTop === undefined || Number.isFinite(state.literatureScrollTop) && state.literatureScrollTop >= 0, '文献列表位置无效。');
      requireValue(yearRange(state.literatureYearFrom, undefined) && yearRange(undefined, state.literatureYearTo), '文献检索年份条件无效。');
    }
    if (conversation.literatureSearches !== undefined) {
      requireValue(Array.isArray(conversation.literatureSearches), '文献检索记录无效。');
      for (const batch of conversation.literatureSearches) {
        requireValue(text(batch.id, 500) && batch.researchId === conversation.researchId && batch.conversationId === conversation.id && text(batch.boardId, 500) && text(batch.rootTitle, 1000) && text(batch.query, 500) && text(batch.createdAt, 100) && ['searching', 'done', 'error', 'stopped', 'interrupted'].includes(batch.status) && Array.isArray(batch.candidates) && batch.candidates.length <= 10, '文献检索快照无效。');
        requireValue(!data.boards[batch.boardId] || data.boards[batch.boardId].researchId === conversation.researchId, '文献检索跨研究。');
        batch.candidates.forEach(validateLiteratureCandidate);
        requireValue(yearRange(batch.yearFrom, batch.yearTo), '文献检索年份快照无效。');
        requireValue(batch.warnings === undefined || strings(batch.warnings, 100), '文献检索提示无效。');
        requireValue(batch.partial === undefined || typeof batch.partial === 'boolean', '文献检索完整性无效。');
        for (const candidate of batch.candidates) if (candidate.documentId) requireValue(!!data.documents[candidate.documentId], '已收录文献缺失。');
      }
    }
    if (conversation.evidenceSearches !== undefined) {
      requireValue(Array.isArray(conversation.evidenceSearches), '依据检索记录无效。');
      for (const batch of conversation.evidenceSearches) {
        requireValue(object(batch) && text(batch.id, 500) && batch.researchId === conversation.researchId && batch.conversationId === conversation.id && text(batch.boardId, 500) && ['selected', 'board', 'research'].includes(batch.scope) && text(batch.query, 500) && text(batch.createdAt, 100) && strings(batch.scannedIds) && Array.isArray(batch.candidates) && batch.candidates.length <= 20, '依据检索快照无效。');
        requireValue(!data.boards[batch.boardId] || data.boards[batch.boardId].researchId === conversation.researchId, '依据检索跨研究。');
        for (const item of batch.candidates) {
          requireValue(text(item.id, 500) && text(item.title, 2000) && (!!item.material !== !!item.evidence), '依据候选无效。');
          if (item.material) validateResearchMaterials([item.material]);
          if (item.evidence) requireValue(text(item.evidence.evidenceId, 500) && text(item.evidence.documentId, 500) && text(item.evidence.documentHash, 200) && text(item.evidence.quote, 120000) && Number.isInteger(item.evidence.pageIndex) && item.evidence.pageIndex >= 0, '依据原文快照无效。');
        }
      }
    }
  }
  for (const request of Object.values(data.requests)) {
    if (request.materials !== undefined) validateResearchMaterials(request.materials);
    if (request.boardResearch !== undefined) {
      validateOrigin(request.boardResearch);
      requireValue(!data.boards[request.boardResearch.boardId] || data.boards[request.boardResearch.boardId].researchId === request.researchId, '提问白板起点跨研究。');
      requireValue(Array.isArray(request.boardResearch.focus) && request.boardResearch.focus.length <= 40 && request.boardResearch.focus.every(ref), '提问焦点无效。');
    }
    for (const turn of request.history ?? []) if (turn.materials !== undefined) validateResearchMaterials(turn.materials);
  }
  const sources = [...Object.values(data.cards).map(card => card.provenance), ...Object.values(data.cardDrafts ?? {}).map(draft => draft.source), ...Object.values(data.drafts).flatMap(draft => draft.cardSources?.map(item => item.provenance) ?? [])];
  for (const source of sources) if (source) {
    if (source.materials !== undefined) validateResearchMaterials(source.materials);
    if (source.derivedFrom !== undefined) requireValue(strings(source.derivedFrom.sourceIds) && strings(source.derivedFrom.requestIds), '卡片派生出处无效。');
  }
  for (const session of Object.values(data.sessions)) if (session.boardQuestionDrafts !== undefined) requireValue(object(session.boardQuestionDrafts) && Object.values(session.boardQuestionDrafts).every(draft => object(draft) && text(draft.title, 200) && text(draft.body, 20000) && (draft.drawingOrigin === undefined || object(draft.drawingOrigin) && strings(draft.drawingOrigin.elementIds) && text(draft.drawingOrigin.text, 20000))), '白板问题草稿无效。');
}
