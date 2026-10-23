import type { AIConnectionId, AIRequest, Conversation, Draft, ResearchMaterial, ResourceRef, WorkspaceData } from '../domain/types';
import { validateResearchMaterials } from '../domain/research';
import type { ResearchAgentArtifact, ResearchAgentCapability, ResearchAgentEvent, ResearchAgentInput, ResearchAgentSource } from '../domain/research-agent';
import { validateResearchLiteratureSearch } from '../domain/research-agent';
import { mapCitationNumbers } from '../domain/citations';
import { hasFullText } from '../domain/knowledge';
import { drawingTextLength, validateDrawingQuestion } from '../domain/drawing-question';
import { CHAT_IMAGE_LIMITS, validateChatImages } from '../domain/chat-images';
import { loadDrawingImage } from './drawing-question';
import { loadChatImage } from './chat-images';
import { contentHash, getAsset } from '../data/storage';
import { loadPdfDocument } from './pdf';
import { getActiveConversation, resourceExists, resourceTitle, uid, workspace } from './workspace';

export const RESEARCH_INPUT_CHAR_LIMIT = 120000;
export const RESEARCH_HISTORY_CHAR_LIMIT = 80000;
export const DEFAULT_IMAGE_PROMPT = '请分析这些图片，并说明你的观察和需要进一步核实的问题。';
const running = new Map<string, AbortController>();
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const aborted = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('已停止', 'AbortError'); };

export async function getResearchAgentCapabilities(): Promise<ResearchAgentCapability[]> {
  const response = await fetch('/api/ai/research/capabilities');
  if (!response.ok) throw new Error('无法连接研究服务，请启动本机 AI 服务后重新检测。');
  const result = await response.json();
  if (!Array.isArray(result.connections)) throw new Error('研究服务能力信息无效，请重启服务。');
  return result.connections;
}

/** Extraction happens only after submission; importing this service never reads PDFs. */
export async function collectResearchSources(data: WorkspaceData, researchId: string, signal: AbortSignal, report: (text: string) => void = () => {}, focusDocumentId?: string) {
  const research = data.researches[researchId];
  if (!research) throw new Error('研究已不存在。');
  const sources: ResearchAgentSource[] = [];
  let budget = 160000;
  const orderedIds = focusDocumentId && research.documentIds.includes(focusDocumentId) ? [focusDocumentId, ...research.documentIds.filter(id => id !== focusDocumentId)] : research.documentIds;
  for (const id of orderedIds.slice(0, 8)) {
    aborted(signal);
    const doc = data.documents[id];
    if (!doc) continue;
    const abstract = (doc.abstract?.text || doc.discovery?.abstract)?.trim().slice(0, 12000);
    const source: ResearchAgentSource = { id, title: doc.title.slice(0, 2000), hash: doc.hash ?? '', totalPages: doc.hash ? doc.pageCount ?? 0 : 0, pages: [], ...(abstract ? { abstract } : {}) };
    sources.push(source);
    if (!hasFullText(doc)) { source.unavailable = '只有题录或摘要，尚无 PDF 全文。'; continue; }
    if (!budget) { source.unavailable = '本次文本预算已用完，未读取此文献。'; continue; }
    report(`准备资料：${doc.title}`);
    try {
      const { pdf, hash } = await loadPdfDocument(doc);
      aborted(signal);
      if (doc.hash && hash !== doc.hash) throw new Error('文件 hash 与保存的来源不一致');
      source.hash = hash; source.totalPages = pdf.numPages;
      for (let pageIndex = 0; pageIndex < Math.min(pdf.numPages, 24) && budget > 0; pageIndex++) {
        aborted(signal);
        const page = await pdf.getPage(pageIndex + 1);
        const content = await page.getTextContent();
        aborted(signal);
        const text = content.items.map(item => 'str' in item ? item.str : '').join(' ').slice(0, Math.min(12000, budget));
        if (text.trim()) { source.pages.push({ pageIndex, text }); budget -= text.length; }
      }
      if (!source.pages.length) source.unavailable = '未提取到文字；扫描件需先进行 OCR。';
      else if (source.pages.length < pdf.numPages) source.unavailable = `仅提供前 ${Math.min(pdf.numPages, 24)} 页中的可提取文字，未覆盖全文。`;
    } catch (error) {
      aborted(signal);
      source.unavailable = error instanceof Error ? error.message : 'PDF 读取失败';
      source.pages = [];
    }
  }
  const readable = sources.filter(source => source.pages.length).length;
  const summary = `本次按${focusDocumentId ? '明确追问的文献优先、再按' : ''}研究资料顺序取前 ${Math.min(research.documentIds.length, 8)} 份，其中 ${readable} 份可读；每份最多前 24 页、每页 12,000 字符，总计最多 160,000 字符。${research.documentIds.length > 8 ? `另有 ${research.documentIds.length - 8} 份未发送。` : ''}${sources.some(source => source.unavailable) ? '部分资料缺全文或已截断，不能视为阅读全文。' : ''}${sources.some(source => source.abstract) ? '目录附摘要最多前 12,000 字符，仅作题录信息。' : ''}`;
  return { sources, summary };
}

