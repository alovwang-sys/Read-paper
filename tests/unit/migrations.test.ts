import { describe, expect, it } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { paneGroups } from '../../src/services/panes';
import type { LiteratureCandidate, ResearchMaterial } from '../../src/domain/types';

function legacyWorkspace() {
  const { cardDrafts: _cardDrafts, ...seed } = createSeed();
  const old = { ...seed, schemaVersion: 1 };
  delete old.documents['paper-stub'];
  old.documents['paper-c'].readingStatus = 'read';
  for (const research of Object.values(old.researches)) research.documentIds = research.documentIds.filter(id => id !== 'paper-stub');
  for (const draft of Object.values(old.drafts)) delete draft.cardRefs;
  for (const [key, session] of Object.entries(old.sessions)) {
    session.active = key === 'library' ? { kind: 'collection', id: 'documents' } : { kind: 'research', id: key };
    Object.assign(session.panel, { mode: 'references' });
  }
  old.documents['paper-a'].hash = 'existing-pdf-hash';
  old.cards['card-a'].body = '用户修改过的卡片正文';
  old.conversations['conversation-research-a'].input = '尚未发送的问题';
  old.sessions['research-a'].readers['main:paper-a'] = { pageIndex: 2, scale: 1.5 };
  old.sessions['research-a'].viewports['board-a'] = { x: 31, y: 47, scale: 0.8 };
  old.requests['old-answer'] = {
    id: 'old-answer', researchId: 'research-a', conversationId: 'conversation-research-a',
    prompt: '旧问题', body: '旧版曾允许直接编辑的回答', context: [], evidenceIds: [],
    createdAt: '2026-10-15T10:00:00.000Z', status: 'done',
  };
  old.conversations['conversation-research-a'].requestIds = ['old-answer'];
  return old;
}

