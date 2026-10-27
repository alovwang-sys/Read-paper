import { describe, expect, it } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { anchoredConversations, researchConversationLists, splitByRecency } from '../../src/services/research-agent';
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
    expect(ids).toContain('promoted');
    expect(ids).not.toContain('card-thread'); expect(ids).not.toContain('board-thread'); expect(ids).not.toContain('passage'); expect(ids).not.toContain('translation');
    expect(discussions.map(group => group.label)).toEqual(['卡片', data.boards['board-a'].title, data.documents[evidence.documentId].title]);
    expect(discussions.map(group => group.key)).toEqual(['card', 'board:board-a', `document:${evidence.documentId}`]);
    expect(discussions[0].items[0].label).toBe(data.cards['card-a'].title);
    expect(discussions[2].items[0].label).toMatch(new RegExp(`^第 ${evidence.pageIndex + 1} 页 · `));
    expect(researchConversationLists(data, 'research-a', data.boards['board-a'].title).discussions.map(group => group.label)).toEqual([data.boards['board-a'].title]);
    expect(anchoredConversations(data, 'research-a', { kind: 'card', id: 'card-a' }).map(item => item.id)).toEqual(['card-thread']);
  });
  it('同名白板和论文按稳定来源 ID 分组；改名与新回答不改变组标识，研究各自隔离', () => {
    const data = createSeed();
    data.boards['board-a'].title = data.boards['board-a2'].title = '同名白板';
    data.documents['paper-a'].title = data.documents['paper-b'].title = '同名论文';
    const add = (id: string, extra: Partial<Conversation>) => { data.conversations[id] = { id, researchId: 'research-a', contextIds: [], requestIds: [], title: id, ...extra }; };
    add('board-1', { anchor: { kind: 'board', id: 'board-a' } });
    add('board-2', { anchor: { kind: 'board', id: 'board-a2' } });
    add('paper-1', { inlineSource: { documentId: 'paper-a', pageIndex: 0, evidenceId: 'evidence-a', operation: 'question' } });
    add('paper-2', { inlineSource: { documentId: 'paper-b', pageIndex: 1, evidenceId: 'missing-evidence', operation: 'question' } });
    add('other-research', { researchId: 'research-b', anchor: { kind: 'board', id: 'board-a' } });
    expect(researchConversationLists(data, 'research-a').discussions.map(group => group.key).sort()).toEqual(['board:board-a', 'board:board-a2', 'document:paper-a', 'document:paper-b']);
    data.boards['board-a'].title = '改名后的白板';
    data.conversations['board-1'].updatedAt = '2026-10-24T12:00:00Z';
    const changed = researchConversationLists(data, 'research-a').discussions.find(group => group.key === 'board:board-a')!;
    expect(changed.label).toBe('改名后的白板'); expect(changed.items.map(item => item.conversation.id)).toEqual(['board-1']);
    expect(researchConversationLists(data, 'research-a', '改名后的白板').discussions.map(group => group.key)).toEqual(['board:board-a']);
    expect(researchConversationLists(data, 'research-b').discussions.find(group => group.key === 'board:board-a')!.items.map(item => item.conversation.id)).toEqual(['other-research']);
  });
  it('跨页原文讨论显示全部来源页码，仍归入同一篇论文', () => {
    const data = createSeed();
    data.conversations['cross-page'] = { id: 'cross-page', researchId: 'research-a', contextIds: ['evidence-c', 'evidence-a'], requestIds: [],
      inlineSource: { documentId: 'paper-a', pageIndex: 1, evidenceId: 'evidence-c', evidenceIds: ['evidence-c', 'evidence-a'], operation: 'question' } };
    const group = researchConversationLists(data, 'research-a').discussions[0];
    expect(group.key).toBe('document:paper-a');
    expect(group.items[0].label).toMatch(/^PDF 第 2–3 页 · /);
  });
  it('14 天没有活动的研究会话收进"更早"；以最后活动为准，时间未知按旧处理', () => {
    const data = createSeed(), now = Date.parse('2026-10-23T12:00:00Z'), day = 86_400_000;
    const at = (offset: number) => new Date(now - offset * day).toISOString();
    const add = (id: string, extra: Partial<Conversation>) => { data.conversations[id] = { id, researchId: 'research-a', contextIds: [], requestIds: [], ...extra }; };
    add('fresh', { updatedAt: at(1) }); add('edge', { updatedAt: at(13.9) }); add('stale', { updatedAt: at(15) }); add('unknown', {});
    add('by-request', { requestIds: ['late'] });
    data.requests.late = { id: 'late', researchId: 'research-a', conversationId: 'by-request', prompt: 'q', body: 'a', status: 'done', createdAt: at(2), context: [], evidenceIds: [] };
    const ids = (list: Conversation[]) => list.map(item => item.id).sort();
    const { recent, earlier } = splitByRecency(data, ['fresh', 'edge', 'stale', 'unknown', 'by-request'].map(id => data.conversations[id]), now);
    expect(ids(recent)).toEqual(['by-request', 'edge', 'fresh']);
    expect(ids(earlier)).toEqual(['stale', 'unknown']);
  });
});