export function validateResearchArtifact(data: WorkspaceData, researchId: string, sources: ResearchAgentSource[], artifact: ResearchAgentArtifact) {
  const research = data.researches[researchId];
  if (!research || !artifact || typeof artifact.title !== 'string' || !artifact.title.trim() || artifact.title.length > 200 || typeof artifact.body !== 'string' || !artifact.body.trim() || artifact.body.length > 80000 || !Array.isArray(artifact.citations) || artifact.citations.length > 16 || artifact.citations.reduce((sum, item) => sum + (typeof item?.quote === 'string' ? item.quote.length : 24001), 0) > 24000) throw new Error('研究结果格式无效，未写入成果。');
  for (const citation of artifact.citations) {
    const source = sources.find(source => source.id === citation.documentId), doc = data.documents[citation.documentId];
    const page = source?.pages.find(page => page.pageIndex === citation.pageIndex);
    if (!research.documentIds.includes(citation.documentId) || !hasFullText(doc) || doc.hash !== citation.documentHash || source?.hash !== citation.documentHash || !Number.isInteger(citation.pageIndex) || !page || citation.pageIndex >= doc.pageCount || typeof citation.quote !== 'string' || !normalize(citation.quote) || citation.quote.length > 4000 || !normalize(page.text).includes(normalize(citation.quote))) throw new Error('研究结果引用不在本次原文范围内，未写入成果。');
  }
  mapCitationNumbers(artifact.body, number => {
    if (!Number.isInteger(number) || number < 1 || number > artifact.citations.length) throw new Error(`引用 [${number}] 没有对应原文，未写入成果。`);
    return '';
  });
}

function ownsResource(data: WorkspaceData, researchId: string, ref: ResourceRef) {
  const research = data.researches[researchId];
  return !!research && resourceExists(data, ref) && (ref.kind === 'research' ? ref.id === researchId : ref.kind === 'document' ? research.documentIds.includes(ref.id) : ref.kind === 'card' ? research.cardIds.includes(ref.id) : ref.kind === 'draft' ? data.drafts[ref.id]?.researchId === researchId : data.boards[ref.id]?.researchId === researchId);
}
export function isResearchConversation(data: WorkspaceData, conversation: Conversation) {
  return !conversation.nativeImported && !conversation.nativeSessionId && !conversation.nativeSessionRef
    && !conversation.boardResearch && !conversation.boardSkill
    && !conversation.contextIds.length
    && !conversation.requestIds.some(id => data.requests[id] && !data.requests[id].researchRun);
}

export type DiscussionAnchor = NonNullable<Conversation['anchor']> | { kind: 'document'; id: string };
/** A discussion hangs on a card, board or PDF passage; anything else is a research conversation. */
export function discussionAnchor(conversation: Conversation): DiscussionAnchor | undefined {
  if (conversation.anchor && !conversation.promoted) return conversation.anchor;
  if (conversation.inlineSource && !conversation.inlineSource.promoted) return { kind: 'document', id: conversation.inlineSource.documentId };
}
const activityAt = (data: WorkspaceData, item: Conversation) => item.updatedAt ?? item.requestIds.map(id => data.requests[id]).filter(Boolean).at(-1)?.createdAt ?? item.createdAt ?? '';
export function anchoredConversations(data: WorkspaceData, researchId: string, anchor: NonNullable<Conversation['anchor']>) {
  return Object.values(data.conversations)
    .filter(item => item.researchId === researchId && !item.archived && item.anchor?.kind === anchor.kind && item.anchor.id === anchor.id)
    .sort((a, b) => activityAt(data, b).localeCompare(activityAt(data, a)));
}
/** Research conversations stay in the main list; discussions are grouped by the object they hang on. */
export function researchConversationLists(data: WorkspaceData, researchId: string, query = '') {
  const needle = query.trim().toLocaleLowerCase(), matches = (...texts: string[]) => !needle || texts.some(text => text.toLocaleLowerCase().includes(needle));
  const main: Conversation[] = [], groups = new Map<string, { label: string; items: { conversation: Conversation; label: string }[] }>();
  const listed = Object.values(data.conversations)
    .filter(item => item.researchId === researchId && !item.archived && (item.inlineSource?.operation ?? 'question') === 'question')
    .sort((a, b) => activityAt(data, b).localeCompare(activityAt(data, a)));
  const anchorKey = (item: Conversation) => item.anchor && `${item.anchor.kind}:${item.anchor.id}`, totals = new Map<string, number>(), seen = new Map<string, number>();
  for (const item of listed) { const key = anchorKey(item); if (key) totals.set(key, (totals.get(key) ?? 0) + 1); }
  for (const conversation of listed) {
    const anchor = discussionAnchor(conversation), title = conversation.title?.trim() || '新会话';
    if (!anchor) { if (matches(title)) main.push(conversation); continue; }
    const quote = conversation.inlineSource && data.evidence[conversation.inlineSource.evidenceId]?.quote.trim();
    const label = anchor.kind === 'card' ? data.cards[anchor.id]?.title ?? '已移除的卡片'
      : anchor.kind === 'board' ? data.boards[anchor.id]?.title ?? '已移除的白板'
      : `第 ${conversation.inlineSource!.pageIndex + 1} 页 · ${quote ? quote.slice(0, 40) : '区域'}`;
    // Newest first; when one card or board has several threads, number them oldest = 1.
    const key = anchorKey(conversation), total = key ? totals.get(key)! : 1, index = key ? seen.get(key) ?? 0 : 0;
    if (key) seen.set(key, index + 1);
    const numbered = total > 1 ? `${label} · ${total - index}` : label;
    const group = anchor.kind === 'card' ? '卡片' : anchor.kind === 'board' ? '白板' : data.documents[anchor.id]?.title ?? '已移除的资料';
    if (!matches(label, title, group)) continue;
    const groupKey = anchor.kind === 'document' ? `document:${anchor.id}` : anchor.kind;
    if (!groups.has(groupKey)) groups.set(groupKey, { label: group, items: [] });
    groups.get(groupKey)!.items.push({ conversation, label: numbered });
  }
  return { main, discussions: [...groups.values()] };
}
export const EARLIER_AFTER_DAYS = 14;
/** Research conversations idle for 14 days fold into "更早"; unknown activity counts as old. */
export function splitByRecency(data: WorkspaceData, conversations: Conversation[], now = Date.now()) {
  const cutoff = now - EARLIER_AFTER_DAYS * 86_400_000, recent: Conversation[] = [], earlier: Conversation[] = [];
  for (const item of conversations) (Date.parse(activityAt(data, item)) >= cutoff ? recent : earlier).push(item);
  return { recent, earlier };
}
/** Show a conversation in the chat host without moving the main area. */
export function openDiscussion(researchId: string, conversationId: string) {
  workspace.selectConversation(researchId, conversationId, { surface: 'workbench' });
  workspace.updateData(next => {
    const session = next.sessions[researchId];
    session.panel.aiView = 'chat';
    if (session.agentChat?.mode !== 'float') session.agentChat = { ...session.agentChat, mode: 'side' };
  });
}

