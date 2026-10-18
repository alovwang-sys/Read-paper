import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { loadWorkspace } from '../../src/data/storage';
import { migrateWorkspace } from '../../src/data/migrations';
import { findPaneTab, paneGroups } from '../../src/services/panes';
import { workspace } from '../../src/services/workspace';
import type { SourceCandidate } from '../../src/domain/types';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn().mockResolvedValue(undefined), saveMigrationBackup: vi.fn().mockResolvedValue(undefined), getAsset: vi.fn() }));
const scope = { kind: 'research', researchId: 'research-a' } as const;
const session = () => workspace.getSession();
const layout = () => session().layout!;
const groups = () => paneGroups(layout().root);
const paper = { kind: 'document', id: 'paper-a' } as const;
const card = { kind: 'card', id: 'card-a' } as const;
const candidate: SourceCandidate = { kind: 'paper', title: '待判断的研究线索', url: 'https://example.org/paper', authors: 'Example Authors', year: '2026', identifiers: { url: 'https://example.org/paper' } };
const open = (ref: typeof paper | typeof card, paneId?: string) => workspace.openResource(ref, { scope, target: 'main', paneId });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.mocked(loadWorkspace).mockResolvedValue(createSeed());
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('导航页与资源共用窗格', () => {
  it('主页和列表进入当前组，保留其他论文的位置、标签和右侧状态', () => {
    open(paper);
    const original = groups()[0], view = original.tabs.find(tab => tab.ref.kind === 'document')!;
    workspace.setReader(paper.id, { pageIndex: 1, scale: 1.25, offset: .3 }, `view:${view.id}`);
    workspace.splitPane(original.id, 'right');
    const right = groups()[1], before = structuredClone(right);
    workspace.updateData(data => { data.sessions['research-a'].panel = { ...data.sessions['research-a'].panel, mode: 'ai', open: true }; });
    workspace.activatePane(original.id);
    workspace.openResearchView(scope.researchId, 'sources');
    expect(groups()).toHaveLength(2);
    expect(groups().find(pane => pane.id === right.id)).toEqual(before);
    expect(groups()[0].tabs.some(tab => tab.id === view.id)).toBe(true);
    expect(session().active).toEqual({ kind: 'researchView', id: 'sources' });
    expect(session().panel.mode).toBe('ai');
    workspace.openResearchView(scope.researchId, 'home');
    expect(groups()[0].tabs.filter(tab => tab.ref.kind === 'researchView' && tab.ref.id === 'home')).toHaveLength(1);
    expect(groups().find(pane => pane.id === right.id)).toEqual(before);
  });

  it('在非聚焦列表打开卡片时，以所属paneId为准，不改另一组', () => {
    open(paper);
    const first = groups()[0]; workspace.splitPane(first.id, 'right');
    const right = groups()[1];
    workspace.activatePane(first.id); workspace.openResearchView(scope.researchId, 'cards');
    workspace.activatePane(right.id);
    const untouched = structuredClone(groups().find(group => group.id === right.id)!);
    open(card, first.id);
    expect(layout().focusedPaneId).toBe(first.id);
    expect(groups().find(group => group.id === first.id)?.tabs.find(tab => tab.id === groups().find(group => group.id === first.id)?.activeTabId)?.ref).toEqual(card);
    expect(groups().find(group => group.id === right.id)).toEqual(untouched);
  });

  it('预览与分屏不收录文献，恢复后来源与布局仍可用', () => {
    const before = structuredClone(workspace.getState().data);
    workspace.openSourcePreview(candidate, scope);
    const sourcePane = groups()[0];
    expect(sourcePane.tabs.find(tab => tab.id === sourcePane.activeTabId)?.ref.kind).toBe('sourcePreview');
    workspace.splitPane(sourcePane.id, 'down');
    expect(groups()).toHaveLength(2);
    const data = workspace.getState().data;
    expect(data.documents).toEqual(before.documents);
    expect(data.researches[scope.researchId].documentIds).toEqual(before.researches[scope.researchId].documentIds);
    const restored = migrateWorkspace(structuredClone(data));
    expect(paneGroups(restored.sessions['research-a'].layout!.root).flatMap(group => group.tabs).filter(tab => tab.ref.kind === 'sourcePreview').map(tab => tab.preview?.candidate)).toEqual([candidate, candidate]);
  });

  it('引用默认新开视图，有明确viewId才定位，其他同篇位置均保留', () => {
    open(paper); const first = groups()[0], original = first.tabs.find(tab => tab.ref.kind === 'document')!;
    workspace.setReader(paper.id, { pageIndex: 0, scale: 1.25, offset: .2 }, `view:${original.id}`);
    workspace.splitPane(first.id, 'right'); const right = groups()[1], independent = right.tabs[0];
    workspace.setReader(paper.id, { pageIndex: 1, scale: 1.5, offset: .4 }, `view:${independent.id}`);
    workspace.openResource(paper, { scope, target: 'main', paneId: first.id, anchor: { evidenceId: 'evidence-a' } });
    const citation = groups()[0].tabs.find(tab => tab.id === groups()[0].activeTabId)!;
    expect(citation.id).not.toBe(original.id);
    expect(citation.reading?.pageIndex).toBe(2);
    expect(findPaneTab(layout(), original.id)?.tab.reading).toEqual({ pageIndex: 0, scale: 1.25, offset: .2 });
    expect(findPaneTab(layout(), independent.id)?.tab.reading).toEqual({ pageIndex: 1, scale: 1.5, offset: .4 });
    workspace.openResource(paper, { scope, target: 'main', paneId: first.id, viewId: citation.id, anchor: { evidenceId: 'evidence-c' } });
    expect(groups()[0].tabs.filter(tab => tab.ref.kind === 'document')).toHaveLength(2);
    expect(findPaneTab(layout(), citation.id)?.tab.reading?.pageIndex).toBe(1);
    expect(findPaneTab(layout(), original.id)?.tab.reading?.pageIndex).toBe(0);
    expect(findPaneTab(layout(), independent.id)?.tab.reading?.pageIndex).toBe(1);
  });

  it('多标签和单标签自身边缘均复制，取消其他标签不改变此语义', () => {
    workspace.openResearchView(scope.researchId, 'sources'); open(paper); open(card);
    const source = groups()[0], view = source.tabs.find(tab => tab.ref.kind === 'document')!;
    expect(source.tabs.length).toBeGreaterThan(1);
    workspace.movePaneTab(view.id, source.id, 'right');
    expect(findPaneTab(layout(), view.id)?.pane.id).toBe(source.id);
    expect(groups()[1].tabs[0].id).not.toBe(view.id);
    expect(groups()[1].tabs[0].ref).toEqual(paper);
    const second = groups()[1]; workspace.movePaneTab(second.tabs[0].id, second.id, 'down');
    expect(groups()).toHaveLength(3);
    expect(findPaneTab(layout(), second.tabs[0].id)?.pane.id).toBe(second.id);
  });

  it('返回只改变操作窗格，范围切换和备份恢复不丢导航标签', () => {
    open(paper); const left = groups()[0]; workspace.splitPane(left.id, 'right');
    const right = groups()[1]; workspace.activatePane(left.id);
    workspace.openResearchView(scope.researchId, 'sources');
    open(card, left.id);
    const other = structuredClone(groups().find(pane => pane.id === right.id)!);
    workspace.back('main');
    expect(session().active).toEqual({ kind: 'researchView', id: 'sources' });
    expect(groups().find(pane => pane.id === right.id)).toEqual(other);
    const before = structuredClone(layout());
    workspace.switchResearch('research-b'); workspace.switchResearch('research-a');
    expect(layout()).toEqual(before);
    const restored = migrateWorkspace(structuredClone(workspace.getState().data));
    expect(restored.sessions['research-a'].layout).toEqual(before);
  });

  it('点击已有标签后返回，回到刚离开的工作而非旧导航历史', () => {
    open(paper);
    const first = groups()[0], reading = first.tabs.find(tab => tab.ref.kind === 'document')!;
    open(card);
    workspace.activatePane(first.id, reading.id);
    expect(session().active).toEqual(paper);
    workspace.back('main');
    expect(session().active).toEqual(card);
    expect(groups()[0].tabs.find(tab => tab.id === groups()[0].activeTabId)?.ref).toEqual(card);
  });

  it('关闭窗格可撤销，恢复布局不回滚存活阅读位置和共享正文', () => {
    open(paper); const left = groups()[0]; workspace.splitPane(left.id, 'right');
    const right = groups()[1], closed = right.tabs[0];
    workspace.setReader(paper.id, { pageIndex: 1, scale: 1.5, offset: .25 }, `view:${closed.id}`);
    workspace.closePane(right.id);
    expect(groups()).toHaveLength(1); expect(workspace.canUndoPaneLayout()).toBe(true);
    const survivor = groups()[0].tabs.find(tab => tab.ref.kind === 'document')!;
    workspace.setReader(paper.id, { pageIndex: 2, scale: 1, offset: .1 }, `view:${survivor.id}`);
    workspace.updateData(data => { data.cards['card-a'].body = '布局关闭之后继续写的正文'; });
    workspace.undoPaneLayout();
    expect(groups()).toHaveLength(2);
    expect(findPaneTab(layout(), closed.id)?.tab.reading).toEqual({ pageIndex: 1, scale: 1.5, offset: .25 });
    expect(findPaneTab(layout(), survivor.id)?.tab.reading).toEqual({ pageIndex: 2, scale: 1, offset: .1 });
    expect(workspace.getState().data.cards['card-a'].body).toBe('布局关闭之后继续写的正文');
    expect(workspace.canUndoPaneLayout()).toBe(false);
  });

  it('收拢可撤销；新增布局动作和切研究使旧撤销失效', () => {
    open(paper); const left = groups()[0]; workspace.splitPane(left.id, 'right');
    const before = structuredClone(layout().root);
    workspace.mergePanes(left.id); expect(workspace.canUndoPaneLayout()).toBe(true);
    workspace.undoPaneLayout(); expect(layout().root).toEqual(before);
    workspace.mergePanes(left.id); open(card); expect(workspace.canUndoPaneLayout()).toBe(false);
    workspace.splitPane(left.id, 'down'); workspace.mergePanes(left.id);
    workspace.switchResearch('research-b'); workspace.switchResearch('research-a');
    expect(workspace.canUndoPaneLayout()).toBe(false);
    const after = structuredClone(layout()); workspace.undoPaneLayout(); expect(layout()).toEqual(after);
  });
});
