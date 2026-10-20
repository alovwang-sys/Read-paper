import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { researchResourceIds } from '../../src/domain/research-order';
import { contentHash, loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { workspace } from '../../src/services/workspace';
import { paneGroups } from '../../src/services/panes';
import { createWorkspaceBackup, readWorkspaceBackup, type BackupAsset } from '../../src/services/backup';
import { researchFileData } from '../../src/services/project-files';

vi.mock('../../src/data/storage', async original => ({ ...await original<object>(), loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn() }));
const data = () => workspace.getState().data;
let assets: BackupAsset[];
beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  const seed = createSeed(); assets = [];
  for (const doc of Object.values(seed.documents)) if (doc.assetId) {
    const blob = new Blob([`%PDF-1.7\n${doc.id}`], { type: 'application/pdf' });
    doc.hash = await contentHash(await blob.arrayBuffer()); assets.push({ id: doc.assetId, blob });
  }
  seed.drafts.extra = { ...seed.drafts['draft-a'], id: 'extra', title: '另一个文稿' };
  vi.mocked(saveWorkspace).mockResolvedValue(undefined);
  vi.mocked(loadWorkspace).mockResolvedValue(seed); await workspace.load();
  expect(workspace.getState().loadError).toBeUndefined();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('人工资源顺序', () => {
  it('卡片调序保留关闭窗格的撤销，恢复窗格不回滚人工顺序', () => {
    workspace.openResearchView('research-a', 'cards');
    const first = paneGroups(data().sessions['research-a'].layout!.root)[0];
    workspace.splitPane(first.id, 'right');
    const before = structuredClone(data().sessions['research-a'].layout!);
    const second = paneGroups(before.root)[1];
    workspace.closePane(second.id);
    expect(workspace.canUndoPaneLayout()).toBe(true);
    workspace.moveResearchResource('research-a', 'card', 'card-c', 'card-a', 'before');
    expect(workspace.canUndoPaneLayout()).toBe(true);
    workspace.undoPaneLayout();
    expect(data().sessions['research-a'].layout).toEqual(before);
    expect(data().researches['research-a'].cardIds[0]).toBe('card-c');
  });
  it('旧数据保持初始顺序，新建追加，记住已删除的 ID 不会让它重新出现', () => {
    expect(researchResourceIds(data(), 'research-a', 'board')).toEqual(['board-a', 'board-a2']);
    workspace.moveResearchResource('research-a', 'board', 'board-a2', 'board-a', 'before');
    workspace.updateData(next => {
      next.boards.added = { id: 'added', researchId: 'research-a', title: '新板' };
      next.researches['research-a'].boardOrder!.push('removed');
    });
    expect(researchResourceIds(migrateWorkspace(data()), 'research-a', 'board')).toEqual(['board-a2', 'board-a', 'added']);
  });

  it('各类排序只改变本研究次序，不改共享正文、摆放、引用或当前未保存会话', () => {
    workspace.updateData(next => { next.conversations['conversation-research-a'].input = '尚未提交'; });
    const before = structuredClone(data());
    workspace.moveResearchResource('research-a', 'board', 'board-a2', 'board-a', 'before');
    workspace.moveResearchResource('research-a', 'draft', 'extra', 'draft-a', 'before');
    workspace.moveResearchResource('research-a', 'card', 'card-a', 'card-c', 'after');
    expect(researchResourceIds(data(), 'research-a', 'card')).toEqual(['card-b', 'card-c', 'card-a', 'card-unverified']);
    for (const key of ['cards', 'boards', 'drafts', 'placements', 'edges', 'sessions', 'conversations', 'evidence'] as const) expect(data()[key]).toEqual(before[key]);
    expect(data().researches['research-b']).toEqual(before.researches['research-b']);
    expect(data().boardChanges).toEqual(before.boardChanges);
  });

  it('越研究、越类型、无效方向或丢失的拖放目标拒绝写入，自身排序不写入', () => {
    const before = data();
    for (const target of ['board-b', 'draft-a', 'missing']) expect(() => workspace.moveResearchResource('research-a', 'board', 'board-a', target, 'before')).toThrow('同一研究');
    expect(() => workspace.moveResearchResource('research-a', 'board', 'board-a', 'board-a2', 'bad' as 'before')).toThrow();
    workspace.moveResearchResource('research-a', 'board', 'board-a', 'board-a', 'after');
    expect(data()).toBe(before);
  });

  it('顺序与折叠状态通过保存重载和 ZIP 往返，目录归档保留当前研究顺序', async () => {
    workspace.moveResearchResource('research-a', 'board', 'board-a2', 'board-a', 'before');
    workspace.moveResearchResource('research-a', 'draft', 'extra', 'draft-a', 'before');
    workspace.moveResearchResource('research-a', 'card', 'card-c', 'card-a', 'before');
    workspace.updateData(next => { next.sessions['research-a'].collapsedNav = ['drafts']; });
    await workspace.flushSave();
    vi.mocked(loadWorkspace).mockResolvedValue(vi.mocked(saveWorkspace).mock.calls.at(-1)![0]); await workspace.load();
    const restored = (await readWorkspaceBackup(await createWorkspaceBackup(data(), assets))).data;
    expect(restored.researches['research-a']).toEqual(data().researches['research-a']);
    expect(restored.sessions['research-a'].collapsedNav).toEqual(['drafts']);
    expect(restored.sessions['research-b'].collapsedNav).toBeUndefined();
    const exported = researchFileData(restored, 'research-a');
    expect(exported.research.boardOrder).toEqual(['board-a2', 'board-a']);
    expect(exported.research.draftOrder).toEqual(['extra', 'draft-a']);
    expect(exported.research.cardIds[0]).toBe('card-c');
    expect(exported.boards['board-b']).toBeUndefined();
  });

  it('导入拒绝重复、越研究和格式错误的顺序及无效折叠状态', () => {
    for (const order of [['board-a', 'board-a'], ['board-b'], [2], 'board-a']) {
      const malformed = structuredClone(data());
      malformed.researches['research-a'].boardOrder = order as string[];
      expect(() => migrateWorkspace(malformed)).toThrow('顺序损坏');
    }
    for (const collapsed of [['cards'], ['boards', 'boards'], 'boards']) {
      const malformed = structuredClone(data());
      malformed.sessions['research-a'].collapsedNav = collapsed as ['boards'];
      expect(() => migrateWorkspace(malformed)).toThrow('折叠状态');
    }
  });
});