export function destinationLabel(data: WorkspaceData, conversation: Conversation) {
  const anchor = conversation.anchor;
  if (anchor?.kind === 'card') return `卡片「${data.cards[anchor.id]?.title ?? '已移除的卡片'}」的讨论`;
  if (anchor?.kind === 'board') return `白板「${data.boards[anchor.id]?.title ?? '已移除的白板'}」的讨论`;
  return `会话「${conversation.title?.trim() || '新会话'}」`;
}
/** Send the unsent message somewhere else: text, attachments and focus move together; histories stay where they are. */
export function routeResearchDraft(researchId: string, target: 'new' | string) {
  const data = workspace.getState().data, source = getActiveConversation(data, researchId);
  if (!source || !isResearchConversation(data, source)) throw new Error('当前会话不能改道，请新建会话后再试。');
  const destination = target === 'new' ? undefined : data.conversations[target];
  if (target !== 'new' && (!destination || destination.id === source.id || destination.researchId !== researchId || destination.archived || !isResearchConversation(data, destination))) throw new Error('目标会话不可用，未移动草稿。');
  // Check before creating anything so a refused move leaves no empty conversation behind.
  const images = [...(destination?.chatImages ?? []), ...(source.chatImages ?? [])];
  if (source.drawingQuestion && destination?.drawingQuestion) throw new Error('目标会话已有待发送的绘图选区，请先在那里发送或移除，草稿未移动。');
  if (images.length + (source.drawingQuestion || destination?.drawingQuestion ? 1 : 0) > CHAT_IMAGE_LIMITS.maxImages) throw new Error('合并后超过每条消息 4 张图片（绘图选区占一张），草稿未移动。');
  const carried = [...new Map([...(destination?.carried ?? []), ...(source.carried ?? [])].map(item => [item.id, item])).values()];
  if (carried.length > CARRIED_LIMIT) throw new Error(`合并后带入的讨论结论超过 ${CARRIED_LIMIT} 条，草稿未移动。`);
  const id = destination?.id ?? createResearchConversation(researchId, source.connectionId, { navigate: false });
  workspace.updateData(next => {
    const from = next.conversations[source.id], to = next.conversations[id];
    if (!destination && from.anchor) Object.assign(to, { anchor: { ...from.anchor }, title: from.title });
    to.input = [to.input?.trim(), from.input?.trim()].filter(Boolean).join('\n\n');
    if (images.length) to.chatImages = images;
    if (carried.length) to.carried = carried;
    if (from.drawingQuestion) { to.drawingQuestion = from.drawingQuestion; delete to.researchFocus; }
    else if (from.researchFocus && !to.drawingQuestion) to.researchFocus = from.researchFocus;
    from.input = ''; delete from.chatImages; delete from.drawingQuestion; delete from.researchFocus; delete from.carried;
    // A thread that only carried this draft would linger empty in the list; archive keeps it recoverable.
    if (!from.requestIds.length) from.archived = true;
  });
  workspace.selectConversation(researchId, id, { surface: 'workbench' });
  workspace.updateData(next => { next.sessions[researchId].panel.aiView = 'chat'; });
  return id;
}

/** Move a discussion into the main conversation list; it keeps its link to the card, board or passage. */
export function promoteDiscussion(researchId: string, conversationId: string) {
  workspace.updateData(data => {
    const conversation = data.conversations[conversationId];
    if (!conversation || conversation.researchId !== researchId || conversation.archived) throw new Error('这条讨论已不可用。');
    if (conversation.inlineSource) conversation.inlineSource.promoted = true;
    else if (conversation.anchor) conversation.promoted = true;
  });
}

