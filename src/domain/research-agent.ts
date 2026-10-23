import type { AIConnectionId, ChatImageAttachment, DrawingQuestion, LiteratureSearch, ResearchMaterial, ResourceRef } from './types';
import { validateLiteratureCandidate } from './research';

export type ResearchLiteratureSearch = Pick<LiteratureSearch, 'id' | 'query' | 'yearFrom' | 'yearTo' | 'createdAt' | 'status' | 'candidates' | 'error' | 'errorCode' | 'warnings' | 'partial'>;
export function validateResearchLiteratureSearch(value: unknown): asserts value is ResearchLiteratureSearch {
  if (!value || typeof value !== 'object') throw new Error('文献检索记录无效。');
  const search = value as ResearchLiteratureSearch;
  if (typeof search.id !== 'string' || search.id.length > 200 || typeof search.query !== 'string' || !search.query.trim() || search.query.length > 500
    || !['searching', 'done', 'error', 'stopped', 'interrupted'].includes(search.status)
    || typeof search.createdAt !== 'string' || !Number.isFinite(Date.parse(search.createdAt))
    || !Array.isArray(search.candidates) || search.candidates.length > 10
    || [search.yearFrom, search.yearTo].some(year => year !== undefined && (!Number.isInteger(year) || year < 1 || year > 9999))
    || search.yearFrom !== undefined && search.yearTo !== undefined && search.yearFrom > search.yearTo
    || [search.error, search.errorCode].some(text => text !== undefined && typeof text !== 'string')
    || search.warnings !== undefined && (!Array.isArray(search.warnings) || !search.warnings.every(text => typeof text === 'string'))
    || search.partial !== undefined && typeof search.partial !== 'boolean') throw new Error('文献检索记录无效。');
  search.candidates.forEach(validateLiteratureCandidate);
}

export type ResearchAgentSource = {
  id: string;
  title: string;
  hash: string;
  totalPages: number;
  pages: { pageIndex: number; text: string }[];
  unavailable?: string;
  abstract?: string;
};
export type ResearchAgentCitation = { documentId: string; documentHash: string; pageIndex: number; quote: string };
export type ResearchAgentArtifact = { title: string; body: string; citations: ResearchAgentCitation[] };
export type ResearchAgentInput = {
  requestId: string;
  researchId: string;
  connectionId: AIConnectionId;
  prompt: string;
  sources: ResearchAgentSource[];
  history: { prompt: string; body: string }[];
  focus?: { ref: ResourceRef; title: string; body: string };
  drawing?: DrawingQuestion & { imageDataUrl?: string };
  images?: (ChatImageAttachment & { dataUrl: string })[];
  materials?: ResearchMaterial[];
};
export type ResearchAgentEvent =
  | { type: 'literature'; search: ResearchLiteratureSearch }
  | { type: 'progress'; text: string; toolName?: string }
  | { type: 'delta'; text: string }
  | { type: 'artifact'; artifact: ResearchAgentArtifact }
  | { type: 'done'; model?: string; nativeSessionId?: string; readPages: { documentId: string; pageIndex: number }[] }
  | { type: 'error'; error: string };
export type ResearchAgentCapability = { id: AIConnectionId; research: boolean; images?: boolean; detail: string };
