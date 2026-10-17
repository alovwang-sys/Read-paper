import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { workspace } from '../../src/services/workspace';
import { createDirectoryDraft, createResearchWithDirectory, directoryPath, directoryRequest, pendingResearch, resumePendingResearch } from '../../src/services/research-directory';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn() }));
let memory: Map<string, string>;
beforeEach(async () => {
  memory = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(createSeed());
  await workspace.load(); await workspace.flushSave();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const input = { title: '可靠检索', question: '什么条件下有效？', path: '/fixture/可靠检索', mode: 'new' as const };
const pendingKey = 'papertrail-pending-research-create-v1';
const binding = { id: 'binding-a', projectId: 'project-a', path: input.path, name: input.title };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
async function loadScope(id?: string) {
  memory.delete('papertrail-recovery-v3');
  vi.mocked(loadWorkspace).mockResolvedValue({ ...createSeed(), agentWorkspaceId: id });
  await workspace.load(); await workspace.flushSave();
}
describe('创建研究与目录的单一提交', () => {
  it('打开草稿不提交研究；目录确认成功后一次提交稳定身份和绑定', async () => {
    const initial = Object.keys(workspace.getState().data.researches);
    const draft = createDirectoryDraft();
    expect(Object.keys(workspace.getState().data.researches)).toEqual(initial);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url.split('/').at(-1)!);
      expect(workspace.getState().data.researches[draft.researchId]).toBeUndefined();
      return Response.json(url.endsWith('preview') ? { path: input.path, name: input.title } : { id: 'binding-a', projectId: 'project-a', path: input.path, name: input.title });
    }));
    expect(await createResearchWithDirectory(draft, input)).toBe(draft.researchId);
    expect(calls).toEqual(['preview', 'bind']);
    expect(workspace.getState().data.researches[draft.researchId]).toMatchObject({ question: input.question, directory: { id: 'binding-a', path: input.path } });
    expect(pendingResearch()).toBeUndefined();
  });
  it('预览拒绝不残留研究或待完成记录，修改后可再次提交', async () => {
    const draft = createDirectoryDraft();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'directory_exists', error: '已存在' }, { status: 409 })));
    await expect(createResearchWithDirectory(draft, input)).rejects.toThrow('已存在');
    expect(pendingResearch()).toBeUndefined();
    expect(workspace.getState().data.researches[draft.researchId]).toBeUndefined();
  });
  it('结果未知时保留稳定待办，恢复只重试绑定，不制造第二个研究', async () => {
    const draft = createDirectoryDraft();
    let binds = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('preview')) return Response.json({ path: input.path, name: input.title });
      if (++binds === 1) throw new Error('connection lost');
      return Response.json({ id: 'binding-a', projectId: 'project-a', path: input.path, name: input.title });
    }));
    await expect(createResearchWithDirectory(draft, input)).rejects.toThrow();
    expect(pendingResearch()?.draft.operationId).toBe(draft.operationId);
    expect(workspace.getState().data.researches[draft.researchId]).toBeUndefined();
    expect(await resumePendingResearch()).toBe(draft.researchId);
    expect(binds).toBe(2);
    expect(Object.keys(workspace.getState().data.researches)).toHaveLength(3);
  });
  it('可靠保存待办失败时不开始文件系统操作', async () => {
    const draft = createDirectoryDraft(), calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return Response.json({ path: input.path, name: input.title }); }));
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota'); } });
    await expect(createResearchWithDirectory(draft, input)).rejects.toThrow('quota');
    expect(calls).toHaveLength(1); expect(calls[0]).toContain('preview');
    expect(workspace.getState().data.researches[draft.researchId]).toBeUndefined();
  });
  it('双击共用同一次提交；Windows和POSIX目录分别使用对应分隔符', async () => {
    expect(directoryPath('/tmp/parent/', '研究')).toBe('/tmp/parent/研究');
    expect(directoryPath('C:\\Research\\', '研究')).toBe('C:\\Research\\研究');
    const draft = createDirectoryDraft(); let binds = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (url.endsWith('bind')) binds++; return Response.json(url.endsWith('preview') ? { path: input.path, name: input.title } : { id: 'binding-a', projectId: 'project-a', path: input.path, name: input.title }); }));
    await Promise.all([createResearchWithDirectory(draft, input), createResearchWithDirectory(draft, input)]);
    expect(binds).toBe(1);
  });
  it('仅合并完全相同的创建，其他草稿或内容并发明确拒绝', async () => {
    const draft = createDirectoryDraft(), preview = deferred<Response>(); let binds = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (url.endsWith('preview')) return preview.promise; binds++; return Response.json(binding); }));
    const first = createResearchWithDirectory(draft, input);
    const repeated = createResearchWithDirectory({ ...draft }, { ...input });
    await expect(createResearchWithDirectory(createDirectoryDraft(), input)).rejects.toThrow('另一次研究创建');
    await expect(createResearchWithDirectory(draft, { ...input, question: '不同的问题' })).rejects.toThrow('另一次研究创建');
    preview.resolve(Response.json({ path: input.path, name: input.title }));
    expect(await first).toBe(draft.researchId); expect(await repeated).toBe(draft.researchId); expect(binds).toBe(1);
  });
  it('恢复其他工作区后不使用迟到的预览结果，不写待办或提交绑定', async () => {
    await loadScope('workspace-a'); const draft = createDirectoryDraft(), preview = deferred<Response>();
    const fetch = vi.fn(() => preview.promise); vi.stubGlobal('fetch', fetch);
    const creating = createResearchWithDirectory(draft, input); const rejected = expect(creating).rejects.toThrow('工作区已恢复或切换');
    await loadScope('workspace-b'); preview.resolve(Response.json({ path: input.path, name: input.title })); await rejected;
    expect(fetch).toHaveBeenCalledTimes(1); expect(pendingResearch()).toBeUndefined();
    expect(workspace.getState().data.agentWorkspaceId).toBe('workspace-b'); expect(workspace.getState().data.researches[draft.researchId]).toBeUndefined();
  });
  it.each([['有身份备份', 'workspace-b'], ['无身份旧备份', undefined]])('绑定响应迟到时保留原工作区待办，%s仍能创建，返回后可恢复原操作', async (_label, nextWorkspaceId) => {
    await loadScope('workspace-a'); const draftA = createDirectoryDraft(), bound = deferred<Response>(), started = deferred<void>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('preview')) return Response.json({ path: input.path, name: input.title });
      started.resolve(); return bound.promise;
    }));
    const creating = createResearchWithDirectory(draftA, input); const rejected = expect(creating).rejects.toThrow('工作区已恢复或切换'); await started.promise;
    await loadScope(nextWorkspaceId); bound.resolve(Response.json(binding)); await rejected;
    expect(workspace.getState().data.researches[draftA.researchId]).toBeUndefined(); expect(pendingResearch()).toBeUndefined();
    expect(JSON.parse(memory.get(`${pendingKey}:workspace-a`)!)).toMatchObject({ draft: draftA, input });
    const draftB = createDirectoryDraft();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('preview') ? { path: input.path, name: input.title } : binding)));
    await expect(createResearchWithDirectory(draftB, input)).resolves.toBe(draftB.researchId);
    expect(memory.has(`${pendingKey}:workspace-a`)).toBe(true); expect(pendingResearch()).toBeUndefined();
    await loadScope('workspace-a'); expect(pendingResearch()?.draft).toEqual(draftA);
    const resumed: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => { resumed.push(JSON.parse(String(options.body))); return Response.json(binding); }));
    await expect(resumePendingResearch()).resolves.toBe(draftA.researchId);
    expect(resumed).toEqual([{ ...draftA, path: input.path, mode: input.mode }]); expect(pendingResearch()).toBeUndefined();
    expect(memory.has(`${pendingKey}:workspace-a`)).toBe(false);
  });
  it('同身份工作区重载也拒绝旧绑定结果，待办仍可恢复', async () => {
    await loadScope('workspace-a'); const draft = createDirectoryDraft(), bound = deferred<Response>(), started = deferred<void>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (url.endsWith('preview')) return Response.json({ path: input.path, name: input.title }); started.resolve(); return bound.promise; }));
    const creating = createResearchWithDirectory(draft, input), rejected = expect(creating).rejects.toThrow('工作区已恢复或切换'); await started.promise;
    await loadScope('workspace-a'); bound.resolve(Response.json(binding)); await rejected;
    expect(workspace.getState().data.researches[draft.researchId]).toBeUndefined(); expect(pendingResearch()?.draft).toEqual(draft);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(binding)));
    await expect(resumePendingResearch()).resolves.toBe(draft.researchId);
  });
  it('最终业务保存期间切换工作区，不清理待办或切换新工作区的研究', async () => {
    await loadScope('workspace-a'); const draft = createDirectoryDraft(), gate = deferred<void>(), started = deferred<void>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('preview') ? { path: input.path, name: input.title } : binding)));
    vi.spyOn(workspace, 'flushSave').mockImplementationOnce(async () => { started.resolve(); await gate.promise; });
    const creating = createResearchWithDirectory(draft, input), rejected = expect(creating).rejects.toThrow('工作区已恢复或切换'); await started.promise;
    await loadScope('workspace-b'); const originalScope = workspace.getState().data.scope; gate.resolve(); await rejected;
    expect(workspace.getState().data.scope).toEqual(originalScope); expect(pendingResearch()).toBeUndefined();
    expect(JSON.parse(memory.get(`${pendingKey}:workspace-a`)!)).toMatchObject({ draft });
  });
  it('首次工作区身份保存期间恢复其他工作区，不开始绑定并保留待办', async () => {
    const draft = createDirectoryDraft(), gate = deferred<void>(), started = deferred<void>();
    const fetch = vi.fn(async () => Response.json({ path: input.path, name: input.title })); vi.stubGlobal('fetch', fetch);
    vi.spyOn(workspace, 'flushSave').mockImplementationOnce(async () => { started.resolve(); await gate.promise; });
    const creating = createResearchWithDirectory(draft, input), rejected = expect(creating).rejects.toThrow('工作区已恢复或切换'); await started.promise;
    await loadScope('workspace-b'); gate.resolve(); await rejected;
    expect(fetch).toHaveBeenCalledTimes(1); expect(pendingResearch()).toBeUndefined();
    expect(JSON.parse(memory.get(`${pendingKey}:${draft.workspaceId}`)!)).toMatchObject({ draft });
  });
  it('兼容旧单记录，归档失败时不删除另一工作区的恢复记录', async () => {
    const legacy = { draft: { workspaceId: 'workspace-a', researchId: 'research-pending', operationId: 'operation-pending' }, input };
    memory.set(pendingKey, JSON.stringify(legacy)); await loadScope('workspace-b');
    vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { if (key === `${pendingKey}:workspace-a`) throw new Error('archive quota'); memory.set(key, value); }, removeItem: (key: string) => memory.delete(key) });
    expect(() => pendingResearch()).toThrow('archive quota'); expect(JSON.parse(memory.get(pendingKey)!)).toEqual(legacy);
  });
  it('已有不同恢复记录时不覆盖归档，也不删除旧单记录', async () => {
    const legacy = { draft: { workspaceId: 'workspace-a', researchId: 'research-pending', operationId: 'operation-pending' }, input };
    const archived = { ...legacy, draft: { ...legacy.draft, operationId: 'different-operation' } };
    memory.set(pendingKey, JSON.stringify(legacy)); memory.set(`${pendingKey}:workspace-a`, JSON.stringify(archived));
    await loadScope('workspace-b'); expect(() => pendingResearch()).toThrow('不同的待确认创建');
    expect(JSON.parse(memory.get(pendingKey)!)).toEqual(legacy); expect(JSON.parse(memory.get(`${pendingKey}:workspace-a`)!)).toEqual(archived);
  });
});

