import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { loadWorkspace } from '../../src/data/storage';
import { workspace, registerReaderFlush } from '../../src/services/workspace';
import { findPaneTab, getReaderPosition, paneGroups, syncPaneSession, validatePaneLayout } from '../../src/services/panes';
import type { WorkspaceLayout } from '../../src/domain/types';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn().mockResolvedValue(undefined), getAsset: vi.fn() }));
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.mocked(loadWorkspace).mockResolvedValue(createSeed());
  await workspace.load();
  workspace.openResource({ kind: 'document', id: 'paper-a' }, { scope: { kind: 'research', researchId: 'research-a' }, target: 'main' });
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const layout = () => workspace.getSession().layout!;
const groups = () => paneGroups(layout().root);

describe('窗格与独立阅读视图', () => {
  it('任意窗格可继续拆分，复制视图保留位置且不复制文献', () => {
    const first = groups()[0], tab = first.tabs.find(tab => tab.id === first.activeTabId)!;
    workspace.setReader('paper-a', { pageIndex: 1, scale: 1.25, offset: 0.4 }, `view:${tab.id}`);
    for (const side of ['right', 'down', 'left', 'up', 'right', 'down'] as const) workspace.splitPane(layout().focusedPaneId, side);
    expect(groups()).toHaveLength(7);
    expect(Object.keys(workspace.getState().data.documents)).toHaveLength(4);
    const views = groups().flatMap(group => group.tabs).filter(tab => tab.ref.id === 'paper-a');
    expect(new Set(views.map(tab => tab.id)).size).toBe(7);
    expect(views.every(tab => tab.reading?.offset === 0.4)).toBe(true);
    workspace.setReader('paper-a', { pageIndex: 2, scale: 0.75, offset: 0.2 }, `view:${views[6].id}`);
    expect(getReaderPosition(workspace.getSession(), 'paper-a', `view:${views[0].id}`).pageIndex).toBe(1);
    validatePaneLayout(workspace.getState().data, 'research-a');
  });
  it('复制前读取最新待写位置，旧注册退出不能删除新注册', () => {
    const pane = groups()[0], tab = pane.tabs.find(tab => tab.id === pane.activeTabId)!;
    const stale = registerReaderFlush('fixture-view', () => { throw new Error('stale flush'); });
    const release = registerReaderFlush('fixture-view', () => workspace.setReader('paper-a', { pageIndex: 1, scale: 1, offset: 0.61 }, `view:${tab.id}`));
    stale(); workspace.splitPane(pane.id, 'right'); release();
    expect(groups()[1].tabs[0].reading).toEqual({ pageIndex: 1, scale: 1, offset: 0.61 });
  });
  it('标签移动保留身份、最后空组收起，同组gap索引正确且复制产生新身份', () => {
    const pane = groups()[0];
    workspace.openResource({ kind: 'card', id: 'card-a' }, { scope: { kind: 'research', researchId: 'research-a' }, target: 'main' });
    workspace.splitPane(pane.id, 'right');
    const second = groups()[1], moving = second.tabs[0];
    workspace.movePaneTab(moving.id, pane.id, 'center', false, 0);
    expect(groups()).toHaveLength(1);
    expect(groups()[0].tabs[0].id).toBe(moving.id);
    const total = paneGroups(layout().root)[0].tabs.length;
    workspace.movePaneTab(moving.id, pane.id, 'center', false, total);
    expect(groups()[0].tabs.at(-1)?.id).toBe(moving.id);
    workspace.movePaneTab(moving.id, pane.id, 'down', true);
    expect(groups()).toHaveLength(2);
    expect(groups()[1].tabs[0].id).not.toBe(moving.id);
    expect(groups()[1].tabs[0].ref).toEqual(moving.ref);
  });
  it('合并保留同篇不同位置，放大不改变树，关闭一个副本不删资料', () => {
    const first = groups()[0]; workspace.splitPane(first.id, 'down');
    const second = groups()[1], tab = second.tabs[0];
    workspace.setReader('paper-a', { pageIndex: 2, scale: 1, offset: 0.5 }, `view:${tab.id}`);
    const tree = structuredClone(layout().root);
    workspace.togglePaneZoom(first.id); expect(layout().root).toEqual(tree);
    workspace.togglePaneZoom(first.id); expect(layout().zoomedPaneId).toBeUndefined();
    workspace.mergePanes(first.id);
    expect(groups()).toHaveLength(1);
    expect(groups()[0].tabs.filter(tab => tab.ref.id === 'paper-a')).toHaveLength(2);
    expect(findPaneTab(layout(), tab.id)?.tab.reading?.pageIndex).toBe(2);
    workspace.closePaneTab(first.id, tab.id);
    expect(workspace.getState().data.documents['paper-a']).toBeDefined();
    expect(groups()[0].tabs.some(item => item.ref.id === 'paper-a')).toBe(true);
  });
  it('激活窗格后新资源进入该组，迟到位置仍归原研究且已关闭视图不复活', () => {
    const first = groups()[0]; workspace.splitPane(first.id, 'right'); const second = groups()[1];
    workspace.activatePane(first.id);
    workspace.openResource({ kind: 'card', id: 'card-a' }, { scope: { kind: 'research', researchId: 'research-a' }, target: 'main' });
    expect(groups()[0].tabs.some(tab => tab.ref.id === 'card-a')).toBe(true);
    expect(groups()[1].tabs).toHaveLength(1);
    const id = second.tabs[0].id;
    workspace.switchResearch('research-b');
    workspace.setReader('paper-a', { pageIndex: 1, scale: 1, offset: 0.3 }, `view:${id}`, { kind: 'research', researchId: 'research-a' });
    expect(workspace.getSession().openItems).toHaveLength(0);
    workspace.switchResearch('research-a'); expect(findPaneTab(layout(), id)?.tab.reading?.offset).toBe(0.3);
    workspace.closePaneTab(second.id, id);
    workspace.setReader('paper-a', { pageIndex: 0, scale: 1 }, `view:${id}`);
    expect(findPaneTab(layout(), id)).toBeUndefined();
  });
  it('旧双窗迁移保留两位置，拒绝坏树、跨研究、错误来源及重复视图身份', () => {
    const seed = createSeed(); const session = seed.sessions['research-a'];
    session.active = { kind: 'document', id: 'paper-a' };
    session.readers['main:paper-a'] = { pageIndex: 1, scale: 1, offset: 0.2 };
    session.readers['main-secondary:paper-a'] = { pageIndex: 2, scale: 1.5, offset: 0.6 };
    session.mainSplit = { layout: 'horizontal', ref: { kind: 'document', id: 'paper-a' } };
    const migrated = migrateWorkspace(seed);
    expect(paneGroups(migrated.sessions['research-a'].layout!.root).map(group => group.tabs.find(tab => tab.ref.id === 'paper-a')?.reading?.pageIndex)).toEqual([1, 2]);
    expect(migrateWorkspace(migrated)).toEqual(migrated);
    const invalid = (change: (value: WorkspaceLayout) => void) => { const copy = structuredClone(migrated); change(copy.sessions['research-a'].layout!); expect(() => migrateWorkspace(copy)).toThrow('窗格'); };
    invalid(value => { value.focusedPaneId = 'missing'; });
    invalid(value => { if (value.root.kind === 'split') value.root.ratio = NaN; });
    invalid(value => { const groups = paneGroups(value.root); groups[1].tabs[0].id = groups[0].tabs[0].id; });
    const cross = structuredClone(migrated); cross.sessions['research-b'].layout = migrated.sessions['research-a'].layout; expect(() => migrateWorkspace(cross)).toThrow('窗格');
  });
  it('旧主区不在前台的同篇标签也保留，切换副窗不覆盖它的位置', () => {
    const seed = createSeed(), session = seed.sessions['research-a'];
    session.active = { kind: 'card', id: 'card-a' };
    session.openItems = [{ kind: 'document', id: 'paper-a' }, session.active];
    session.readers['main:paper-a'] = { pageIndex: 1, scale: 1, offset: .25 };
    session.readers['main-secondary:paper-a'] = { pageIndex: 2, scale: 1, offset: .6 };
    session.mainSplit = { layout: 'horizontal', ref: { kind: 'document', id: 'paper-a' } };
    const migrated = migrateWorkspace(seed), panes = paneGroups(migrated.sessions['research-a'].layout!.root);
    expect(panes.flatMap(pane => pane.tabs).filter(tab => tab.ref.id === 'paper-a').map(tab => tab.reading)).toEqual([
      { pageIndex: 1, scale: 1, offset: .25 }, { pageIndex: 2, scale: 1, offset: .6 },
    ]);
    migrated.sessions['research-a'].layout!.focusedPaneId = panes[1].id;
    syncPaneSession(migrated.sessions['research-a']);
    expect(panes[0].tabs[0].reading).toEqual({ pageIndex: 1, scale: 1, offset: .25 });
  });
  it('取消未使用的摘录清除各视图定位引用，保留页码和阅读位置并可刷新', () => {
    const evidenceId = workspace.captureExcerpt('research-a', { documentId: 'paper-a', pageIndex: 1, quote: '尚未使用的摘录' });
    workspace.openResource({ kind: 'document', id: 'paper-a' }, { scope: { kind: 'research', researchId: 'research-a' }, target: 'main', anchor: { evidenceId, pageIndex: 1 } });
    workspace.splitPane(groups()[0].id, 'right');
    workspace.openResource({ kind: 'document', id: 'paper-a' }, { scope: { kind: 'research', researchId: 'research-a' }, target: 'inspector', anchor: { evidenceId, pageIndex: 1 } });
    workspace.removeExcerpt(evidenceId);
    const data = workspace.getState().data;
    expect(data.evidence[evidenceId]).toBeUndefined();
    const views = groups().flatMap(pane => pane.tabs).filter(tab => tab.ref.id === 'paper-a');
    expect(views).toHaveLength(2);
    expect(views.every(tab => !tab.anchor?.evidenceId && tab.reading?.pageIndex === 1)).toBe(true);
    expect(workspace.getSession().panel.anchor).toEqual({ pageIndex: 1 });
    expect(() => migrateWorkspace(data)).not.toThrow();
  });
  it('白板打开资料的摆放来源可恢复，移出白板仅清理定位，错误映射仍拒绝', () => {
    workspace.updateData(data => { data.placements['pane-source'] = { id: 'pane-source', boardId: 'board-a', resourceRef: { kind: 'document', id: 'paper-a' }, x: 0, y: 0, group: '' }; });
    workspace.openResource({ kind: 'document', id: 'paper-a' }, { scope: { kind: 'research', researchId: 'research-a' }, target: 'main', anchor: { placementId: 'pane-source' } });
    const data = structuredClone(workspace.getState().data);
    expect(() => migrateWorkspace(data)).not.toThrow();
    const bad = structuredClone(data); bad.placements['pane-source'].resourceRef = { kind: 'card', id: 'card-a' };
    expect(() => migrateWorkspace(bad)).toThrow('窗格');
    delete data.placements['pane-source'];
    const restored = migrateWorkspace(data), tab = paneGroups(restored.sessions['research-a'].layout!.root)[0].tabs.find(tab => tab.ref.id === 'paper-a')!;
    expect(tab.anchor?.placementId).toBeUndefined();
    expect(restored.documents['paper-a']).toBeDefined();
  });
});