describe('工作区 schema 迁移', () => {
  it('已有 schema 3 保留旧卡片、无全文条目、输入和资产，不补造局部研究或检索', () => {
    const data = createSeed();
    data.cards['card-a'].body = '旧版用户正文';
    data.documents['paper-a'].hash = 'unchanged-existing-hash';
    data.conversations['conversation-research-a'].input = '旧版未发送问题';
    data.sessions['research-a'].viewports['board-a'] = { x: 31, y: 47, scale: 0.8 };
    const before = structuredClone(data), migrated = migrateWorkspace(data);
    expect(data).toEqual(before);
    for (const key of ['documents', 'cards', 'evidence', 'placements', 'boards', 'drafts'] as const) expect(migrated[key]).toEqual(before[key]);
    expect(migrated.documents['paper-stub'].assetId).toBeUndefined();
    expect(migrated.conversations['conversation-research-a'].input).toBe('旧版未发送问题');
    expect(migrated.conversations['conversation-research-a'].boardResearch).toBeUndefined();
    expect(migrated.conversations['conversation-research-a'].literatureSearches).toBeUndefined();
    expect(migrated.sessions['research-a'].viewports).toEqual(before.sessions['research-a'].viewports);
    expect(migrateWorkspace(migrated)).toEqual(migrated);
  });

  it('重载将活动文献检索标为 interrupted，保留已完成批次、起点、焦点、查询和未发送内容', () => {
    const data = createSeed(), conversation = data.conversations['conversation-research-a'];
    const candidate: LiteratureCandidate = { id: 'openalex-W9004', provider: 'openalex', providerId: 'W9004', title: '中断恢复测试来源', authors: [], url: 'https://example.org/resume', abstract: '已经持久化的摘要', retrievedAt: '2026-10-20T10:00:00.000Z' };
    const material: ResearchMaterial = { id: candidate.id, kind: 'abstract', title: candidate.title, text: candidate.abstract!, version: 'frozen-source', provider: candidate.provider, providerId: candidate.providerId, url: candidate.url };
    conversation.boardResearch = { origin: { boardId: 'board-a', rootPlacementId: 'placement-a', rootRef: { kind: 'card', id: 'card-a' }, rootTitle: '原问题' }, focus: [{ kind: 'card', id: 'card-b' }], automatic: [material], pinned: [], includeBackground: false, excludedSourceIds: ['card:card-a'], view: 'literature', literatureQuery: '未提交的新检索词', literatureBatchId: 'running', literatureScrollTop: 86 };
    conversation.input = '未发送的追问';
    const batch = { id: 'done', researchId: 'research-a', conversationId: conversation.id, boardId: 'board-a', rootPlacementId: 'placement-a', rootTitle: '原问题', query: '提交时的查询', createdAt: candidate.retrievedAt, status: 'done' as const, candidates: [candidate], partial: true, warnings: ['来源缺 DOI'] };
    conversation.literatureSearches = [batch, { ...structuredClone(batch), id: 'running', status: 'searching', candidates: [] }];
    const before = structuredClone(data), migrated = migrateWorkspace(data), restored = migrated.conversations[conversation.id];
    expect(data).toEqual(before);
    expect(restored.boardResearch).toEqual(conversation.boardResearch);
    expect(restored.input).toBe(conversation.input);
    expect(restored.literatureSearches![0]).toEqual(batch);
    expect(restored.literatureSearches![1]).toMatchObject({ id: 'running', status: 'interrupted', query: '提交时的查询', rootPlacementId: 'placement-a', candidates: [] });
    expect(restored.literatureSearches![1].error).toMatch(/中断|重新加载/);
    expect(migrateWorkspace(migrated)).toEqual(migrated);
  });

  it.each(['research', 'board', 'source-url'])('迁移拒绝跨研究或可执行的检索来源并保留原输入：%s', problem => {
    const data = createSeed(), conversation = data.conversations['conversation-research-a'];
    conversation.literatureSearches = [{ id: 'unsafe', researchId: 'research-a', conversationId: conversation.id, boardId: 'board-a', rootTitle: '原问题', query: 'query', createdAt: '', status: 'done', candidates: [{ id: 'openalex-W9005', provider: 'openalex', providerId: 'W9005', title: '安全验证来源', authors: [], url: 'https://example.org/source', retrievedAt: '' }] }];
    if (problem === 'research') conversation.literatureSearches[0].researchId = 'research-b';
    if (problem === 'board') conversation.literatureSearches[0].boardId = 'board-b';
    if (problem === 'source-url') conversation.literatureSearches[0].candidates[0].url = 'javascript:alert(1)';
    const before = structuredClone(data);
    expect(() => migrateWorkspace(data)).toThrow();
    expect(data).toEqual(before);
  });

  it('v1 迁移不改变输入，保留资产、卡片、输入和视口，并明确旧回答的来源限制', () => {
    const original = legacyWorkspace();
    const before = structuredClone(original);
    const migrated = migrateWorkspace(original);

    expect(original).toEqual(before);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.documents).toEqual(before.documents);
    expect(migrated.evidence).toEqual(Object.fromEntries(Object.entries(before.evidence).map(([id, evidence]) => [id, { ...evidence, researchId: 'research-a' }])));
    expect(migrated.cards).toEqual(before.cards);
    expect(migrated.placements).toEqual(before.placements);
    expect(migrated.sessions['research-a'].readers).toEqual(before.sessions['research-a'].readers);
    expect(migrated.sessions['research-a'].viewports).toEqual(before.sessions['research-a'].viewports);
    expect(migrated.conversations['conversation-research-a'].input).toBe('尚未发送的问题');
    expect(migrated.sessions['research-a'].activeConversationId).toBe('conversation-research-a');
    expect(migrated.cardDrafts).toEqual({});
    expect(migrated.requests['old-answer']).toMatchObject({
      body: before.requests['old-answer'].body, legacy: true, mode: 'demo', purpose: 'chat', history: [],
    });
    expect(migrated.cards['card-a'].provenance).toBeUndefined();
    expect(migrateWorkspace(migrated)).toEqual(migrated);
  });

  it('schema 2 保留全部实体和打开资源，只推断唯一的摘录来源研究', () => {
    const old = { ...legacyWorkspace(), schemaVersion: 2, cardDrafts: {} };
    old.researches['research-b'].cardIds = ['card-a'];
    old.researches['research-b'].documentIds = ['paper-a'];
    old.evidence['unclaimed'] = { id: 'unclaimed', documentId: 'paper-a', pageIndex: 0, quote: '来源不确定' };
    old.evidence['conversation-only'] = { id: 'conversation-only', documentId: 'paper-a', pageIndex: 0, quote: '会话引用' };
    old.conversations['conversation-research-b'].contextIds = ['conversation-only'];
    old.evidence['draft-only'] = { id: 'draft-only', documentId: 'paper-a', pageIndex: 0, quote: '文稿引用' };
    old.drafts['draft-b'].evidenceIds = ['draft-only'];
    old.evidence['request-only'] = { id: 'request-only', documentId: 'paper-a', pageIndex: 0, quote: '问答快照引用' };
    old.requests['request-source-b'] = { id: 'request-source-b', researchId: 'research-b', conversationId: 'conversation-research-b', prompt: '问题', body: '回答', context: [{ evidenceId: 'request-only', documentId: 'paper-a', documentHash: old.documents['paper-a'].hash!, title: '论文', pageIndex: 0, quote: '问答快照引用' }], evidenceIds: [], createdAt: '2026-10-17T00:00:00Z', status: 'done' };
    old.conversations['conversation-research-b'].requestIds = ['request-source-b'];
    old.sessions['research-a'].active = { kind: 'document', id: 'paper-a' };
    old.sessions['research-a'].openItems = [{ kind: 'document', id: 'paper-a' }, { kind: 'board', id: 'board-a' }, { kind: 'draft', id: 'draft-a' }];
    const before = structuredClone(old);
    const migrated = migrateWorkspace(old);
    for (const key of ['researches', 'documents', 'evidence', 'cards', 'boards', 'placements', 'edges', 'drafts', 'conversations', 'requests'] as const)
      expect(Object.keys(migrated[key])).toEqual(Object.keys(old[key]));
    expect(migrated.evidence['evidence-a'].researchId).toBeUndefined();
    expect(migrated.evidence['evidence-b'].researchId).toBe('research-a');
    expect(migrated.evidence['unclaimed'].researchId).toBeUndefined();
    expect(migrated.evidence['conversation-only'].researchId).toBe('research-b');
    expect(migrated.evidence['draft-only'].researchId).toBe('research-b');
    expect(migrated.evidence['request-only'].researchId).toBe('research-b');
    expect(migrated.sessions['research-a'].openItems).toEqual(before.sessions['research-a'].openItems);
    expect(migrated.sessions['research-a'].active).toEqual(before.sessions['research-a'].active);
    expect(old).toEqual(before);
    expect(migrateWorkspace(migrated)).toEqual(migrated);
  });

  it('旧文稿只从已有来源快照还原卡片记录，不补造没有记录的插入', () => {
    const old = { ...legacyWorkspace(), schemaVersion: 2, cardDrafts: {} };
    const provenance = { researchId: 'research-a', conversationId: 'conversation-research-a', conversationTitle: '对话', requestId: 'old-answer', prompt: '问题', answer: '回答', selection: '回答', context: [], createdAt: '2026-10-16T00:00:00Z', generationRequestIds: [] };
    old.drafts['draft-a'].cardSources = [{ cardId: 'card-a', title: '旧标题', provenance }, { cardId: 'card-a', title: '第二次插入', provenance }];
    const migrated = migrateWorkspace(old);
    expect(migrated.drafts['draft-a'].cardRefs).toEqual([{ cardId: 'card-a', insertedAt: '1970-01-01T00:00:00.000Z' }]);
    expect(migrated.drafts['draft-b'].cardRefs).toEqual([]);
    expect(migrated.drafts['draft-a'].body).toBe(old.drafts['draft-a'].body);
    expect(migrated.drafts['draft-a'].evidenceIds).toEqual(old.drafts['draft-a'].evidenceIds);
  });

  it.each([['evidence', 'excerpts'], ['info', 'excerpts'], ['references', 'cards'], ['ai', 'ai']])('旧面板 %s 映射为 %s，保留右侧资源和阅读位置', (mode, expected) => {
    const old = legacyWorkspace();
    Object.assign(old.sessions['research-a'].panel, { mode });
    old.sessions['research-a'].panel.ref = { kind: 'card', id: 'card-a' };
    const migrated = migrateWorkspace(old);
    expect(migrated.sessions['research-a'].active).toEqual({ kind: 'researchView', id: 'home' });
    expect(migrated.sessions['research-a'].panel.mode).toBe(expected);
    expect(migrated.sessions['research-a'].panel.ref).toEqual({ kind: 'card', id: 'card-a' });
    expect(migrated.sessions['research-a'].readers).toEqual(old.sessions['research-a'].readers);
  });

  it.each([['inbox', 'documents'], ['documents', 'documents'], ['cards', 'cards'], ['researches', 'documents'], ['drafts', 'documents']])('旧资料库入口 %s 映射到 %s', (id, expected) => {
    const old = legacyWorkspace();
    Object.assign(old.sessions.library, { active: { kind: 'collection', id } });
    const migrated = migrateWorkspace(old);
    expect(migrated.sessions.library.active).toEqual({ kind: 'collection', id: expected });
    expect(migrated.sessions.library.libraryFilter).toBe(id === 'inbox' ? 'unassigned' : undefined);
  });

  it.each([undefined, 'all'] as const)('schema 2 卡片库的历史收件箱不改变当前筛选 %s', (libraryFilter) => {
    const old = { ...legacyWorkspace(), schemaVersion: 2, cardDrafts: {} };
    Object.assign(old.sessions.library, {
      active: { kind: 'collection', id: 'cards' },
      history: [{ kind: 'collection', id: 'inbox' }, { kind: 'collection', id: 'cards' }],
      libraryFilter,
    });
    const before = structuredClone(old);
    const migrated = migrateWorkspace(old);

    expect(migrated.sessions.library.active).toEqual({ kind: 'collection', id: 'cards' });
    expect(migrated.sessions.library.libraryFilter).toBe(libraryFilter);
    expect(migrated.sessions.library.history).toEqual([
      { kind: 'collection', id: 'documents' }, { kind: 'collection', id: 'cards' },
    ]);
    expect(migrated.cards).toEqual(before.cards);
    expect(old).toEqual(before);
  });

  it('刷新把生成中的请求和草稿标记为中断，保留收到的正文与手改内容', () => {
    const data = migrateWorkspace(legacyWorkspace());
    data.requests['live-partial'] = {
      ...data.requests['old-answer'], id: 'live-partial', legacy: undefined, mode: 'live',
      status: 'generating', body: '最近已持久化的一部分',
    };
    data.requests['stopped-answer'] = { ...data.requests['live-partial'], id: 'stopped-answer', status: 'stopped' };
    data.cardDrafts['draft-in-progress'] = {
      id: 'draft-in-progress', researchId: 'research-a', conversationId: 'conversation-research-a',
      title: '人工标题', body: '人工正文', evidenceIds: [], needsReview: true, revision: 3, status: 'generating',
      source: {
        researchId: 'research-a', conversationId: 'conversation-research-a', conversationTitle: '对话',
        requestId: 'old-answer', prompt: '旧问题', answer: '旧回答', selection: '旧回答', context: [],
        createdAt: '2026-10-16T00:00:00.000Z', generationRequestIds: [],
      },
    };
    const before = structuredClone(data);
    const migrated = migrateWorkspace(data);

    expect(data).toEqual(before);
    expect(migrated.requests['live-partial']).toMatchObject({ status: 'interrupted', body: '最近已持久化的一部分', mode: 'live' });
    expect(migrated.requests['live-partial'].legacy).toBeUndefined();
    expect(migrated.requests['live-partial'].error).toMatch(/重新加载|中断/);
    expect(migrated.requests['stopped-answer'].status).toBe('stopped');
    expect(migrated.requests['old-answer'].status).toBe('done');
    expect(migrated.cardDrafts['draft-in-progress']).toMatchObject({
      status: 'error', title: '人工标题', body: '人工正文', revision: 3,
    });
    expect(migrated.cardDrafts['draft-in-progress'].error).toMatch(/中断/);
  });

  it('原生导入的活动回合刷新后等待同步，不提示用户重新提交', () => {
    const data = migrateWorkspace(legacyWorkspace());
    data.requests['external-active'] = { ...data.requests['old-answer'], id: 'external-active', legacy: undefined, connectionId: 'codex', nativeImported: true, nativeTurnId: 'turn-active', status: 'generating', body: '已收到的原生过程内容' };
    const migrated = migrateWorkspace(data);
    expect(migrated.requests['external-active']).toMatchObject({ status: 'interrupted', body: '已收到的原生过程内容', error: '正在同步原生记录，已收到的内容保留。' });
  });

  it('托管 Codex 刷新保留执行和待回应交互，重连后核对真实状态', () => {
    const data = createSeed();
    data.requests['managed-request'] = {
      id: 'managed-request', researchId: 'research-a', conversationId: 'conversation-research-a',
      prompt: '持续运行', body: '已收到的部分', context: [], evidenceIds: [], status: 'generating',
      createdAt: '2026-10-19T00:00:00Z', purpose: 'chat', connectionId: 'codex', nativeSessionId: 'thread-a', nativeTurnId: 'turn-a',
      nativeRun: { managed: true, cursor: 12, delivery: 'accepted', state: 'waiting-input', transport: 'connected', turnId: 'turn-a', items: [] },
      interactions: [{ id: 'question', kind: 'question', title: '等待回答', status: 'pending', questions: [] }],
    };
    const original = structuredClone(data);
    const recovered = migrateWorkspace(data).requests['managed-request'];
    expect(recovered.status).toBe('generating');
    expect(recovered.nativeRun).toMatchObject({ cursor: 12, state: 'waiting-input', transport: 'reconnecting' });
    expect(recovered.interactions?.[0].status).toBe('pending');
    expect(data).toEqual(original);
    data.requests['managed-request'].nativeRun!.cursor = -1;
    expect(() => migrateWorkspace(data)).toThrow('原生运行记录损坏');
  });

  it('未知版本和损坏记录拒绝迁移，并保持原始数据可供恢复', () => {
    const seed = legacyWorkspace();
    const invalid: unknown[] = [
      null, { ...seed, schemaVersion: 0 }, { ...seed, schemaVersion: 4 }, { ...seed, schemaVersion: '2' },
      { ...seed, documents: null }, { ...seed, cards: { broken: null } },
      { ...seed, requests: { broken: { ...seed.requests['old-answer'], context: null } } },
      { ...seed, conversations: { broken: { contextIds: [], requestIds: null } } },
      { ...seed, sessions: { library: seed.sessions.library } },
    ];
    for (const value of invalid) {
      const before = structuredClone(value);
      expect(() => migrateWorkspace(value)).toThrow();
      expect(value).toEqual(before);
    }
    const v2 = createSeed();
    expect(() => migrateWorkspace({ ...v2, cardDrafts: undefined })).toThrow(/草稿/);
  });

  it('恢复活动会话时不跨研究，也不选择已归档记录或删除历史', () => {
    const data = createSeed();
    const a = data.conversations['conversation-research-a'];
    data.conversations['archived-a'] = { ...a, id: 'archived-a', archived: true };
    data.sessions['research-a'].activeConversationId = 'conversation-research-b';
    const migrated = migrateWorkspace(data);
    expect(migrated.sessions['research-a'].activeConversationId).toBe(a.id);
    expect(migrated.conversations['archived-a'].archived).toBe(true);

    a.archived = true;
    data.sessions['research-a'].activeConversationId = 'archived-a';
    const allArchived = migrateWorkspace(data);
    expect(allArchived.sessions['research-a'].activeConversationId).toBeUndefined();
    expect(Object.keys(allArchived.conversations)).toEqual(Object.keys(data.conversations));
  });

  it('schema 3 保留插入时的证据映射，不接受损坏的证据列表或研究页标签', () => {
    const data = createSeed();
    data.drafts['draft-a'].cardRefs = [{ cardId: 'card-a', insertedAt: '2026-10-17T00:00:00Z', evidenceIds: ['evidence-a'] }];
    expect(migrateWorkspace(data).drafts['draft-a'].cardRefs).toEqual(data.drafts['draft-a'].cardRefs);
    const malformedEvidence = structuredClone(data);
    Object.assign(malformedEvidence.drafts['draft-a'].cardRefs![0], { evidenceIds: [42] });
    expect(() => migrateWorkspace(malformedEvidence)).toThrow(/卡片记录/);
    const malformedView = structuredClone(data);
    malformedView.sessions['research-a'].active = { kind: 'document', id: 'paper-a' };
    Object.assign(malformedView.sessions['research-a'], { researchView: 'missing' });
    const before = structuredClone(malformedView);
    expect(() => migrateWorkspace(malformedView)).toThrow(/页面/);
    expect(malformedView).toEqual(before);
  });
});