export const CARRIED_LIMIT = 10;
/** A finished discussion answer as a carried material: question, answer and cited passages, traceable to its request. */
export function discussionMaterial(data: WorkspaceData, requestId: string): ResearchMaterial {
  const request = data.requests[requestId], conversation = request && data.conversations[request.conversationId];
  if (!request || !conversation || request.status !== 'done') throw new Error('只能带入已完成的回答。');
  const anchor = conversation.anchor, source = conversation.inlineSource, document = source && data.documents[source.documentId];
  const where = anchor?.kind === 'card' ? `卡片「${data.cards[anchor.id]?.title ?? '已移除的卡片'}」` : anchor?.kind === 'board' ? `白板「${data.boards[anchor.id]?.title ?? '已移除的白板'}」`
    : source ? `《${document?.title ?? '已移除的资料'}》第 ${source.pageIndex + 1} 页` : `会话「${conversation.title?.trim() || '新会话'}」`;
  const passage = (evidenceId: string) => { const item = data.evidence[evidenceId], doc = item && data.documents[item.documentId]; return item && doc ? `《${doc.title}》PDF 第 ${item.pageIndex + 1} 页：“${item.quote}”` : undefined; };
  const asked = [...new Set(request.context.map(item => item.evidenceId))].map(passage).filter(Boolean);
  const cited = request.evidenceIds.map((id, index) => passage(id) && `[${index + 1}] ${passage(id)}`).filter(Boolean);
  const text = [`问：${request.prompt}`, `答：${request.result?.body ?? request.body}`, asked.length ? `讨论所针对的原文：\n${asked.join('\n')}` : '', cited.length ? `回答中的引用：\n${cited.join('\n')}` : ''].filter(Boolean).join('\n\n');
  return { id: `discussion:${request.id}`, kind: 'discussion', title: `${where}的讨论 · 第 ${conversation.requestIds.indexOf(request.id) + 1} 轮`, text: text.slice(0, 20000), version: request.createdAt,
    ...(anchor ? { resourceRef: { ...anchor } } : source ? { resourceRef: { kind: 'document' as const, id: source.documentId } } : {}),
    derivedFrom: { sourceIds: [...new Set([...request.context.map(item => item.evidenceId), ...request.evidenceIds])].map(id => `evidence:${id}`), requestIds: [request.id] } };
}
/** Carry a discussion answer into a research conversation as material for its next question; histories stay separate. */
export function carryToConversation(researchId: string, requestId: string, target: 'new' | string) {
  const data = workspace.getState().data, material = discussionMaterial(data, requestId), source = data.conversations[data.requests[requestId].conversationId];
  if (source.researchId !== researchId) throw new Error('只能带入本研究的讨论。');
  const destination = target === 'new' ? undefined : data.conversations[target];
  if (target !== 'new' && (!destination || destination.id === source.id || destination.researchId !== researchId || destination.archived || !isResearchConversation(data, destination))) throw new Error('目标会话不可用，未带入。');
  if (destination && !destination.carried?.some(item => item.id === material.id) && (destination.carried?.length ?? 0) >= CARRIED_LIMIT) throw new Error(`每条消息最多带入 ${CARRIED_LIMIT} 条讨论结论，请先移除一条。`);
  const id = destination?.id ?? createResearchConversation(researchId, isResearchConversation(data, source) ? source.connectionId : 'codex', { navigate: false });
  workspace.updateData(next => {
    const to = next.conversations[id];
    to.carried = [...(to.carried ?? []).filter(item => item.id !== material.id), material];
  });
  workspace.selectConversation(researchId, id, { surface: 'workbench' });
  workspace.updateData(next => {
    const session = next.sessions[researchId];
    session.panel.aiView = 'chat';
    if (!session.agentChat || session.agentChat.mode === 'closed') session.agentChat = { ...session.agentChat, mode: 'side' };
  });
  return id;
}
export function removeCarried(researchId: string, materialId: string) {
  const conversation = getActiveConversation(workspace.getState().data, researchId);
  if (conversation) workspace.updateData(data => {
    const owner = data.conversations[conversation.id];
    owner.carried = owner.carried?.filter(item => item.id !== materialId);
    if (!owner.carried?.length) delete owner.carried;
  });
}

export function openResearchConversation(researchId: string, conversationId: string, options: { navigate?: boolean } = {}) {
  workspace.selectConversation(researchId, conversationId, { surface: 'workbench' });
  if (options.navigate !== false) workspace.openResearchView(researchId, 'home');
}

export function createResearchConversation(researchId: string, connectionId?: AIConnectionId, options: { navigate?: boolean } = {}) {
  const current = getActiveConversation(workspace.getState().data, researchId);
  const id = workspace.createConversation(researchId, { surface: 'workbench' });
  workspace.updateData(data => {
    Object.assign(data.conversations[id], { connectionId: connectionId ?? current?.connectionId ?? 'codex', title: '新会话' });
  });
  openResearchConversation(researchId, id, options);
  return id;
}

export function changeResearchAgent(researchId: string, connectionId: AIConnectionId) {
  const data = workspace.getState().data, current = getActiveConversation(data, researchId);
  if (current && (current.connectionId ?? 'codex') === connectionId) return current.id;
  if (current && isResearchConversation(data, current)) {
    if (current.requestIds.some(id => data.requests[id]?.status === 'generating')) throw new Error('请先停止当前回答，再切换助手。');
    workspace.updateData(next => { next.conversations[current.id].connectionId = connectionId; });
    return current.id;
  }
  const id = createResearchConversation(researchId, connectionId);
  workspace.notice('已为所选助手新开会话，原话题、未发送文字和修改目标均已保留。');
  return id;
}

export function focusResearchResource(researchId: string, ref: ResourceRef) {
  const conversation = workspace.getActiveConversation(researchId);
  workspace.updateData(data => {
    if (!ownsResource(data, researchId, ref)) throw new Error('这个内容不属于当前研究。');
    const entity = ref.kind === 'draft' ? data.drafts[ref.id] : ref.kind === 'card' ? data.cards[ref.id] : undefined;
    const body = entity?.body ?? (ref.kind === 'research' ? data.researches[ref.id].question : ref.kind === 'document' ? `文献：${data.documents[ref.id]?.title}` : `白板：${data.boards[ref.id]?.title}`);
    data.conversations[conversation.id].researchFocus = { ref: { ...ref }, title: resourceTitle(data, ref).slice(0, 2000), body: body.slice(0, 12000) };
    delete data.conversations[conversation.id].drawingQuestion;
  });
}
export function clearResearchFocus(researchId: string) {
  const conversation = getActiveConversation(workspace.getState().data, researchId);
  if (conversation) workspace.updateData(data => { delete data.conversations[conversation.id].researchFocus; });
}

