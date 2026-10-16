import { describe, expect, it } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';

function legacyWorkspace() {
  const { cardDrafts: _cardDrafts, ...seed } = createSeed();
  const old = { ...seed, schemaVersion: 1 };
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
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.documents).toEqual(before.documents);
    expect(migrated.evidence).toEqual(before.evidence);
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
      null, { ...seed, schemaVersion: 0 }, { ...seed, schemaVersion: 3 }, { ...seed, schemaVersion: '2' },
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
});
