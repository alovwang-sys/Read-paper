import type { ReaderActivity, ReaderManualAction, WorkspaceData } from '../domain/types';
import { uid, workspace } from './workspace';
export type { ReaderActivity } from '../domain/types';

export function recordReaderAction(evidenceId: string, kind: ReaderManualAction['kind'], refId?: string) {
  workspace.updateData(data => {
    const evidence = data.evidence[evidenceId];
    if (!evidence) throw new Error('这处原文已不存在。');
    evidence.readerActions ??= [];
    if (evidence.readerActions.some(action => action.kind === kind && action.refId === refId)) return;
    evidence.readerActions.push({ id: uid('reader-action'), kind, createdAt: new Date().toISOString(), ...(refId ? { refId } : {}) });
  });
}

/** Requests and card drafts remain the single source for operation status and results. */
export function readerActivities(data: WorkspaceData, evidenceId: string): ReaderActivity[] {
  const evidence = data.evidence[evidenceId];
  if (!evidence) return [];
  const manual: ReaderActivity[] = (evidence.readerActions ?? []).map(action => ({ ...action, status: 'done',
    ...(action.kind === 'card' && action.refId ? { cardId: action.refId, body: data.cards[action.refId]?.body } : {}) }));
  const requests = Object.values(data.requests).filter(request => (!request.purpose || request.purpose === 'chat') && !request.superseded
    && (request.readerEvidenceId === evidenceId || data.conversations[request.conversationId]?.inlineSource?.evidenceId === evidenceId));
  if (!evidence.contextOnly && !evidence.annotationHidden && !manual.length && !requests.length)
    manual.push({ id: `excerpt:${evidence.id}`, kind: 'excerpt', status: 'done', createdAt: evidence.createdAt ?? '' });
  const generated: ReaderActivity[] = requests.map(request => {
    const draft = Object.values(data.cardDrafts).find(item => item.source.requestId === request.id);
    return { id: request.id, kind: request.readerOperation ?? data.conversations[request.conversationId]?.inlineSource?.operation ?? 'question',
      createdAt: request.createdAt, status: draft?.status === 'error' ? 'error' : draft && draft.status !== 'saved' ? 'draft' : request.status,
      conversationId: request.conversationId, requestId: request.id, ...(draft ? { draftId: draft.id, cardId: draft.cardId } : {}),
      body: request.body, error: draft?.error ?? request.error };
  });
  return [...manual, ...generated].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