describe('连续阅读位置校验', () => {
  it('保留旧位置和新分屏位置，拒绝非数值页内偏移和未知布局', () => {
    const seed = createSeed();
    seed.sessions['research-a'].readers['main-secondary:paper-a'] = { pageIndex: 1, scale: 1, offset: 0.3 };
    seed.sessions['research-a'].readerSplits = { 'paper-a': 'horizontal' };
    seed.sessions['research-a'].active = { kind: 'document', id: 'paper-a' };
    const migrated = migrateWorkspace(seed).sessions['research-a'];
    expect(migrated.readers['main-secondary:paper-a']).toEqual({ pageIndex: 1, scale: 1, offset: 0.3 });
    expect(migrated.layout!.root).toMatchObject({ kind: 'split', axis: 'row' });
    expect(paneGroups(migrated.layout!.root)[1].tabs[0]).toMatchObject({ ref: { kind: 'document', id: 'paper-a' }, reading: { pageIndex: 1, scale: 1, offset: 0.3 } });
    expect(migrated.mainSplit).toBeUndefined();
    seed.sessions['research-a'].readers['main-secondary:paper-a'].offset = NaN;
    expect(() => migrateWorkspace(seed)).toThrow('阅读位置损坏');
    seed.sessions['research-a'].readers['main-secondary:paper-a'].offset = 0.3;
    seed.sessions['research-a'].readerSplits!['paper-a'] = 'unknown' as 'horizontal';
    expect(() => migrateWorkspace(seed)).toThrow('阅读分屏状态损坏');
  });
});


