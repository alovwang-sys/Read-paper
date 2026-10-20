import type { WorkspaceData } from './types';

export type ResearchResourceKind = 'board' | 'draft' | 'card';

export function researchResourceIds(data: WorkspaceData, researchId: string, kind: ResearchResourceKind): string[] {
  const research = data.researches[researchId];
  if (!research || !['board', 'draft', 'card'].includes(kind)) return [];
  if (kind === 'card') return research.cardIds.filter(id => !!data.cards[id]);
  const resources = kind === 'board' ? data.boards : data.drafts;
  const ids = Object.values(resources).filter(item => item.researchId === researchId).map(item => item.id);
  const available = new Set(ids);
  const order = kind === 'board' ? research.boardOrder : research.draftOrder;
  return [...new Set([...(order ?? []).filter(id => available.has(id)), ...ids])];
}
