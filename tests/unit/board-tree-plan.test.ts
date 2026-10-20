import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { boardSnapshot, captureBoardContext, parseBoardPlan, previewBoardPlan, validateBoardContext } from '../../src/domain/board-history';
import { layoutBoardTree } from '../../src/domain/board-layout';
import { orderedBoardSiblings } from '../../src/domain/board-structure';
import type { BoardContext, BoardPlan, ContextSnapshot } from '../../src/domain/types';
import { applyBoardProposal, boardChanges, canAutoApplyBoardProposal, restoreBoardChange } from '../../src/services/board-history';
import { moveBoardBranch } from '../../src/services/board-structure';
import { workspace } from '../../src/services/workspace';
import { paneGroups } from '../../src/services/panes';

vi.mock('../../src/data/storage', async importOriginal => ({ ...await importOriginal<object>(), loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn() }));
const data = () => workspace.getState().data;
beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  const seed = createSeed();
  seed.boards['board-a'].layout = 'free';
  Object.assign(seed.placements['placement-a'], { order: 0 });
  Object.assign(seed.placements['placement-b'], { order: 0, parentPlacementId: 'placement-a' });
  Object.assign(seed.placements['placement-c'], { order: 0, parentPlacementId: 'placement-b' });
  vi.mocked(loadWorkspace).mockResolvedValue(seed); await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function base(allowNewCards = false) {
  const context = captureBoardContext(data(), 'research-a', 'board-a', 'board', allowNewCards ? { allowNewCards: true, evidenceIds: ['evidence-a'] } : {});
  const plan: BoardPlan = { summary: '在已有结构上补充可核查的计划', title: context.snapshot.board.title, layout: 'preserve', nodes: context.snapshot.placements.map(p => ({ placementId: p.id, resourceRef: context.resources.find(r => r.ref.kind === p.resourceRef.kind && r.ref.id === p.resourceRef.id)!.ref, group: p.group })), edges: context.snapshot.edges.map(edge => ({ from: context.snapshot.placements.findIndex(p => p.id === edge.fromPlacementId), to: context.snapshot.placements.findIndex(p => p.id === edge.toPlacementId), label: edge.label })) };
  return { context, plan };
}
function store(context: BoardContext, plan: BoardPlan, contextIds = ['evidence-a']) {
  const sources: ContextSnapshot[] = contextIds.map(id => { const e = data().evidence[id], doc = data().documents[e.documentId]; return { evidenceId: id, documentId: e.documentId, documentHash: doc.hash!, title: doc.title, pageIndex: e.pageIndex, quote: e.quote }; });
  workspace.updateData(next => { next.requests.tree = { id: 'tree', researchId: 'research-a', conversationId: 'conversation-research-a', connectionId: 'codex', purpose: 'chat', prompt: '补充方法与评估计划', body: plan.summary, createdAt: new Date().toISOString(), context: sources, evidenceIds: [], status: 'done', boardContext: context, boardProposal: plan }; });
}
const draft = () => ({ card: { title: '评估计划', body: '建议：比较两种方法的输出，指标待确认。', evidenceIds: [] }, group: '评估', parent: 0 });