function draftMatches(draft: Draft, title: string, body: string, evidenceIds: string[]) {
  return draft.title === title && draft.body === body && JSON.stringify(draft.evidenceIds) === JSON.stringify(evidenceIds);
}
export function applyResearchSuggestion(requestId: string) {
  workspace.updateData(data => {
    const run = data.requests[requestId]?.researchRun, suggestion = run?.suggestion;
    const draft = run?.draftId ? data.drafts[run.draftId] : undefined;
    if (!draft || !suggestion || !draftMatches(draft, suggestion.baseTitle, suggestion.baseBody, suggestion.baseEvidenceIds)) throw new Error('你已继续编辑正文，这份建议基于旧版本，请重新提出修改要求。');
    run!.previous = { title: draft.title, body: draft.body, evidenceIds: [...draft.evidenceIds], appliedTitle: suggestion.title, appliedBody: suggestion.body, appliedEvidenceIds: [...suggestion.evidenceIds] };
    Object.assign(draft, { title: suggestion.title, body: suggestion.body, evidenceIds: [...suggestion.evidenceIds], updatedAt: new Date().toISOString() });
    delete run!.suggestion;
  });
}
export function keepResearchDraft(requestId: string) { workspace.updateData(data => { if (data.requests[requestId]?.researchRun) delete data.requests[requestId].researchRun!.suggestion; }); }
export function undoResearchSuggestion(requestId: string) {
  workspace.updateData(data => {
    const run = data.requests[requestId]?.researchRun, previous = run?.previous;
    const draft = run?.draftId ? data.drafts[run.draftId] : undefined;
    if (!draft || !previous || !draftMatches(draft, previous.appliedTitle, previous.appliedBody, previous.appliedEvidenceIds)) throw new Error('正文在采用后已继续编辑，不能撤销覆盖你的修改。');
    Object.assign(draft, { title: previous.title, body: previous.body, evidenceIds: [...previous.evidenceIds], updatedAt: new Date().toISOString() });
    delete run!.previous;
  });
}

async function verifyAssets(data: WorkspaceData, sources: ResearchAgentSource[], signal: AbortSignal) {
  for (const source of sources.filter(source => source.pages.length)) {
    aborted(signal);
    const doc = data.documents[source.id];
    if (!doc?.assetId || doc.hash !== source.hash) throw new Error('来源文件在运行中发生变化，请重新提交。');
    const asset = await getAsset(doc.assetId);
    if (!asset || await contentHash(await asset.arrayBuffer()) !== source.hash) throw new Error('原文件已缺失或改变，未写入结果。');
  }
}

export async function streamResearchRun(input: ResearchAgentInput, signal: AbortSignal, onEvent: (event: ResearchAgentEvent) => void) {
  const response = await fetch('/api/ai/research/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || '研究运行未启动，请检查连接。'); }
  if (!response.body) throw new Error('研究服务没有返回事件流。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const consume = () => { let end: number; while ((end = buffer.indexOf('\n')) >= 0) { if (end > 2100000) throw new Error('研究事件过大，已停止接收。'); const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (line) onEvent(JSON.parse(line)); } if (buffer.length > 2100000) throw new Error('研究事件过大，已停止接收。'); };
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; aborted(signal); buffer += decoder.decode(chunk.value, { stream: true }); consume(); } buffer += decoder.decode(); consume(); if (buffer.trim()) onEvent(JSON.parse(buffer)); }
  finally { reader.releaseLock(); }
}

export function stopResearchRun(requestId: string) {
  const controller = running.get(requestId);
  if (!controller) return;
  controller.abort();
  workspace.updateData(data => { const request = data.requests[requestId]; if (request?.status === 'generating') { request.status = 'stopped'; request.error = '已停止，本轮问题、附件和已收到内容已保留。'; } });
}
export async function stopAllResearchRuns() {
  for (const id of running.keys()) stopResearchRun(id);
  while (running.size) await new Promise(resolve => setTimeout(resolve, 20));
}

function researchHistoryBody(request: AIRequest) {
  const imageCount = (request.researchRun?.chatImages?.length ?? 0) + (request.researchRun?.drawingQuestion?.mode === 'image' ? 1 : 0);
  const body = `${request.result?.body ?? request.body}${imageCount ? `\n（此历史轮曾附 ${imageCount} 张图片，本轮未重新附送，不代表当前仍能看见原图。）` : ''}`;
  const searches = request.researchRun?.literatureSearches?.filter(search => search.status === 'done');
  if (!searches?.length) return body;
  const catalog = searches.map(search => ({ ...search, candidates: search.candidates.map((candidate, index) => ({ position: index + 1, ...candidate })) }));
  return `${body}\n\n历史文献题录与摘要（仅供延续对话，未读 PDF，不构成本轮原文证据；候选按 position 顺序排列）：\n${JSON.stringify(catalog)}`;
}

