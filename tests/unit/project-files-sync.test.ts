import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import type { WorkspaceData } from '../../src/domain/types';

const storage = vi.hoisted(() => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn() }));
vi.mock('../../src/data/storage', () => ({ ...storage, contentHash: async (bytes: ArrayBuffer) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex') }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

let workspace: typeof import('../../src/services/workspace').workspace;
let files: typeof import('../../src/services/project-files');
let releases: Array<(response: Response) => void>;
const pdf = new Blob(['%PDF-1.4\nsync regression fixture\n%%EOF'], { type: 'application/pdf' });
const saved = (updatedAt: string) => Response.json({ updatedAt, files: 20 });
const body = (init?: RequestInit) => JSON.parse(String(init?.body)) as { workspaceId: string; researchId: string; bindingId: string; files: Array<{ path: string; reuse?: boolean }> };
function gate() {
  let started!: () => void, release!: (response: Response) => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const response = new Promise<Response>(resolve => { release = resolve; });
  releases.push(release);
  return { entered, release, fetch: () => { started(); return response; } };
}
async function seed(workspaceId: string, bindingId = 'binding-a', path = '/fixture/a') {
  const value = createSeed();
  value.agentWorkspaceId = workspaceId;
  value.researches['research-a'].directory = { id: bindingId, projectId: 'project-a', path };
  const hash = createHash('sha256').update(new Uint8Array(await pdf.arrayBuffer())).digest('hex');
  Object.values(value.documents).forEach(document => { if (document.assetId) document.hash = hash; });
  return value;
}
async function load(value: WorkspaceData) {
  storage.loadWorkspace.mockResolvedValue(value);
  await workspace.load();
  expect(workspace.getState().loadError).toBeUndefined();
}

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); releases = [];
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  Object.values(storage).forEach(mock => mock.mockReset());
  storage.saveWorkspace.mockResolvedValue(undefined); storage.saveMigrationBackup.mockResolvedValue(undefined); storage.getAsset.mockResolvedValue(pdf);
  workspace = (await import('../../src/services/workspace')).workspace;
  files = await import('../../src/services/project-files');
  files.installProjectFileSync();
});
afterEach(async () => {
  releases.forEach(release => release(saved('cleanup')));
  await files.flushProjectFiles().catch(() => {});
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('研究文件同步在工作区恢复后的隔离', () => {
  it('旧工作区保存冲突不会阻止恢复后同ID研究与绑定的退出保存', async () => {
    const requests: ReturnType<typeof body>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const request = body(init); requests.push(request);
      return request.workspaceId === 'workspace-a'
        ? Response.json({ code: 'project_files_conflict', error: '目录文件已在外部编辑' }, { status: 409 })
        : saved('workspace-b-saved');
    }));
    await load(await seed('workspace-a'));
    await expect(files.syncResearchFiles('research-a')).rejects.toThrow('外部编辑');
    expect(files.useProjectFiles('research-a').status).toBe('error');

    await load(await seed('workspace-b'));
    expect(files.useProjectFiles('research-a')).toEqual({ status: 'waiting' });
    await expect(files.flushProjectFiles()).resolves.toBeUndefined();
    expect(requests.map(request => request.workspaceId)).toEqual(['workspace-a', 'workspace-b']);
    expect(requests.map(request => request.bindingId)).toEqual(['binding-a', 'binding-a']);
    expect(files.useProjectFiles('research-a')).toMatchObject({ status: 'saved', updatedAt: 'workspace-b-saved' });
  });

  it.each([
    ['不同目录绑定', 'binding-b', '/fixture/b'],
    ['同ID研究与绑定目录碰撞', 'binding-a', '/fixture/a'],
  ])('旧工作区迟到的reuse_unavailable不会重试或污染新工作区：%s', async (_label, bindingId, path) => {
    const old = gate(), next = gate(), requests: ReturnType<typeof body>[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      const request = body(init); requests.push(request);
      if (requests.length === 1) return Promise.resolve(saved('initial-a'));
      if (requests.length === 2) return old.fetch();
      return next.fetch();
    }));
    await load(await seed('workspace-a'));
    await files.syncResearchFiles('research-a');
    workspace.updateData(data => { data.researches['research-a'].question = '旧工作区的新问题'; });
    const oldResult = files.syncResearchFiles('research-a').catch(error => error);
    await old.entered;
    expect(requests[1].files.some(file => file.reuse)).toBe(true);

    await load(await seed('workspace-b', bindingId, path));
    const flush = files.flushProjectFiles();
    old.release(Response.json({ code: 'project_files_reuse_unavailable', error: '旧复用文件不可用' }, { status: 409 }));
    await next.entered;
    expect(requests.map(request => request.workspaceId)).toEqual(['workspace-a', 'workspace-a', 'workspace-b']);
    expect(files.useProjectFiles('research-a')).toEqual({ status: 'saving' });
    expect(requests[2].files.every(file => !file.reuse)).toBe(true);
    next.release(saved('final-b'));
    await flush;
    expect(await oldResult).toBeInstanceOf(Error);
    expect(files.useProjectFiles('research-a')).toMatchObject({ status: 'saved', updatedAt: 'final-b' });
    expect(requests).toHaveLength(3);
  });

  it('相同workspace与binding的loadGeneration改变也会丢弃旧成功响应和复用缓存', async () => {
    const old = gate(), next = gate(), requests: ReturnType<typeof body>[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      requests.push(body(init));
      if (requests.length === 1) return Promise.resolve(saved('initial'));
      if (requests.length === 2) return old.fetch();
      return next.fetch();
    }));
    await load(await seed('workspace-a'));
    await files.syncResearchFiles('research-a');
    workspace.updateData(data => { data.researches['research-a'].question = '恢复相同身份的研究'; });
    const oldResult = files.syncResearchFiles('research-a').catch(error => error);
    await old.entered;
    const generation = workspace.getGeneration();
    await load(structuredClone(workspace.getState().data));
    expect(workspace.getGeneration()).toBe(generation + 1);
    const flush = files.flushProjectFiles();
    old.release(saved('stale-success'));
    await next.entered;
    expect(requests.map(request => request.workspaceId)).toEqual(['workspace-a', 'workspace-a', 'workspace-a']);
    expect(requests[2].files.every(file => !file.reuse)).toBe(true);
    expect(files.useProjectFiles('research-a')).toEqual({ status: 'saving' });
    next.release(saved('restored-success'));
    await flush;
    expect(await oldResult).toBeInstanceOf(Error);
    expect(files.useProjectFiles('research-a')).toMatchObject({ status: 'saved', updatedAt: 'restored-success' });
    expect(requests).toHaveLength(3);
  });
});
