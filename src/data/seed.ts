import type { Session, WorkspaceData } from '../domain/types';

export function emptySession(active: Session['active']): Session {
  return {
    active,
    openItems: active.kind === 'collection' || active.kind === 'researchView' ? [] : [active],
    pinnedIds: [],
    history: [],
    panel: { open: true, mode: 'cards', pinned: false, history: [] },
    readers: {},
    viewports: {},
  };
}

export function createSeed(): WorkspaceData {
  return {
    schemaVersion: 3,
    cardDrafts: {},
    researches: {
      'research-a': {
        id: 'research-a',
        title: '检索增强，何时有效？',
        question: '在什么条件下，检索增强能改善模型回答的可靠性？',
        documentIds: ['paper-a', 'paper-b', 'paper-c', 'paper-stub'],
        cardIds: ['card-a', 'card-b', 'card-c', 'card-unverified'],
        createdAt: '2026-10-15',
      },
      'research-b': {
        id: 'research-b',
        title: '长文本阅读方法',
        question: '如何从长文本中保留可核查的研究证据？',
        documentIds: [],
        cardIds: [],
        createdAt: '2026-10-15',
      },
    },
    documents: {
      'paper-stub': { id: 'paper-stub', title: 'Attention Is All You Need', authors: '', year: '2017', identifiers: { arxiv: '1706.03762' }, readingStatus: 'unread', textStatus: 'pending' },
      'paper-a': {
        id: 'paper-a',
        title: 'Adaptive Retrieval: Evidence & Reliability',
        authors: 'Papertrail 示例研究组',
        year: '2026',
        filename: 'adaptive-retrieval.pdf',
        hash: '',
        assetId: 'sample-a',
        sampleUrl: '/samples/adaptive-retrieval.pdf',
        pageCount: 3,
        readingStatus: 'reading',
        textStatus: 'pending',
      },
      'paper-b': {
        id: 'paper-b',
        title: 'Retrieval Baselines & Trade-offs',
        authors: 'Papertrail 示例研究组',
        year: '2026',
        filename: 'retrieval-baseline.pdf',
        hash: '',
        assetId: 'sample-b',
        sampleUrl: '/samples/retrieval-baseline.pdf',
        pageCount: 2,
        readingStatus: 'unread',
        textStatus: 'pending',
      },
      'paper-c': {
        id: 'paper-c',
        title: 'Scanned Research Note',
        authors: 'Papertrail 示例研究组',
        year: '2026',
        filename: 'scanned-note.pdf',
        hash: '',
        assetId: 'sample-c',
        sampleUrl: '/samples/scanned-note.pdf',
        pageCount: 1,
        readingStatus: 'skimmed',
        textStatus: 'empty',
      },
    },
    evidence: {
      'evidence-a': {
        id: 'evidence-a',
        documentId: 'paper-a',
        pageIndex: 2,
        quote:
          'Retrieval improves factual accuracy when the evidence corpus is relevant.',
      },
      'evidence-b': {
        id: 'evidence-b',
        documentId: 'paper-b',
        pageIndex: 0,
        quote:
          'Irrelevant retrieved passages can increase uncertainty rather than reduce it.',
      },
      'evidence-c': {
        id: 'evidence-c',
        documentId: 'paper-a',
        pageIndex: 1,
        quote:
          'A reliable answer should preserve a traceable link to its supporting evidence.',
      },
    },
    cards: {
      'card-unverified': { id: 'card-unverified', title: '检索的边界仍需补充实验', body: '需要核对不同任务下的适用边界。', evidenceIds: [], needsReview: true },
      'card-a': {
        id: 'card-a',
        title: '相关性是检索收益的前提',
        body: '检索并不天然提升回答质量。收益取决于证据集合是否覆盖问题，并与当前任务相关。\n\n评估时应先控制语料相关性，再比较模型表现。',
        evidenceIds: ['evidence-a'],
        needsReview: false,
      },
      'card-b': {
        id: 'card-b',
        title: '无关材料可能放大不确定性',
        body: '当检索引入无关材料时，回答可能变得更不稳定。需要区分检索失败与生成失败。',
        evidenceIds: ['evidence-b'],
        needsReview: true,
      },
      'card-c': {
        id: 'card-c',
        title: '可靠性需要可追踪的证据',
        body: '保留证据与来源位置，才能区分“看起来合理”和“可以核查”的结论。',
        evidenceIds: ['evidence-c'],
        needsReview: false,
      },
    },
    boards: {
      'board-a': {
        id: 'board-a',
        researchId: 'research-a',
        title: '证据与论证',
      },
      'board-a2': {
        id: 'board-a2',
        researchId: 'research-a',
        title: '条件与限制',
      },
      'board-b': {
        id: 'board-b',
        researchId: 'research-b',
        title: '证据与论证',
      },
    },
    placements: {
      'placement-a': {
        id: 'placement-a',
        boardId: 'board-a',
        resourceRef: { kind: 'card', id: 'card-a' },
        x: 55,
        y: 90,
        group: '支持',
      },
      'placement-b': {
        id: 'placement-b',
        boardId: 'board-a',
        resourceRef: { kind: 'card', id: 'card-b' },
        x: 385,
        y: 250,
        group: '限制',
      },
      'placement-c': {
        id: 'placement-c',
        boardId: 'board-a',
        resourceRef: { kind: 'card', id: 'card-c' },
        x: 55,
        y: 390,
        group: '方法',
      },
      'placement-a2': {
        id: 'placement-a2',
        boardId: 'board-a2',
        resourceRef: { kind: 'card', id: 'card-a' },
        x: 60,
        y: 100,
        group: '支持',
      },
    },
    edges: {
      'edge-a': {
        id: 'edge-a',
        boardId: 'board-a',
        fromPlacementId: 'placement-a',
        toPlacementId: 'placement-b',
        label: '适用边界',
      },
    },
    drafts: {
      'draft-a': {
        id: 'draft-a',
        researchId: 'research-a',
        title: '检索增强的适用条件',
        body: '检索增强的收益依赖证据相关性。无关语料可能增加不确定性，因此评估需要同时报告语料条件与来源可追踪性。',
        evidenceIds: ['evidence-a', 'evidence-b'],
        cardRefs: [{ cardId: 'card-unverified', insertedAt: '2026-10-17T00:00:00.000Z' }],
      },
      'draft-b': {
        id: 'draft-b',
        researchId: 'research-b',
        title: '研究结论',
        body: '',
        evidenceIds: [],
      },
    },
    conversations: {
      'conversation-research-a': {
        id: 'conversation-research-a',
        researchId: 'research-a',
        contextIds: [],
        requestIds: [],
      },
      'conversation-research-b': {
        id: 'conversation-research-b',
        researchId: 'research-b',
        contextIds: [],
        requestIds: [],
      },
    },
    requests: {},
    sessions: {
      'research-a': emptySession({ kind: 'researchView', id: 'home' }),
      'research-b': emptySession({ kind: 'researchView', id: 'home' }),
      library: emptySession({ kind: 'collection', id: 'documents' }),
    },
    scope: { kind: 'research', researchId: 'research-a' },
    sidebarCollapsed: false,
    panelWidth: 360,
  };
}
