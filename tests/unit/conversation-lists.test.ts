import { describe, expect, it } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { anchoredConversations, researchConversationLists } from '../../src/services/research-agent';
import type { Conversation } from '../../src/domain/types';

describe('会话归属：研究会话与对象讨论', () => {
  it('卡片、白板讨论和未升级的原文旁问答移出主列表并按对象分组；升级后回到主列表', () => {
    const data = createSeed(), evidence = Object.values(data.evidence)[0];
    const add = (id: string, extra: Partial<Conversation>, updatedAt: string) => { data.conversations[id] = { id, researchId: 'research-a', contextIds: [], requestIds: [], title: id, updatedAt, ...extra }; };
    add('card-thread', { anchor: { kind: 'card', id: 'card-a' } }, '2026-10-23T03:00:00Z');
    add('board-thread', { anchor: { kind: 'board', id: 'board-a' } }, '2026-10-23T02:00:00Z');
    add('passage', { inlineSource: { documentId: evidence.documentId, pageIndex: evidence.pageIndex, evidenceId: evidence.id, operation: 'question' } }, '2026-10-23T01:00:00Z');
    add('translation', { inlineSource: { documentId: evidence.documentId, pageIndex: evidence.pageIndex, evidenceId: evidence.id, operation: 'translation' } }, '2026-10-23T04:00:00Z');
    add('promoted', { inlineSource: { documentId: evidence.documentId, pageIndex: evidence.pageIndex, evidenceId: evidence.id, operation: 'question', promoted: true } }, '2026-10-23T05:00:00Z');
    const { main, discussions } = researchConversationLists(data, 'research-a');
    const ids = main.map(item => item.id);
    expect(ids[0]).toBe('promoted');
    expect(ids).not.toContain('card-thread'); expect(ids).not.toContain('board-thread'); expect(ids).not.toContain('passage'); expect(ids).not.toContain('translation');
    expect(discussions.map(group => group.label)).toEqual(['卡片', '白板', data.documents[evidence.documentId].title]);
    expect(discussions[0].items[0].label).toBe(data.cards['card-a'].title);
    expect(discussions[2].items[0].label).toMatch(new RegExp(`^第 ${evidence.pageIndex + 1} 页 · `));
    expect(researchConversationLists(data, 'research-a', data.boards['board-a'].title).discussions.map(group => group.label)).toEqual(['白板']);
    expect(anchoredConversations(data, 'research-a', { kind: 'card', id: 'card-a' }).map(item => item.id)).toEqual(['card-thread']);
  });
});
