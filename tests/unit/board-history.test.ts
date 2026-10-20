import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { boardSnapshot, captureBoardContext, parseBoardPlan, previewBoardPlan } from '../../src/domain/board-history';
import type { BoardPlan } from '../../src/domain/types';
import { applyBoardProposal, boardChanges, restoreBoardChange } from '../../src/services/board-history';
import { workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn() }));
const memory = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
beforeEach(async () => {
  vi.useFakeTimers(); memory.clear();
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(createSeed());
  await workspace.load();
  expect(workspace.getState().loadError).toBeUndefined();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); });
function proposed() {
  const context = captureBoardContext(workspace.getState().data, 'research-a', 'board-a', 'research');
  const plan: BoardPlan = { summary: '按论证关系整理', title: '研究架构', layout: 'flow',
    nodes: context.snapshot.placements.map(p => ({ placementId: p.id, resourceRef: context.resources.find(r => r.ref.kind === p.resourceRef.kind && r.ref.id === p.resourceRef.id)!.ref, group: '论证' })),
    edges: [{ from: 0, to: 1, label: '适用边界' }, { from: 1, to: 2, label: '核查' }] };
  return { context, plan };
}
function request() {
  const { context, plan } = proposed();
  workspace.updateData(data => {
    data.requests.proposal = { id: 'proposal', researchId: 'research-a', conversationId: 'conversation-research-a', connectionId: 'codex', purpose: 'chat', prompt: '整理白板', body: plan.summary, createdAt: new Date().toISOString(), context: [], evidenceIds: [], status: 'done', boardContext: context, boardProposal: plan };
  });
  return { context, plan };
}

