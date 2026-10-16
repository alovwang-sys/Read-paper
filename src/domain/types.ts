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
  kind?: 'text' | 'region';
  region?: RegionSource;
};
export type RegionSource = {
  assetId: string;
  hash: string;
  rect: { x: number; y: number; width: number; height: number };
  rotation: number;
  width: number;
  height: number;
};
export type Card = {
  id: string;
  title: string;
  body: string;
  evidenceIds: string[];
  needsReview: boolean;
  provenance?: CardProvenance;
};
export type CardProvenance = {
  researchId: string;
  conversationId: string;
  conversationTitle: string;
  requestId: string;
  prompt: string;
  answer: string;
  answerEvidenceIds?: string[];
  selection: string;
  context: ContextSnapshot[];
  createdAt: string;
  model?: string;
  generationRequestIds: string[];
  incomplete?: boolean;
};
export type CardDraft = {
  id: string;
  researchId: string;
  conversationId: string;
  source: CardProvenance;
  title: string;
  body: string;
  evidenceIds: string[];
  needsReview: boolean;
  status: 'generating' | 'editing' | 'error' | 'saved';
  error?: string;
  revision: number;
  instruction?: string;
  suggestion?: { title: string; body: string; evidenceIds: string[]; baseRevision: number; requestId: string };
  previous?: { title: string; body: string; evidenceIds: string[] };
  cardId?: string;
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
  cardSources?: { cardId: string; title: string; provenance: CardProvenance }[];
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
  aiView?: 'chat' | 'history' | 'draft' | 'source';
  aiMode?: 'live' | 'demo';
  aiDraftId?: string;
  conversationSource?: CardProvenance;
  sourceReturnRef?: ResourceRef;
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
  activeConversationId?: string;
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
  kind?: 'text' | 'region';
  region?: RegionSource;
};
export type AIHistoryTurn = {
  requestId: string;
  prompt: string;
  body: string;
  sentBody?: string;
  evidenceIds: string[];
  context: ContextSnapshot[];
};
export type AIRequest = {
  id: string;
  researchId: string;
  conversationId: string;
  prompt: string;
  context: ContextSnapshot[];
  createdAt: string;
  status: 'generating' | 'done' | 'error' | 'stopped' | 'interrupted';
  body: string;
  evidenceIds: string[];
  error?: string;
  purpose?: 'chat' | 'card' | 'revision';
  history?: AIHistoryTurn[];
  model?: string;
  mode?: 'live' | 'demo';
  rawBody?: string;
  result?: { title: string; body: string; evidenceIds: string[] };
  retryOf?: string;
  regeneratedFrom?: string;
  superseded?: boolean;
  legacy?: boolean;
  validationError?: string;
  draftId?: string;
};
export type Conversation = {
  id: string;
  researchId: string;
  contextIds: string[];
  requestIds: string[];
  input?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  historyRange?: 'all' | 'latest' | 'none';
  scrollTop?: number;
};
export type WorkspaceData = {
  schemaVersion: 2;
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
  cardDrafts: Record<string, CardDraft>;
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
