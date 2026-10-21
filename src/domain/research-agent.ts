import type { AIConnectionId, DrawingQuestion, ResourceRef } from './types';

export type ResearchAgentSource = {
  id: string;
  title: string;
  hash: string;
  totalPages: number;
  pages: { pageIndex: number; text: string }[];
  unavailable?: string;
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
};
export type ResearchAgentEvent =
  | { type: 'progress'; text: string; toolName?: string }
  | { type: 'delta'; text: string }
  | { type: 'artifact'; artifact: ResearchAgentArtifact }
  | { type: 'done'; model?: string; nativeSessionId?: string; readPages: { documentId: string; pageIndex: number }[] }
  | { type: 'error'; error: string };
export type ResearchAgentCapability = { id: AIConnectionId; research: boolean; images?: boolean; detail: string };
