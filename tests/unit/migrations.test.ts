import { describe, expect, it } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';

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
    expect(migrateWorkspace(seed).sessions['research-a']).toMatchObject({ readers: { 'main-secondary:paper-a': { pageIndex: 1, scale: 1, offset: 0.3 } }, readerSplits: { 'paper-a': 'horizontal' } });
    seed.sessions['research-a'].readers['main-secondary:paper-a'].offset = NaN;
    expect(() => migrateWorkspace(seed)).toThrow('阅读位置损坏');
    seed.sessions['research-a'].readers['main-secondary:paper-a'].offset = 0.3;
    seed.sessions['research-a'].readerSplits!['paper-a'] = 'unknown' as 'horizontal';
    expect(() => migrateWorkspace(seed)).toThrow('阅读分屏状态损坏');
  });
});
