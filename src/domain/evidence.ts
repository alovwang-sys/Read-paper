import type { Evidence, WorkspaceData } from './types';

export type EvidenceFragment = Pick<Evidence, 'documentId' | 'pageIndex' | 'quote' | 'kind' | 'region' | 'textAnchor'>;

export function pageRangeLabel(indices: number[]): string {
  const pages = [...new Set(indices)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i];
    while (i + 1 < pages.length && pages[i + 1] === pages[i] + 1) i++;
    ranges.push(start === pages[i] ? `${start + 1}` : `${start + 1}–${pages[i] + 1}`);
  }
  return `PDF 第 ${ranges.join('、')} 页`;
}

export function evidenceGroup(data: WorkspaceData, evidence: Evidence): Evidence[] {
  return evidence.selectionGroupId ? Object.values(data.evidence).filter(item => item.selectionGroupId === evidence.selectionGroupId
    && item.documentId === evidence.documentId && item.researchId === evidence.researchId).sort((a, b) => a.pageIndex - b.pageIndex) : [evidence];
}

export function matchesEvidence(evidence: Evidence, fragment: EvidenceFragment): boolean {
  return evidence.documentId === fragment.documentId && evidence.pageIndex === fragment.pageIndex
    && (fragment.kind === 'region' ? evidence.kind === 'region' && evidence.region?.hash === fragment.region?.hash
      && evidence.region?.rotation === fragment.region?.rotation && JSON.stringify(evidence.region?.rect) === JSON.stringify(fragment.region?.rect)
      : evidence.kind !== 'region' && evidence.quote === fragment.quote.trim()
        && (fragment.textAnchor ? evidence.textAnchor?.start === fragment.textAnchor.start && evidence.textAnchor?.end === fragment.textAnchor.end : !evidence.textAnchor));
}

export function findEvidenceSelection(data: WorkspaceData, researchId: string, fragments: EvidenceFragment[]): Evidence[] | undefined {
  for (const evidence of Object.values(data.evidence)) {
    if (evidence.researchId !== researchId || !matchesEvidence(evidence, fragments[0])) continue;
    const group = evidenceGroup(data, evidence);
    if (group.length === fragments.length && group.every((item, index) => matchesEvidence(item, fragments[index]))) return group;
  }
}
