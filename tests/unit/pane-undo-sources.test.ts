import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { loadWorkspace } from '../../src/data/storage';
import { paneGroups } from '../../src/services/panes';
import { workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', () => ({
  loadWorkspace: vi.fn(),
  saveWorkspace: vi.fn().mockResolvedValue(undefined),
  saveMigrationBackup: vi.fn().mockResolvedValue(undefined),
  getAsset: vi.fn(),
}));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.mocked(loadWorkspace).mockResolvedValue(createSeed());
  await workspace.load();
});
afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('删除已关闭窗格的来源摘录后，使旧布局撤销失效，刷新仍可恢复', () => {
  const scope = { kind: 'research', researchId: 'research-a' } as const;
  const evidenceId = workspace.captureExcerpt(scope.researchId, {
    documentId: 'paper-a', pageIndex: 0, quote: '未被卡片或对话引用的临时摘录',
  });
  const groups = () => paneGroups(workspace.getSession().layout!.root);
  const firstPaneId = groups()[0].id;
  workspace.openResource({ kind: 'document', id: 'paper-a' }, {
    scope, target: 'main', paneId: firstPaneId, split: 'right', anchor: { evidenceId },
  });
  workspace.closePane(groups()[1].id);
  expect(workspace.canUndoPaneLayout()).toBe(true);

  workspace.removeExcerpt(evidenceId);
  expect(workspace.getState().data.evidence[evidenceId]).toBeUndefined();
  expect(workspace.canUndoPaneLayout()).toBe(false);
  workspace.undoPaneLayout();
  expect(groups()).toHaveLength(1);
  expect(() => migrateWorkspace(structuredClone(workspace.getState().data))).not.toThrow();
});
