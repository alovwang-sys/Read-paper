export type SaveStatus = 'dirty' | 'saving' | 'saved' | 'error';
export type ResourceRef = {
  kind: 'research' | 'document' | 'card' | 'board' | 'draft';
  id: string;
};
export type WorkspaceScope =
  | { kind: 'research'; researchId: string }
  | { kind: 'library' };
export type CollectionId =
  | 'inbox'
  | 'documents'
  | 'researches'
  | 'cards'
  | 'drafts';
export type PanelMode = 'evidence' | 'references' | 'info' | 'ai';
export type Research = {
  id: string;
  title: string;
  question: string;
  documentIds: string[];
  cardIds: string[];
  createdAt: string;
};
export type PaperDocument = {
  id: string;
  title: string;
  authors: string;
  year: string;
  filename: string;
  hash: string;
  assetId: string;
  assetRevision?: number;
  sampleUrl?: string;
  pageCount: number;
  readingStatus: 'unread' | 'reading' | 'read';
  textStatus: 'pending' | 'ready' | 'empty' | 'error';
};
export type Evidence = {
  id: string;
  documentId: string;
  pageIndex: number;
  quote: string;
  printedPage?: string;
};
export type Card = {
  id: string;
  title: string;
  body: string;
  evidenceIds: string[];
  needsReview: boolean;
};
export type Board = { id: string; researchId: string; title: string };
export type BoardPlacement = {
  id: string;
  boardId: string;
  resourceRef: ResourceRef;
  x: number;
  y: number;
  group: string;
};
export type BoardEdge = {
  id: string;
  boardId: string;
  fromPlacementId: string;
  toPlacementId: string;
  label: string;
};
export type Draft = {
  id: string;
  researchId: string;
  title: string;
  body: string;
  evidenceIds: string[];
};
export type ReadingPosition = { pageIndex: number; scale: number };
export type BoardViewport = { x: number; y: number; scale: number };
export type PanelState = {
  open: boolean;
  mode: PanelMode;
  ref?: ResourceRef;
  pinned: boolean;
  history: ResourceRef[];
  anchor?: ResourceAnchor;
};
export type ResourceAnchor = {
  evidenceId?: string;
  pageIndex?: number;
  placementId?: string;
};
export type Session = {
  active: ResourceRef | { kind: 'collection'; id: CollectionId };
  openItems: ResourceRef[];
  pinnedIds: string[];
  history: Session['active'][];
  panel: PanelState;
  readers: Record<string, ReadingPosition>;
  viewports: Record<string, BoardViewport>;
  anchor?: ResourceAnchor;
};
export type Selection = {
  scope: WorkspaceScope;
  viewInstanceId: string;
  selectedItems: { resourceRef: ResourceRef; placementId?: string }[];
  textRange?: { documentId: string; pageIndex: number; quote: string };
  evidenceIds: string[];
};
export type ContextSnapshot = {
  evidenceId: string;
  documentId: string;
  documentHash: string;
  title: string;
  pageIndex: number;
  quote: string;
};
export type AIRequest = {
  id: string;
  researchId: string;
  conversationId: string;
  prompt: string;
  context: ContextSnapshot[];
  createdAt: string;
  status: 'generating' | 'done' | 'error';
  body: string;
  evidenceIds: string[];
  error?: string;
};
export type Conversation = {
  id: string;
  researchId: string;
  contextIds: string[];
  requestIds: string[];
  input?: string;
};
export type WorkspaceData = {
  schemaVersion: 1;
  researches: Record<string, Research>;
  documents: Record<string, PaperDocument>;
  evidence: Record<string, Evidence>;
  cards: Record<string, Card>;
  boards: Record<string, Board>;
  placements: Record<string, BoardPlacement>;
  edges: Record<string, BoardEdge>;
  drafts: Record<string, Draft>;
  conversations: Record<string, Conversation>;
  requests: Record<string, AIRequest>;
  sessions: Record<string, Session>;
  scope: WorkspaceScope;
  sidebarCollapsed: boolean;
  panelWidth: number;
};
export type WorkspaceState = {
  data: WorkspaceData;
  loaded: boolean;
  loadError?: string;
  saveStatus: SaveStatus;
  saveError?: string;
  selection?: Selection;
  notice?: string;
};