export async function submitResearchRun(researchId: string, prompt: string, retryId?: string) {
  const conversation = workspace.getActiveConversation(researchId);
  if (!isResearchConversation(workspace.getState().data, conversation)) throw new Error('这段原有会话使用经典上下文，请到经典工作台继续，或新建研究会话。');
  const pending = Object.values(workspace.getState().data.requests).find(request => request.researchId === researchId && request.status === 'generating');
  if (pending) throw new Error(`会话「${workspace.getState().data.conversations[pending.conversationId]?.title ?? '当前话题'}」仍在执行，请等待完成或切回停止。`);
  const snapshot = structuredClone(workspace.getState().data), generation = workspace.getGeneration();
  const connectionId: AIConnectionId = conversation.connectionId ?? 'codex';
  const controller = new AbortController(), signal = controller.signal, id = uid('request');
  const previous = retryId ? snapshot.requests[retryId] : undefined;
  if (retryId && (!previous || previous.researchId !== researchId || previous.conversationId !== conversation.id || !previous.researchRun)) throw new Error('只能在原会话中重试这一轮。');
  const drawingQuestion = retryId ? previous?.researchRun?.drawingQuestion : snapshot.conversations[conversation.id].drawingQuestion;
  if (drawingQuestion) validateDrawingQuestion(drawingQuestion);
  const chatImages = structuredClone((retryId ? previous?.researchRun?.chatImages : snapshot.conversations[conversation.id].chatImages) ?? []);
  validateChatImages(chatImages);
  if (chatImages.length + (drawingQuestion?.mode === 'image' ? 1 : 0) > CHAT_IMAGE_LIMITS.maxImages) throw new Error('每条消息最多附 4 张图片，包含所选绘图。');
  const carried = structuredClone((retryId ? previous?.materials?.filter(item => item.kind === 'discussion') : snapshot.conversations[conversation.id].carried) ?? []);
  validateResearchMaterials(carried);
  const requestPrompt = prompt.trim() || (chatImages.length || drawingQuestion?.mode === 'image' ? DEFAULT_IMAGE_PROMPT : '');
  if (!requestPrompt) throw new Error('请输入研究目标或添加图片。');
  const selectedFocus = drawingQuestion ? undefined : retryId ? previous?.researchRun?.focus : snapshot.conversations[conversation.id].researchFocus;
  if (selectedFocus && !ownsResource(snapshot, researchId, selectedFocus.ref)) throw new Error('追问对象已缺失或不属于此研究，请清除后重新选择。');
  const focusedEntity = selectedFocus?.ref.kind === 'draft' ? snapshot.drafts[selectedFocus.ref.id] : selectedFocus?.ref.kind === 'card' ? snapshot.cards[selectedFocus.ref.id] : undefined;
  const focus = selectedFocus && { ...selectedFocus, title: (focusedEntity?.title ?? selectedFocus.title).slice(0, 2000), body: (focusedEntity?.body ?? selectedFocus.body).slice(0, 12000) };
  const target = focus?.ref.kind === 'draft' ? structuredClone(snapshot.drafts[focus.ref.id]) : undefined;
  const historyTurns = previous ? structuredClone(previous.history ?? []) : conversation.requestIds.map(key => snapshot.requests[key]).filter(item => item?.status === 'done' && item.researchRun && !item.validationError && !item.superseded).map(item => ({ requestId: item.id, prompt: item.prompt, body: researchHistoryBody(item), evidenceIds: [], context: [] }));
  const history = historyTurns.map(item => ({ prompt: item.prompt, body: item.body }));
  if (history.length > 4096) throw new Error('本会话超过 4,096 轮的传输上限，未删除历史或发送。请保留草稿后新建会话。');
  if (history.reduce((sum, turn) => sum + turn.prompt.length + turn.body.length, 0) > RESEARCH_HISTORY_CHAR_LIMIT) throw new Error('前序对话超过 80,000 字符，未截断或发送。请新建会话，并明确附上需要继续讨论的内容。');
  const imageMetadata = chatImages.map(({ assetId, hash, name, mimeType, size }) => ({ assetId, hash, name, mimeType, size }));
  const inputChars = JSON.stringify({ prompt: requestPrompt, history, ...(focus ? { focus } : {}), ...(drawingQuestion ? { drawing: drawingQuestion.snapshot } : {}), ...(imageMetadata.length ? { images: imageMetadata } : {}), ...(carried.length ? { materials: carried } : {}) }).length + 2048;
  if (inputChars > RESEARCH_INPUT_CHAR_LIMIT) throw new Error('问题、历史、局部目标与绘图结构超过 120,000 字符，未发送。请减少本轮内容或新建会话。字符上限不是模型 token 预算。');
  const request: AIRequest = { id, researchId, conversationId: conversation.id, connectionId, prompt: requestPrompt, context: [], history: historyTurns, createdAt: new Date().toISOString(), status: 'generating', body: '', evidenceIds: [], purpose: 'chat', mode: 'live', ...(retryId ? { retryOf: retryId } : {}), ...(carried.length ? { materials: carried } : {}), researchRun: { ...(focus ? { focus: structuredClone(focus) } : {}), ...(drawingQuestion ? { drawingQuestion: structuredClone(drawingQuestion) } : {}), ...(chatImages.length ? { chatImages } : {}) } };
  running.set(id, controller);
  let consumedInput = false, consumedDrawing = false, consumedImages = false, consumedCarried = false;
  workspace.updateData(data => {
    data.requests[id] = request; data.conversations[conversation.id].requestIds.push(id); data.conversations[conversation.id].connectionId = connectionId;
    data.sessions[researchId].agentWorkbenchStarted = true;
    if (!previous) delete data.conversations[conversation.id].researchFocus;
    const owner = data.conversations[conversation.id];
    if ((owner.input ?? '') === prompt) { owner.input = ''; consumedInput = true; }
    if (drawingQuestion && owner.drawingQuestion?.snapshot.id === drawingQuestion.snapshot.id && owner.drawingQuestion.snapshot.hash === drawingQuestion.snapshot.hash && owner.drawingQuestion.mode === drawingQuestion.mode) { delete owner.drawingQuestion; consumedDrawing = true; }
    if (chatImages.length && owner.chatImages?.some(image => chatImages.some(sent => sent.assetId === image.assetId && sent.hash === image.hash))) {
      owner.chatImages = owner.chatImages.filter(image => !chatImages.some(sent => sent.assetId === image.assetId && sent.hash === image.hash));
      if (!owner.chatImages.length) delete owner.chatImages;
      consumedImages = true;
    }
    if (carried.length && owner.carried?.some(item => carried.some(sent => sent.id === item.id))) {
      owner.carried = owner.carried.filter(item => !carried.some(sent => sent.id === item.id));
      if (!owner.carried.length) delete owner.carried;
      consumedCarried = true;
    }
    owner.updatedAt = request.createdAt;
    if (!owner.title || ['新会话', '新的阅读对话', '阅读对话'].includes(owner.title)) owner.title = request.prompt.slice(0, 36);
  });
  const current = () => workspace.getGeneration() === generation && workspace.getState().data.requests[id]?.status === 'generating';
  const progress = (text: string) => { if (current()) workspace.updateData(data => { data.requests[id].events = [{ id: uid('event'), kind: 'status', text }]; }); };
  try {
    const capabilities = await getResearchAgentCapabilities(); aborted(signal);
    const capability = capabilities.find(item => item.id === connectionId);
    if (!capability?.research) throw new Error(capability?.detail || '这个连接尚不支持研究工具。请切换 Codex，或回到经典工作台继续使用原连接。');
    if ((chatImages.length || drawingQuestion?.mode === 'image') && capability.images !== true) throw new Error('这个连接未确认支持图片，附件和输入已保留。请选择支持图片的助手，或移除普通图片、明确选择绘图仅发送文字和结构。');
    const images: NonNullable<ResearchAgentInput['images']> = [];
    for (const image of imageMetadata) {
      const blob = await loadChatImage(image); aborted(signal);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      images.push({ ...image, dataUrl: `data:${image.mimeType};base64,${btoa(binary)}` });
    }
    let drawing: ResearchAgentInput['drawing'];
    if (drawingQuestion) {
      const image = await loadDrawingImage(drawingQuestion.snapshot);
      aborted(signal);
      let imageDataUrl: string | undefined;
      if (drawingQuestion.mode === 'image') {
        const bytes = new Uint8Array(await image.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        imageDataUrl = `data:image/png;base64,${btoa(binary)}`;
      }
      drawing = { ...structuredClone(drawingQuestion), ...(imageDataUrl ? { imageDataUrl } : {}) };
    }
    const { sources, summary } = drawingQuestion
      ? { sources: [] as ResearchAgentSource[], summary: `本次附送 ${drawingQuestion.snapshot.elements.length} 个选中元素、${drawingTextLength(drawingQuestion.snapshot)} 字符的文字和结构${drawingQuestion.mode === 'image' ? '及一张局部图片' : '（仅文字模式，Agent 未看图）'}；未追加论文原文。` }
      : await collectResearchSources(snapshot, researchId, signal, progress, focus?.ref.kind === 'document' ? focus.ref.id : undefined);
    aborted(signal); if (!current()) return id;
    workspace.updateData(data => {
      data.requests[id].researchRun!.sourceSummary = `${summary}${chatImages.length ? `另附 ${chatImages.length} 张原始图片，图片内容不作为论文原文证据。` : ''}${carried.length ? `另附 ${carried.length} 条从其他讨论带入的结论，仅作参考材料，不作为论文原文证据。` : ''}附送当前会话全部 ${history.length} 轮已完成研究对话（历史最多 80,000 字符；单次输入合计最多 120,000 字符，超限会明确提示，不静默截断）。${focus ? '局部对象正文最多发送前 12,000 字符。' : ''}`;
      for (const source of sources.filter(source => source.pages.length)) {
        const doc = data.documents[source.id], original = snapshot.documents[source.id];
        if (!data.researches[researchId].documentIds.includes(source.id) || !doc || doc.assetId !== original.assetId || doc.hash !== original.hash) throw new Error('研究资料在准备中发生变化，请重新提交。');
        if (!doc.hash) { doc.hash = source.hash; doc.pageCount = source.totalPages; doc.textStatus = 'ready'; }
      }
    });
    let artifact: ResearchAgentArtifact | undefined, completed: Extract<ResearchAgentEvent, { type: 'done' }> | undefined;
    await streamResearchRun({ requestId: id, researchId, connectionId, prompt: request.prompt, sources, history, ...(focus ? { focus } : {}), ...(drawing ? { drawing } : {}), ...(images.length ? { images } : {}), ...(carried.length ? { materials: carried } : {}) }, signal, event => {
      if (!current() || signal.aborted) return;
      if (event.type === 'error') throw new Error(event.error);
      if (event.type === 'literature') {
        validateResearchLiteratureSearch(event.search);
        workspace.updateData(data => {
          const searches = data.requests[id].researchRun!.literatureSearches ??= [];
          const index = searches.findIndex(search => search.id === event.search.id);
          if (index >= 0) searches[index] = structuredClone(event.search);
          else { if (searches.length >= 3) throw new Error('本轮文献检索次数异常。'); searches.push(structuredClone(event.search)); }
        });
      } else if (event.type === 'progress') progress(event.text);
      else if (event.type === 'delta') workspace.updateData(data => { data.requests[id].body += event.text; });
      else if (event.type === 'artifact') { validateResearchArtifact(workspace.getState().data, researchId, sources, event.artifact); artifact = event.artifact; }
      else if (event.type === 'done') completed = event;
    });
    aborted(signal); if (!current()) return id;
    if (!completed) throw new Error('研究连接意外中断，未收到完成确认。');
    await verifyAssets(workspace.getState().data, sources, signal); aborted(signal); if (!current()) return id;
    if (drawingQuestion) { await loadDrawingImage(drawingQuestion.snapshot); aborted(signal); if (!current()) return id; }
    for (const image of chatImages) { await loadChatImage(image); aborted(signal); if (!current()) return id; }
    const done = completed as Extract<ResearchAgentEvent, { type: 'done' }>;
    if (artifact) {
      validateResearchArtifact(workspace.getState().data, researchId, sources, artifact);
      if (artifact.citations.some(citation => !done.readPages.some(page => page.documentId === citation.documentId && page.pageIndex === citation.pageIndex))) throw new Error('结果引用了 Agent 未实际读取的页，未写入成果。');
    }
    let openDraftId: string | undefined;
    workspace.updateData(data => {
      const saved = data.requests[id];
      saved.model = done.model; saved.nativeSessionId = done.nativeSessionId; saved.researchRun!.readPages = done.readPages;
      if (artifact) {
        const used = new Set<string>();
        const evidenceIds = artifact.citations.map(citation => {
          const existing = Object.values(data.evidence).find(item => !used.has(item.id) && item.documentId === citation.documentId && item.pageIndex === citation.pageIndex && item.quote === citation.quote);
          if (existing) { used.add(existing.id); return existing.id; }
          const evidenceId = uid('evidence'); data.evidence[evidenceId] = { id: evidenceId, researchId, documentId: citation.documentId, pageIndex: citation.pageIndex, quote: citation.quote, createdAt: new Date().toISOString() }; used.add(evidenceId); return evidenceId;
        });
        saved.context = artifact.citations.map((citation, index) => ({ evidenceId: evidenceIds[index], documentId: citation.documentId, documentHash: citation.documentHash, title: data.documents[citation.documentId].title, pageIndex: citation.pageIndex, quote: citation.quote }));
        saved.evidenceIds = evidenceIds;
        saved.result = { title: artifact.title, body: artifact.body, evidenceIds };
        if (target) {
          if (!data.drafts[target.id] || data.drafts[target.id].researchId !== researchId) throw new Error('原成果已不存在，未覆盖其他内容。');
          saved.researchRun!.draftId = target.id;
          saved.researchRun!.suggestion = { ...saved.result, baseTitle: target.title, baseBody: target.body, baseEvidenceIds: [...target.evidenceIds] };
          saved.body = '已提出修改建议，原成果保持可编辑。';
        } else {
          openDraftId = uid('draft');
          data.drafts[openDraftId] = { id: openDraftId, researchId, ...saved.result, updatedAt: new Date().toISOString() };
          saved.researchRun!.draftId = openDraftId; saved.body = '已整理为可编辑成果，引用可回到原文。';
        }
      } else {
        if (!saved.body.trim()) throw new Error('Agent 未返回回答或成果，请重试。');
        mapCitationNumbers(saved.body, () => { throw new Error('回答提供了未建立原文映射的引用，请重试生成带引用的成果。'); });
      }
      saved.status = 'done';
      data.conversations[conversation.id].updatedAt = new Date().toISOString();
      if (data.researches[researchId].title === '新研究') data.researches[researchId].title = request.prompt.slice(0, 30);
    });
    const view = workspace.getState().data;
    const viewingReply = view.scope.kind === 'research' && view.scope.researchId === researchId && getActiveConversation(view, researchId)?.id === conversation.id && view.sessions[researchId].active.kind === 'researchView' && view.sessions[researchId].active.id === 'home';
    if (openDraftId && !viewingReply) workspace.notice(`会话「${view.conversations[conversation.id].title}」的成果已保存，可打开编辑和核查引用。`);
  } catch (error) {
    const stopped = signal.aborted; controller.abort();
    if (current()) workspace.updateData(data => { data.requests[id].status = stopped ? 'stopped' : 'error'; data.requests[id].error = error instanceof Error ? error.message : '研究执行失败，本轮问题、附件和已收到内容已保留。'; });
  } finally {
    if (workspace.getGeneration() === generation) {
      workspace.updateData(data => {
        const saved = data.requests[id];
        for (const search of saved?.researchRun?.literatureSearches ?? []) if (search.status === 'searching') {
          search.status = saved.status === 'stopped' ? 'stopped' : 'interrupted';
          search.error = saved.status === 'stopped' ? '检索已停止，已完成的候选仍保留。' : '未收到检索完成确认，可以在当前会话重试。';
        }
      });
      const saved = workspace.getState().data.requests[id];
      if (saved && ['error', 'stopped'].includes(saved.status) && !saved.body.trim() && !saved.result && (consumedInput || consumedDrawing || consumedImages || consumedCarried)) workspace.updateData(data => {
        const owner = data.conversations[conversation.id];
        if (!owner || owner.requestIds.at(-1) !== id || (owner.input ?? '') !== '' || owner.drawingQuestion || owner.researchFocus || owner.chatImages?.length || owner.carried?.length) return;
        if (consumedInput) owner.input = prompt;
        if (consumedDrawing) owner.drawingQuestion = structuredClone(drawingQuestion);
        if (consumedImages) owner.chatImages = structuredClone(chatImages);
        if (consumedCarried) owner.carried = structuredClone(carried);
      });
      workspace.retrySave();
      try { await workspace.flushSave(); } catch { /* The shared save indicator retains the failure and retry action. */ }
    }
    running.delete(id);
  }
  return id;
}

export function researchAgentConversation(researchId: string) {
  const data = workspace.getState().data;
  return getActiveConversation(data, researchId);
}
