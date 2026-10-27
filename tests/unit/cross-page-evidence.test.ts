import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { getAsset, loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { evidenceGroup, pageRangeLabel } from '../../src/domain/evidence';
import { validateReaderContext } from '../../src/domain/reader-context';
import { createInlineConversation } from '../../src/services/inline-ai';
import { readerActivities } from '../../src/services/reader-actions';
import { snapshotContext, submitAI } from '../../src/services/ai';
import { workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn() }));
const state = () => workspace.getState().data;
const fragments = [
  { documentId: 'paper-a', pageIndex: 0, quote: 'End of the first page.', textAnchor: { start: 5, end: 26 } },
  { documentId: 'paper-a', pageIndex: 1, quote: 'Continuation on the second page.', textAnchor: { start: 0, end: 32 } },
];
beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(saveWorkspace).mockResolvedValue(undefined);
  vi.mocked(getAsset).mockResolvedValue(new Blob(['PDF']));
  const data = createSeed(); data.documents['paper-a'].hash = 'a'.repeat(64);
  vi.mocked(loadWorkspace).mockResolvedValue(data);
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('正反向保存按页排序、整组复用；重叠选区和另一个研究保留各自身份', () => {
  const ids = workspace.captureReaderSelection('research-a', [...fragments].reverse());
  expect(ids.map(id => state().evidence[id].pageIndex)).toEqual([0, 1]);
  expect(workspace.captureReaderSelection('research-a', fragments)).toEqual(ids);
  const groupId = state().evidence[ids[0]].selectionGroupId;
  const overlap = workspace.captureReaderSelection('research-a', [fragments[0], { ...fragments[1], quote: 'Different second fragment.' }]);
  expect(overlap[0]).not.toBe(ids[0]);
  expect(state().evidence[ids[0]].selectionGroupId).toBe(groupId);
  const other = workspace.captureReaderSelection('research-b', fragments);
  expect(other.every(id => !ids.includes(id))).toBe(true);
  expect(state().researches['research-b'].documentIds).toContain('paper-a');
  expect(evidenceGroup(state(), state().evidence[ids[1]]).map(item => item.id)).toEqual(ids);
  expect(pageRangeLabel([1, 0, 1, 3])).toBe('PDF 第 1–2、4 页');
});

it('无效尾片段不会留下部分摘录；整组撤销先检查所有引用', () => {
  const before = Object.keys(state().evidence);
  expect(() => workspace.captureReaderSelection('research-a', [fragments[0], { ...fragments[1], pageIndex: 2000 }])).toThrow();
  expect(Object.keys(state().evidence)).toEqual(before);
  const ids = workspace.captureReaderSelection('research-a', fragments);
  workspace.createCard([ids[1]]);
  expect(() => workspace.removeExcerpt(ids[0])).toThrow('已被引用');
  expect(ids.every(id => state().evidence[id])).toBe(true);
  workspace.setExcerptMarked(ids[1], false);
  expect(ids.every(id => state().evidence[id].annotationHidden)).toBe(true);
  workspace.setExcerptMarked(ids[0], true);
  expect(ids.every(id => !state().evidence[id].annotationHidden)).toBe(true);
  const free = workspace.captureReaderSelection('research-a', fragments.map(item => ({ ...item, quote: `${item.quote} free` })));
  workspace.removeExcerpt(free[1]);
  expect(free.every(id => !state().evidence[id])).toBe(true);
});

it('跨页问答冻结全部来源、各页有记录，刷新与迟到回答不串研究', async () => {
  const id = createInlineConversation('research-a', { ...fragments[0], fragments });
  const ids = state().conversations[id].contextIds;
  expect(ids).toHaveLength(2);
  expect(snapshotContext(state(), 'research-a', id).map(item => item.quote)).toEqual(fragments.map(item => item.quote));
  expect(createInlineConversation('research-a', { ...fragments[0], fragments: [...fragments].reverse() })).toBe(id);
  expect(createInlineConversation('research-a', fragments[0])).not.toBe(id);
  let complete!: () => void;
  const running = submitAI('research-a', id, 'Explain both pages', request => new Promise(resolve => { complete = () => resolve({ body: 'Both pages [1] [2]', evidenceIds: request.context.map(item => item.evidenceId) }); }), { paperBrief: 'none' });
  await vi.waitFor(() => expect(complete).toBeDefined());
  workspace.switchResearch('research-b'); complete();
  const requestId = await running;
  expect(state().requests[requestId].researchId).toBe('research-a');
  expect(state().requests[requestId].context.map(item => item.pageIndex)).toEqual([0, 1]);
  for (const evidenceId of ids) expect(readerActivities(state(), evidenceId).some(item => item.requestId === requestId)).toBe(true);
  const restored = migrateWorkspace(structuredClone(state()));
  expect(restored.conversations[id].inlineSource?.evidenceIds).toEqual(ids);
  expect(evidenceGroup(restored, restored.evidence[ids[1]])).toHaveLength(2);
  restored.conversations[id].inlineSource!.evidenceIds!.push('missing');
  expect(() => validateReaderContext(restored)).toThrow();
});

it('损坏的分组、折叠状态和白板标题草稿被恢复校验阻止', () => {
  const ids = workspace.captureReaderSelection('research-a', fragments);
  const corrupt = structuredClone(state());
  corrupt.evidence[ids[1]].researchId = 'research-b';
  expect(() => validateReaderContext(corrupt)).toThrow('跨页选区');
  const mixed = structuredClone(state());
  mixed.evidence[ids[1]].kind = 'region';
  expect(() => validateReaderContext(mixed)).toThrow('跨页选区');
  const session = state().sessions['research-a'];
  session.discussionGroups = { 'board:board-a': false };
  session.boardTitleDrafts = { 'board-a': '未提交名称' };
  expect(migrateWorkspace(structuredClone(state())).sessions['research-a']).toMatchObject({ discussionGroups: session.discussionGroups, boardTitleDrafts: session.boardTitleDrafts });
  session.discussionGroups['document:paper-a'] = 'yes' as unknown as boolean;
  expect(() => validateReaderContext(state())).toThrow('讨论分组');
});

it('白板改名只改变标题，空名和超长名称保留原白板', () => {
  const before = structuredClone(state().boards['board-a']);
  workspace.renameBoard('board-a', '  新的白板名称  ');
  expect(state().boards['board-a']).toEqual({ ...before, title: '新的白板名称' });
  expect(() => workspace.renameBoard('board-a', '  ')).toThrow();
  expect(() => workspace.renameBoard('board-a', 'a'.repeat(161))).toThrow();
  expect(state().boards['board-a'].title).toBe('新的白板名称');
});
