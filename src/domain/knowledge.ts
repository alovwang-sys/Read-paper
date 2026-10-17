import { mapCitationNumbers } from './citations';
import type { PaperDocument, WorkspaceData } from './types';

export function hasFullText(doc: PaperDocument | undefined): doc is PaperDocument & {
  filename: string; hash: string; assetId: string; pageCount: number;
} {
  return !!doc && typeof doc.filename === 'string' && typeof doc.hash === 'string' &&
    typeof doc.assetId === 'string' && !!doc.assetId && Number.isInteger(doc.pageCount) && doc.pageCount! > 0;
}

export function normalizeIdentifier(raw: string): { kind: 'doi' | 'arxiv' | 'url'; value: string } | undefined {
  const text = raw.trim();
  const doi = text.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  if (/^10\.\d{4,9}\/\S+$/i.test(doi)) return { kind: 'doi', value: doi.toLowerCase() };
  const arxiv = text.replace(/^(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)/i, '').replace(/\.pdf$/i, '').replace(/v\d+$/i, '');
  if (/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/i.test(arxiv)) return { kind: 'arxiv', value: arxiv.toLowerCase() };
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.hash = '';
    return { kind: 'url', value: url.href };
  } catch { return undefined; }
}

function citationNumbers(body: string) {
  const numbers = new Set<number>();
  mapCitationNumbers(body, number => { numbers.add(number); return ''; });
  return numbers;
}

export type ConclusionIssue = {
  kind: 'no-evidence' | 'needs-review' | 'missing-citation' | 'invalid-citation';
  draftId: string; cardId?: string; evidenceId?: string; citationNumber?: number; message: string;
};
export function conclusionIssues(data: WorkspaceData, researchId: string): ConclusionIssue[] {
  const issues: ConclusionIssue[] = [];
  for (const draft of Object.values(data.drafts).filter(d => d.researchId === researchId)) {
    for (const cardId of new Set((draft.cardRefs ?? []).map(ref => ref.cardId))) {
      const card = data.cards[cardId];
      if (!card || !card.evidenceIds.length) issues.push({ kind: 'no-evidence', draftId: draft.id, cardId, message: `「${card?.title ?? '缺失的卡片'}」没有论文依据` });
      else {
        if (card.needsReview) issues.push({ kind: 'needs-review', draftId: draft.id, cardId, message: `「${card.title}」仍待核查` });
        if (card.evidenceIds.some(id => !draft.evidenceIds.includes(id) || !citationNumbers(draft.body).has(draft.evidenceIds.indexOf(id) + 1)))
          issues.push({ kind: 'missing-citation', draftId: draft.id, cardId, message: `「${card.title}」的新依据还没有引用到文稿` });
      }
    }
    const numbers = new Set<number>();
    mapCitationNumbers(draft.body, number => { numbers.add(number); return ''; });
    for (const number of numbers) {
      const evidenceId = draft.evidenceIds[number - 1];
      const evidence = data.evidence[evidenceId];
      const doc = evidence && data.documents[evidence.documentId];
      if (!evidence || !hasFullText(doc) || evidence.pageIndex < 0 || evidence.pageIndex >= doc.pageCount)
        issues.push({ kind: 'invalid-citation', draftId: draft.id, evidenceId, citationNumber: number, message: `「${draft.title}」的 [${number}] 来源或原文资产缺失` });
    }
  }
  return issues;
}

export function researchEvidence(data: WorkspaceData, researchId: string) {
  const documents = data.researches[researchId]?.documentIds ?? [];
  return Object.values(data.evidence).filter(e => documents.includes(e.documentId) && (!e.researchId || e.researchId === researchId));
}