describe('AI 编辑已有导图的边界与层级协议', () => {
  it('preserve 中省略 parent/order 保留人工归属和顺序；null 明确提升为根', () => {
    const { context, plan } = base();
    expect(previewBoardPlan(context, plan)).toEqual(context.snapshot);
    plan.nodes[1].parent = null;
    const preview = previewBoardPlan(context, plan);
    expect(preview.placements[1].parentPlacementId).toBeUndefined();
    expect(preview.placements[2].parentPlacementId).toBe('placement-b');
  });
  it('省略被移出父节点时提升到最近保留祖先，保留节点与引用身份', () => {
    const { context, plan } = base();
    plan.nodes.splice(1, 1); plan.edges = [];
    const preview = previewBoardPlan(context, plan);
    expect(preview.placements.find(p => p.id === 'placement-c')).toMatchObject({ parentPlacementId: 'placement-a', resourceRef: { kind: 'card', id: 'card-c' } });
  });
  it('AI 移出中间主题时整组子节点占据原位置，不与相邻分支交错', async () => {
    workspace.updateData(next => {
      next.boards['board-a'].layout = 'tree';
      next.placements['a-sibling'] = { ...next.placements['placement-c'], id: 'a-sibling', parentPlacementId: 'placement-a', order: 1 };
      next.placements['z-child'] = { ...next.placements['placement-c'], id: 'z-child', order: 1 };
    });
    const { context, plan } = base();
    plan.nodes = plan.nodes.filter(n => n.placementId !== 'placement-b'); plan.edges = [];
    const expected = ['placement-c', 'z-child', 'a-sibling'];
    expect(orderedBoardSiblings(previewBoardPlan(context, plan).placements, 'placement-a').map(p => p.id)).toEqual(expected);
    store(context, plan); await applyBoardProposal('tree');
    expect(orderedBoardSiblings(boardSnapshot(data(), 'board-a')!.placements, 'placement-a').map(p => p.id)).toEqual(expected);
  });
  it('同序节点应用和恢复副本换 ID 后，呈现顺序仍与预览一致', async () => {
    workspace.updateData(next => { next.boards['board-a'].layout = 'tree'; });
    const { context, plan } = base(true);
    plan.nodes.push({ ...draft(), order: 0 }, { ...draft(), order: 0, card: { ...draft().card, title: '第二项评估' } });
    const preview = previewBoardPlan(context, plan);
    store(context, plan); await applyBoardProposal('tree');
    const applied = boardSnapshot(data(), 'board-a')!;
    const geometry = (items: typeof applied.placements) => layoutBoardTree(items).map(p => ({ title: data().cards[p.resourceRef.id].title, x: p.x, y: p.y }));
    const titles = new Map(preview.placements.map((p, i) => [p.id, plan.nodes[i].card?.title ?? data().cards[p.resourceRef.id].title]));
    expect(geometry(applied.placements)).toEqual(layoutBoardTree(preview.placements).map(p => ({ title: titles.get(p.id), x: p.x, y: p.y })));
    workspace.updateData(next => { next.boards['board-a'].title = '后续修改'; });
    const copyId = await restoreBoardChange(boardChanges(data(), 'board-a')[0].id, 'copy');
    expect(geometry(boardSnapshot(data(), copyId)!.placements)).toEqual(geometry(applied.placements));
  });
  it.each(['cycle', 'self', 'out-of-range', 'fraction', 'negative-order', 'fractional-order'])('拒绝无效树协议 %s', mutation => {
    const { context, plan } = base();
    if (mutation === 'cycle') plan.nodes[0].parent = 2;
    if (mutation === 'self') plan.nodes[0].parent = 0;
    if (mutation === 'out-of-range') plan.nodes[0].parent = 99;
    if (mutation === 'fraction') plan.nodes[0].parent = 0.5;
    if (mutation === 'negative-order') plan.nodes[0].order = -1;
    if (mutation === 'fractional-order') plan.nodes[0].order = 1.5;
    expect(() => parseBoardPlan(JSON.stringify(plan), context)).toThrow();
  });
  it('跨分支语义连线可以成环，不改变层级或强迫树节点重排', () => {
    const { context, plan } = base(); plan.layout = 'tree';
    const positions = previewBoardPlan(context, plan).placements;
    plan.edges = [{ from: 0, to: 2, label: '支持' }, { from: 2, to: 0, label: '待验证' }];
    expect(previewBoardPlan(context, plan).placements).toEqual(positions);
  });
  it('旧编辑快照不隐式开放新增；新卡片仅能引用显式 allowedEvidenceIds', () => {
    const old = base(); old.plan.nodes.push(draft());
    expect(() => parseBoardPlan(JSON.stringify(old.plan), old.context)).toThrow(/新卡片/);
    const { context, plan } = base(true); plan.nodes.push(draft());
    expect(parseBoardPlan(JSON.stringify(plan), context).nodes).toHaveLength(4);
    plan.nodes[3].card!.evidenceIds = ['evidence-b']; plan.nodes[3].card!.body = '错误引用 [1]';
    expect(context.resources.some(r => r.evidenceIds.includes('evidence-b'))).toBe(true);
    expect(context.allowedEvidenceIds).toEqual(['evidence-a']);
    expect(() => parseBoardPlan(JSON.stringify(plan), context)).toThrow(/引用/);
  });
  it('引用编号、资源身份和新旧卡片混合对象均在解析阶段拒绝', () => {
    const { context, plan } = base(true);
    for (const node of [
      { ...draft(), card: { ...draft().card, body: '来源 [2]', evidenceIds: ['evidence-a'] } },
      { ...draft(), resourceRef: { kind: 'card', id: 'card-a' } },
      { resourceRef: { kind: 'card', id: 'missing' }, group: '' },
    ]) expect(() => parseBoardPlan(JSON.stringify({ ...plan, nodes: [...plan.nodes, node] }), context)).toThrow();
  });
  it('空的已有白板可显式允许补充草稿，不需冒充新建白板', () => {
    const seed = structuredClone(data());
    for (const [id, p] of Object.entries(seed.placements)) if (p.boardId === 'board-a') delete seed.placements[id];
    for (const [id, e] of Object.entries(seed.edges)) if (e.boardId === 'board-a') delete seed.edges[id];
    expect(() => captureBoardContext(seed, 'research-a', 'board-a', 'board')).toThrow();
    const context = captureBoardContext(seed, 'research-a', 'board-a', 'board', { allowNewCards: true, evidenceIds: [] });
    validateBoardContext(context, 'research-a');
    expect(context.intent).toBeUndefined(); expect(context.resources).toEqual([]);
    expect(parseBoardPlan(JSON.stringify({ summary: '补充', title: '补充', layout: 'tree', nodes: [{ ...draft(), parent: null }], edges: [] }), context).nodes).toHaveLength(1);
  });
  it.each(['parent', 'order', 'layout', 'title', 'new-card'])('已有白板的 %s 变化均需确认', change => {
    const { context, plan } = base(true);
    if (change === 'parent') plan.nodes[2].parent = 0;
    if (change === 'order') plan.nodes[1].order = 7;
    if (change === 'layout') plan.layout = 'tree';
    if (change === 'title') plan.title = '新标题';
    if (change === 'new-card') plan.nodes.push(draft());
    store(context, plan);
    expect(canAutoApplyBoardProposal('tree')).toBe(false);
  });
  it('新增建议应用同批保存来源与父级；现有正文和另一白板完全不变', async () => {
    const { context, plan } = base(true); plan.nodes.push(draft()); store(context, plan);
    const before = structuredClone(data());
    const changeId = await applyBoardProposal('tree');
    const placed = Object.values(data().placements).find(p => p.boardId === 'board-a' && !context.snapshot.placements.some(old => old.id === p.id))!;
    expect(placed.parentPlacementId).toBe('placement-a');
    expect(data().cards[placed.resourceRef.id]).toMatchObject({ title: '评估计划', evidenceIds: [], needsReview: true, provenance: { requestId: 'tree', researchId: 'research-a' } });
    for (const [id, card] of Object.entries(before.cards)) expect(data().cards[id]).toEqual(card);
    expect(boardSnapshot(data(), 'board-a2')).toEqual(boardSnapshot(before, 'board-a2'));
    expect(data().boardChanges![changeId].createdCards).toHaveLength(1);
    expect(migrateWorkspace(data()).requests.tree.boardContext).toEqual(context);
    expect(await applyBoardProposal('tree')).toBe(changeId);
  });
  it('即使修改快照白名单，未提交的证据不能在应用时偷偷进入新卡片', async () => {
    const { context, plan } = base(true); plan.nodes.push({ ...draft(), card: { title: '越界依据', body: '来源 [1]', evidenceIds: ['evidence-a'] } });
    store(context, plan, []); const before = structuredClone(data());
    await expect(applyBoardProposal('tree')).rejects.toThrow(/材料/);
    expect(data()).toEqual(before);
  });
  it('用户改动分支归属后旧方案拒绝覆盖，折叠视图状态不制造过期', async () => {
    const first = base(true); first.plan.nodes.push(draft()); store(first.context, first.plan);
    workspace.openResource({ kind: 'board', id: 'board-a' }, { target: 'main', scope: { kind: 'research', researchId: 'research-a' } });
    workspace.setViewState({ boardCollapsed: JSON.stringify(['placement-a']) }, paneGroups(data().sessions['research-a'].layout!.root)[0].activeTabId);
    expect(boardChanges(data(), 'board-a')).toHaveLength(0);
    await expect(applyBoardProposal('tree')).resolves.toBeTruthy();
    const next = base(true); next.plan.nodes.push(draft()); store(next.context, next.plan);
    // Use a fresh request identity: replay protection intentionally makes an already applied ID idempotent.
    workspace.updateData(value => { value.requests.stale = { ...value.requests.tree, id: 'stale' }; });
    moveBoardBranch('board-a', 'placement-c', 'placement-a');
    const before = structuredClone(data());
    await expect(applyBoardProposal('stale')).rejects.toThrow(/修改/);
    expect(data()).toEqual(before);
  });
});