describe('目录请求的有界连接与响应读取', () => {
  it.each(['fetch', 'body'])('默认15秒限制覆盖%s，并取消底层请求', async stage => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => { signal = options.signal as AbortSignal; return stage === 'fetch' ? new Promise(() => {}) : Promise.resolve({ ok: true, json: () => new Promise(() => {}) }); }));
    const request = directoryRequest(createDirectoryDraft(), 'preview'); const rejected = expect(request).rejects.toMatchObject({ code: 'directory_timeout' });
    await vi.advanceTimersByTimeAsync(14_999); expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected; expect(signal!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('sync使用60秒上限，并可由外部signal立即取消和解绑', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => { signal = options.signal as AbortSignal; return new Promise(() => {}); }));
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    const request = directoryRequest(createDirectoryDraft(), 'sync', {}, controller.signal), rejected = expect(request).rejects.toMatchObject({ code: 'aborted' });
    await vi.advanceTimersByTimeAsync(15_000); expect(signal!.aborted).toBe(false); controller.abort(); await rejected;
    expect(signal!.aborted).toBe(true); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)); expect(vi.getTimerCount()).toBe(0);
    const timeout = directoryRequest(createDirectoryDraft(), 'sync'), timedOut = expect(timeout).rejects.toMatchObject({ code: 'directory_timeout' });
    await vi.advanceTimersByTimeAsync(59_999); expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await timedOut; expect(signal!.aborted).toBe(true);
  });
  it('已经取消的请求不启动fetch，成功请求移除超时和外部监听', async () => {
    vi.useFakeTimers(); const fetch = vi.fn(async () => Response.json({ path: input.path })); vi.stubGlobal('fetch', fetch);
    const canceled = new AbortController(); canceled.abort(); await expect(directoryRequest(createDirectoryDraft(), 'preview', {}, canceled.signal)).rejects.toMatchObject({ code: 'aborted' }); expect(fetch).not.toHaveBeenCalled();
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(directoryRequest(createDirectoryDraft(), 'preview', {}, controller.signal)).resolves.toEqual({ path: input.path });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)); expect(vi.getTimerCount()).toBe(0);
  });
  it('绑定超时仍保留恢复记录，后续恢复复用原操作身份', async () => {
    await loadScope('workspace-a'); vi.useFakeTimers(); const draft = createDirectoryDraft(); let bindBody: unknown;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => { if (url.endsWith('preview')) return Response.json({ path: input.path, name: input.title }); bindBody = JSON.parse(String(options.body)); return new Promise(() => {}); }));
    const request = createResearchWithDirectory(draft, input), rejected = expect(request).rejects.toMatchObject({ code: 'directory_timeout' });
    await vi.advanceTimersByTimeAsync(15_000); await rejected; expect(pendingResearch()?.draft).toEqual(draft);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => { expect(JSON.parse(String(options.body))).toEqual(bindBody); return Response.json(binding); }));
    await expect(resumePendingResearch()).resolves.toBe(draft.researchId); expect(pendingResearch()).toBeUndefined();
  });
});
