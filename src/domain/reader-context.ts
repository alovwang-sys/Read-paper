import type { PaperBrief, PaperBriefSnapshot, TextSourceAnchor, WorkspaceData } from './types';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit;
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function validateTextAnchor(value: unknown): asserts value is TextSourceAnchor {
  check(record(value) && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
    && Number(value.start) >= 0 && Number(value.end) > Number(value.start) && Number(value.end) <= 10000000
    && (value.prefix === undefined || text(value.prefix, 200)) && (value.suffix === undefined || text(value.suffix, 200)), '原文位置记录损坏，未覆盖已有资料。');
}
export function validatePaperBrief(value: unknown, snapshot = false): asserts value is PaperBrief | PaperBriefSnapshot {
  check(record(value) && text(value.key, 500) && text(value.documentId, 200) && typeof value.documentHash === 'string' && /^[a-f0-9]{64}$/.test(value.documentHash)
    && Number.isSafeInteger(value.version) && Number(value.version) > 0 && value.schema === 1 && text(value.extractionVersion, 200)
    && text(value.body, 6000) && Number.isInteger(value.totalPages) && Number(value.totalPages) >= (snapshot || value.status === 'ready' ? 1 : 0)
    && text(value.createdAt, 100) && Number.isFinite(Date.parse(String(value.createdAt)))
    && ['model', 'demo', 'codex', 'claude', 'opencode'].includes(String(value.connectionId))
    && (value.model === undefined || text(value.model, 500)) && (value.error === undefined || text(value.error, 4000)), '文章简要记录损坏，未覆盖已有资料。');
  for (const field of ['pageIndices', 'truncatedPageIndices']) {
    const indices = value[field];
    check(Array.isArray(indices) && indices.length <= 24 && new Set(indices).size === indices.length
      && indices.every(index => Number.isInteger(index) && index >= 0 && index < Number(value.totalPages)), '文章简要覆盖页记录损坏。');
  }
  check((value.truncatedPageIndices as number[]).every(index => (value.pageIndices as number[]).includes(index)), '文章简要截断页记录损坏。');
  if (!snapshot) check(['preparing', 'ready', 'error'].includes(String(value.status)), '文章简要状态损坏。');
  if (snapshot || value.status === 'ready') check(!!value.body && (value.pageIndices as number[]).length > 0, '文章简要正文或覆盖范围缺失。');
}

export function validateReaderContext(data: WorkspaceData, recover = false) {
  for (const doc of Object.values(data.documents)) if (doc.paperBrief) {
    try {
      validatePaperBrief(doc.paperBrief);
      check(doc.paperBrief.documentId === doc.id && doc.paperBrief.documentHash === doc.hash, '文章简要与论文版本不一致。');
    } catch (problem) {
      if (!recover) throw problem;
      delete doc.paperBrief;
      continue;
    }
    if (recover && doc.paperBrief.status === 'preparing') { doc.paperBrief.status = 'error'; doc.paperBrief.error = '上次简要生成已中断，可重新提问。'; }
  }
  for (const evidence of Object.values(data.evidence)) {
    if (evidence.textAnchor) validateTextAnchor(evidence.textAnchor);
    if (evidence.readerActions !== undefined) {
      check(Array.isArray(evidence.readerActions) && evidence.readerActions.length <= 10000, '原文操作记录损坏。');
      const ids = new Set<string>();
      for (const action of evidence.readerActions) {
        check(record(action) && text(action.id, 200) && !!action.id && !ids.has(action.id) && ['excerpt', 'highlight', 'card'].includes(action.kind)
          && Number.isFinite(Date.parse(action.createdAt)) && (action.refId === undefined || text(action.refId, 200)), '原文操作记录损坏。');
        ids.add(action.id);
      }
    }
  }
  for (const conversation of Object.values(data.conversations)) {
    if (conversation.paperBrief) { validatePaperBrief(conversation.paperBrief, true); check(conversation.inlineSource?.documentId === conversation.paperBrief.documentId, '局部会话的文章简要归属不正确。'); }
    if (conversation.inlineSource?.operation !== undefined) check(['question', 'translation', 'summary'].includes(conversation.inlineSource.operation), '原文操作类型损坏。');
  }
  for (const request of Object.values(data.requests)) {
    if (request.paperBrief) { validatePaperBrief(request.paperBrief, true); check(request.context.some(source => source.documentId === request.paperBrief!.documentId && source.documentHash === request.paperBrief!.documentHash), '当轮文章简要与原文版本不一致。'); }
    if (request.readerOperation !== undefined) check(['question', 'translation', 'summary'].includes(request.readerOperation) && request.context.some(source => source.evidenceId === request.readerEvidenceId), '当轮原文操作来源不正确。');
    if (request.paperBriefState !== undefined) check(['preparing', 'selection-only', 'error'].includes(request.paperBriefState), '当轮文章简要状态损坏。');
  }
  for (const session of Object.values(data.sessions)) if (session.agentChat) {
    check(record(session.agentChat) && ['main', 'side', 'float', 'closed'].includes(session.agentChat.mode), '聊天位置记录损坏。');
    if (session.agentChat.rect) check(['left', 'top', 'width', 'height'].every(key => Number.isFinite(session.agentChat!.rect![key as 'left'])) && session.agentChat.rect.width > 0 && session.agentChat.rect.height > 0, '聊天浮窗尺寸损坏。');
  }
}