describe('白板提案与版本恢复', () => {
  it('无文字连线可省略标签，仍拒绝错误类型、无效端点和重复连线', () => {
    const { context, plan } = proposed();
    for (const label of [undefined, null, '', '   ']) {
      const parsed = parseBoardPlan(JSON.stringify({ ...plan, edges: [{ from: 0, to: 1, label }] }), context);
      expect(parsed.edges).toEqual([{ from: 0, to: 1, label: '' }]);
    }
    for (const edge of [{ from: 0, to: 1, label: 2 }, { from: 0, to: 99 }, { from: 0, to: 0 }, null])
      expect(() => parseBoardPlan(JSON.stringify({ ...plan, edges: [edge] }), context)).toThrow();
    expect(() => parseBoardPlan(JSON.stringify({ ...plan, edges: [{ from: 0, to: 1 }, { from: 0, to: 1, label: ' ' }] }), context)).toThrow();
  });
  it('预览不写入；一次应用与一条历史共同持久化，重试不重复，全局正文及其他白板不变', async () => {
    const { context, plan } = request(), before = structuredClone(workspace.getState().data);
    expect(previewBoardPlan(context, plan).board.title).toBe('研究架构');
    expect(workspace.getState().data).toEqual(before);
    const id = await applyBoardProposal('proposal'), data = workspace.getState().data;
    expect(data.boards['board-a'].title).toBe('研究架构');
    expect(data.boardChanges?.[id]).toMatchObject({ actor: 'codex', requestId: 'proposal', revision: 1, before: context.snapshot, after: boardSnapshot(data, 'board-a') });
    expect(boardSnapshot(data, 'board-a2')).toEqual(boardSnapshot(before, 'board-a2'));
    expect(boardSnapshot(data, 'board-b')).toEqual(boardSnapshot(before, 'board-b'));
    for (const key of ['cards', 'evidence', 'documents', 'researches'] as const) expect(data[key]).toEqual(before[key]);
    expect(await applyBoardProposal('proposal')).toBe(id);
    expect(boardChanges(workspace.getState().data, 'board-a')).toHaveLength(1);
    const saved = vi.mocked(saveWorkspace).mock.calls.at(-1)![0];
    expect(saved.boardChanges?.[id].after).toEqual(boardSnapshot(saved, 'board-a'));
    vi.mocked(loadWorkspace).mockResolvedValue(saved);
    await workspace.load();
    expect(workspace.getState().data.boardChanges?.[id]).toEqual(saved.boardChanges?.[id]);
  });
  it('人工移动/分组产生历史；输入和视口变动不增加白板版本', () => {
    workspace.updateData(data => { data.placements['placement-a'].x = 210; data.placements['placement-a'].group = '人工'; });
    expect(boardChanges(workspace.getState().data, 'board-a')).toHaveLength(1);
    workspace.updateData(data => { data.conversations['conversation-research-a'].input = '保留'; data.sessions['research-a'].viewports['board-a'] = { x: 8, y: 9, scale: 0.8 }; });
    expect(boardChanges(workspace.getState().data, 'board-a')).toHaveLength(1);
  });
  it('仅存在于旧白板版本的论文仍受到全局删除保护', () => {
    const id = workspace.addSource({ kind: 'title', title: '历史中的材料' }, { kind: 'research', researchId: 'research-a' }).documentId;
    workspace.updateData(data => { data.placements.historical = { id: 'historical', boardId: 'board-a', resourceRef: { kind: 'document', id }, x: 0, y: 0, group: '' }; });
    workspace.updateData(data => { delete data.placements.historical; });
    workspace.removeDocumentFromResearch('research-a', id);
    expect(() => workspace.deleteDocument(id)).toThrow(/引用/);
    expect(workspace.getState().data.documents[id]).toBeDefined();
  });
  it.each([false, true])('无全文资料合并同步迁移白板历史引用，布局可恢复，历史保留=%s', async historical => {
    const id = workspace.addSource({ kind: 'title', title: '历史中的无全文条目' }, { kind: 'research', researchId: 'research-a' }).documentId;
    workspace.updateData(data => { data.placements.stub = { id: 'stub', boardId: 'board-a', resourceRef: { kind: 'document', id }, x: 0, y: 0, group: '' }; });
    workspace.updateData(data => { data.placements.stub.x = 90; });
    if (historical) workspace.updateData(data => { delete data.placements.stub; });
    workspace.mergeDocuments(id, 'paper-a');
    const data = workspace.getState().data, history = boardChanges(data, 'board-a');
    expect(data.documents[id]).toBeUndefined();
    expect(history.flatMap(change => [change.before, change.after]).flatMap(snapshot => snapshot?.placements ?? []).some(p => p.resourceRef.id === id)).toBe(false);
    expect(migrateWorkspace(data).boardChanges).toEqual(data.boardChanges);
    await restoreBoardChange(history[0].id);
    expect(workspace.getState().data.placements.stub).toMatchObject({ resourceRef: { kind: 'document', id: 'paper-a' }, x: historical ? 90 : 0, y: 0, group: '' });
  });
  it('当前版本可恢复，恢复自身产生新记录，刷新保存完整', async () => {
    const { context } = request(), id = await applyBoardProposal('proposal');
    await restoreBoardChange(id);
    expect(boardSnapshot(workspace.getState().data, 'board-a')).toEqual(context.snapshot);
    const history = boardChanges(workspace.getState().data, 'board-a');
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ restores: id, revision: 2 });
    // Restoring the restore is a normal, recorded redo.
    await restoreBoardChange(history[0].id);
    expect(workspace.getState().data.boards['board-a'].title).toBe('研究架构');
  });
  it('历史之后有人修改时拒绝覆盖，恢复副本使用独立摆放和连线ID', async () => {
    const { context } = request(), id = await applyBoardProposal('proposal');
    workspace.updateData(data => { data.placements['placement-a'].x = 777; });
    const current = boardSnapshot(workspace.getState().data, 'board-a');
    await expect(restoreBoardChange(id)).rejects.toThrow(/冲突/);
    const copyId = await restoreBoardChange(id, 'copy'), data = workspace.getState().data;
    expect(boardSnapshot(data, 'board-a')).toEqual(current);
    const copy = boardSnapshot(data, copyId)!;
    expect(copy.placements.map(p => p.resourceRef)).toEqual(expect.arrayContaining(context.snapshot.placements.map(p => p.resourceRef)));
    expect(copy.placements.every(p => !context.snapshot.placements.some(old => old.id === p.id))).toBe(true);
    expect(copy.edges.every(e => copy.placements.some(p => p.id === e.fromPlacementId) && copy.placements.some(p => p.id === e.toPlacementId))).toBe(true);
    expect(await restoreBoardChange(id, 'copy')).toBe(copyId);
  });
  it('应用和恢复保存失败后可重试同一批次，不伪报成功或生成重复记录', async () => {
    request(); vi.mocked(saveWorkspace).mockRejectedValue(new Error('quota exhausted'));
    await expect(applyBoardProposal('proposal')).rejects.toThrow(/quota/);
    expect(workspace.getState().saveStatus).toBe('error');
    const id = boardChanges(workspace.getState().data, 'board-a')[0].id;
    vi.mocked(saveWorkspace).mockResolvedValue(undefined);
    expect(await applyBoardProposal('proposal')).toBe(id);
    vi.mocked(saveWorkspace).mockRejectedValue(new Error('quota exhausted'));
    await expect(restoreBoardChange(id)).rejects.toThrow(/quota/);
    expect(boardChanges(workspace.getState().data, 'board-a')).toHaveLength(2);
    vi.mocked(saveWorkspace).mockResolvedValue(undefined);
    await restoreBoardChange(id);
    expect(boardChanges(workspace.getState().data, 'board-a')).toHaveLength(2);
    expect(workspace.getState().saveStatus).toBe('saved');
  });
  it.each(['board', 'card', 'membership'])('生成后%s变化拒绝应用，当前修改完整保留', async kind => {
    request();
    workspace.updateData(data => {
      if (kind === 'board') data.placements['placement-a'].x++;
      if (kind === 'card') data.cards['card-a'].body += '人工新内容';
      if (kind === 'membership') data.researches['research-a'].cardIds = data.researches['research-a'].cardIds.filter(id => id !== 'card-a');
    });
    const before = structuredClone(workspace.getState().data);
    await expect(applyBoardProposal('proposal')).rejects.toThrow(/修改|移出/);
    expect(workspace.getState().data).toEqual(before);
  });
  it('切研究后应用仍只影响原研究；来源缺失或移出研究时不能恢复', async () => {
    request(); workspace.switchResearch('research-b');
    const id = await applyBoardProposal('proposal');
    expect(workspace.getState().data.scope).toEqual({ kind: 'research', researchId: 'research-b' });
    workspace.updateData(data => { data.researches['research-a'].cardIds = []; });
    await expect(restoreBoardChange(id)).rejects.toThrow(/重新关联/);
    expect(boardChanges(workspace.getState().data, 'board-a')).toHaveLength(1);
  });
  it('拒绝越界材料、重复摆放、无效连线和过量输入，循环图也能确定性排布', () => {
    const { context, plan } = proposed();
    const invalid = [
      { ...plan, nodes: [{ resourceRef: { kind: 'card', id: 'other-research-card' }, group: '' }] },
      { ...plan, nodes: [plan.nodes[0], plan.nodes[0]] },
      { ...plan, edges: [{ from: 0, to: 99, label: '' }] },
      { ...plan, edges: [{ from: 0, to: 0, label: '' }] },
      { ...plan, nodes: Array(81).fill(plan.nodes[0]) },
    ];
    for (const value of invalid) expect(() => parseBoardPlan(JSON.stringify(value), context)).toThrow();
    const cycle = { ...plan, edges: [{ from: 0, to: 1, label: '' }, { from: 1, to: 0, label: '' }] };
    const preview = previewBoardPlan(context, cycle);
    expect(preview.placements.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(new Set(preview.placements.map(p => `${p.x},${p.y}`)).size).toBe(preview.placements.length);
  });
  it('旧schema3无需白板历史，新历史和请求可迁移；损坏端点、版本号或scope拒绝读取', async () => {
    expect(migrateWorkspace(createSeed()).boardChanges).toBeUndefined();
    request(); await applyBoardProposal('proposal');
    const data = structuredClone(workspace.getState().data);
    expect(migrateWorkspace(data).boardChanges).toEqual(data.boardChanges);
    for (const mutate of [
      (copy: typeof data) => { Object.values(copy.boardChanges!)[0].after!.edges[0].toPlacementId = 'missing'; },
      (copy: typeof data) => { copy.boardRevisions!['board-a'] = 0; },
      (copy: typeof data) => { Object.assign(copy.conversations['conversation-research-a'], { boardSkill: { boardId: 'board-a', scope: 'everything' } }); },
      (copy: typeof data) => { copy.requests.proposal.boardContext!.researchId = 'research-b'; },
      (copy: typeof data) => {
        const change = Object.values(copy.boardChanges!)[0];
        change.boardId = '__proto__'; change.after = null; change.before!.board.id = '__proto__';
        change.before!.placements = []; change.before!.edges = [];
        copy.boardRevisions = JSON.parse('{"__proto__":1}');
      },
    ]) { const copy = structuredClone(data); mutate(copy); expect(() => migrateWorkspace(copy)).toThrow(); }
  });
});