describe('独立资源分屏迁移', () => {
  it('保留卡片对照并拒绝跨研究或失效资源，旧版仅转换布局不改两位置', () => {
    const seed = createSeed();
    seed.sessions['research-a'].mainSplit = { layout: 'vertical', ref: { kind: 'card', id: 'card-a' } };
    expect(paneGroups(migrateWorkspace(seed).sessions['research-a'].layout!.root)[1].tabs[0].ref).toEqual({ kind: 'card', id: 'card-a' });
    seed.sessions['research-b'].mainSplit = seed.sessions['research-a'].mainSplit;
    expect(() => migrateWorkspace(seed)).toThrow('不属于本研究');
    seed.sessions['research-b'].mainSplit = undefined;
    seed.sessions['research-a'].mainSplit!.ref.id = 'missing';
    expect(() => migrateWorkspace(seed)).toThrow('分屏资源损坏');
  });
});

describe('Agent 工作台兼容数据', () => {
  it('保留经典界面选择与局部焦点，恢复未完成研究时不重放运行', () => {
    const data = createSeed();
    data.agentWorkbench = false;
    data.sessions['research-a'].activeConversationId = 'conversation-research-a';
    data.sessions['research-a'].agentFocus = { ref: { kind: 'card', id: 'card-a' }, title: '局部观点', body: '尚未发送的问题起点' };
    data.requests['research-run'] = { id: 'research-run', researchId: 'research-a', conversationId: 'conversation-research-a', prompt: '比较', body: '', context: [], evidenceIds: [], createdAt: '2026-10-21', status: 'generating', researchRun: { sourceSummary: '只取本研究三篇', focus: data.sessions['research-a'].agentFocus } };
    const restored = migrateWorkspace(data);
    expect(restored.agentWorkbench).toBe(false);
    expect(restored.conversations['conversation-research-a'].researchFocus).toEqual(data.sessions['research-a'].agentFocus);
    expect(restored.sessions['research-a'].agentFocus).toBeUndefined();
    expect(restored.requests['research-run'].status).toBe('interrupted');
    expect(restored.cards).toEqual(data.cards);
    expect(restored.drafts).toEqual(data.drafts);
  });
  it('拒绝损坏的焦点和修订记录，不覆盖原数据', () => {
    const data = createSeed();
    Object.assign(data.sessions['research-a'], { agentFocus: { ref: { kind: 'file', id: '/tmp/private' }, title: '无效', body: '' } });
    expect(() => migrateWorkspace(data)).toThrow('焦点');
    delete data.sessions['research-a'].agentFocus;
    data.requests['bad-run'] = { id: 'bad-run', researchId: 'research-a', conversationId: 'conversation-research-a', prompt: '修改', body: '', context: [], evidenceIds: [], createdAt: '', status: 'done', researchRun: {} };
    Object.assign(data.requests['bad-run'].researchRun!, { suggestion: { title: '', body: '', evidenceIds: [], baseTitle: '', baseBody: '', baseEvidenceIds: 'broken' } });
    expect(() => migrateWorkspace(data)).toThrow('运行记录');
  });
});

describe('旧研究焦点迁移到会话', () => {
  it('只迁给原活动会话，已有会话焦点优先，第二次恢复不重复迁移', () => {
    const data = createSeed(), id = 'conversation-research-a';
    data.sessions['research-a'].activeConversationId = id;
    data.sessions['research-a'].agentFocus = { ref: { kind: 'card', id: 'card-a' }, title: '旧焦点', body: '旧材料' };
    const first = migrateWorkspace(data);
    expect(first.conversations[id].researchFocus?.title).toBe('旧焦点');
    expect(first.conversations['conversation-research-b'].researchFocus).toBeUndefined();
    expect(first.sessions['research-a'].agentFocus).toBeUndefined();
    expect(migrateWorkspace(first)).toEqual(first);
    first.sessions['research-a'].agentFocus = { ref: { kind: 'card', id: 'card-a' }, title: '过期副本', body: '' };
    expect(migrateWorkspace(first).conversations[id].researchFocus?.title).toBe('旧焦点');
  });
  it('不能把无法确定原主人的旧目标迁给修复后的其他会话', () => {
    const data = createSeed();
    data.sessions['research-a'].activeConversationId = 'missing';
    data.sessions['research-a'].agentFocus = { ref: { kind: 'card', id: 'card-a' }, title: '无归属', body: '仍保留实体和原文' };
    const result = migrateWorkspace(data);
    expect(result.sessions['research-a'].activeConversationId).toBe('conversation-research-a');
    expect(result.conversations['conversation-research-a'].researchFocus).toBeUndefined();
    expect(result.sessions['research-a'].agentFocus).toBeUndefined();
    expect(result.cards).toEqual(data.cards);
  });
  it('拒绝损坏的会话焦点与非有限滚动位置', () => {
    const data = createSeed();
    Object.assign(data.conversations['conversation-research-a'], { researchFocus: { ref: { kind: 'file', id: '/private' }, title: '', body: '' } });
    expect(() => migrateWorkspace(data)).toThrow('会话');
    delete data.conversations['conversation-research-a'].researchFocus;
    data.conversations['conversation-research-a'].researchScrollTop = Infinity;
    expect(() => migrateWorkspace(data)).toThrow('会话');
  });
});
