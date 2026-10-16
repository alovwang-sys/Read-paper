import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { contentHash, loadWorkspace, restoreWorkspaceBackup, saveWorkspace } from '../../src/data/storage';
import { createWorkspaceBackup, readWorkspaceBackup, type BackupAsset } from '../../src/services/backup';
import { getResearchDirectory, refreshProjectConversation } from '../../src/services/agents';
import { workspace } from '../../src/services/workspace';
import type { NativeSessionSnapshot, WorkspaceData } from '../../src/domain/types';

vi.mock('../../src/data/storage', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/data/storage')>(),
  loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), restoreWorkspaceBackup: vi.fn(),
}));
const directory = { id: 'binding-original', projectId: 'project-original', path: '/fixture/project-original' };
const conversationId = 'conversation-research-a';
let initial: WorkspaceData;
let assets: BackupAsset[];
const data = () => workspace.getState().data;

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  initial = createSeed(); initial.agentWorkspaceId = 'workspace-original'; initial.researches['research-a'].directory = directory;
  initial.conversations[conversationId] = { ...initial.conversations[conversationId], connectionId: 'codex', nativeSessionId: 'native-original', nativeSessionRef: 'ref-original', nativeState: 'busy', nativeCanResume: true, input: 'Unsent research question', requestIds: ['own', 'imported'] };
  initial.requests.own = { id: 'own', researchId: 'research-a', conversationId, connectionId: 'codex', nativeSessionId: 'native-original', purpose: 'chat', prompt: 'Original question', body: 'Original app answer', context: [], evidenceIds: [], history: [], status: 'done', createdAt: '2026-10-17T00:00:00Z' };
  initial.requests.imported = { id: 'imported', researchId: 'research-a', conversationId, connectionId: 'codex', nativeSessionId: 'native-original', nativeImported: true, nativeMessageId: 'native-user', purpose: 'chat', prompt: 'Imported question', body: 'Cached native answer', context: [], evidenceIds: [], history: [], status: 'done', createdAt: '2026-10-17T00:00:00Z' };
  assets = [];
  for (const document of Object.values(initial.documents)) {
    const blob = new Blob([`%PDF-1.7\n${document.id}`], { type: 'application/pdf' });
    document.hash = await contentHash(await blob.arrayBuffer()); assets.push({ id: document.assetId, blob });
  }
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(structuredClone(initial));
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  vi.mocked(restoreWorkspaceBackup).mockReset().mockImplementation(async value => { vi.mocked(loadWorkspace).mockResolvedValue(structuredClone(value)); });
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('工作区备份与项目原生会话的兼容', () => {
  it('备份往返保留目录、workspace和原生引用，忙碌缓存降为未知且不冒充原生恢复', async () => {
    const original = structuredClone(initial);
    const backup = await readWorkspaceBackup(await createWorkspaceBackup(initial, assets));
    expect(initial).toEqual(original);
    expect(backup.data.agentWorkspaceId).toBe('workspace-original');
    expect(backup.data.researches['research-a'].directory).toEqual(directory);
    expect(backup.data.conversations[conversationId]).toMatchObject({ nativeSessionId: 'native-original', nativeSessionRef: 'ref-original', nativeState: 'unknown', nativeCanResume: false, input: 'Unsent research question' });
    expect(backup.data.requests.own).toEqual(original.requests.own);
    expect(backup.data.requests.imported).toEqual(original.requests.imported);
    expect(backup.assets).toHaveLength(3);
  });

  it('恢复先保存当前修改，恢复后的原始回答仍受保护，只有匹配的原生显示缓存可刷新', async () => {
    const backup = await readWorkspaceBackup(await createWorkspaceBackup(initial, assets));
    workspace.updateData(value => { value.cards['card-a'].body = 'Latest edit before restore'; });
    await workspace.restoreBackup(backup.data, backup.assets);
    expect(vi.mocked(saveWorkspace).mock.calls[0][0].cards['card-a'].body).toBe('Latest edit before restore');
    expect(vi.mocked(restoreWorkspaceBackup).mock.calls[0][0].agentWorkspaceId).toBe('workspace-original');
    expect(data().researches['research-a'].directory).toEqual(directory);
    expect(() => workspace.updateData(value => { value.requests.own.body = 'Changed original answer'; }, { nativeHistoryRef: 'ref-original' })).toThrow(/原始问答/);
    expect(() => workspace.updateData(value => { value.requests.imported.body = 'Wrong session refresh'; }, { nativeHistoryRef: 'ref-other' })).toThrow(/原始问答/);
    workspace.updateData(value => { value.requests.imported.body = 'Native answer completed'; }, { nativeHistoryRef: 'ref-original' });
    expect(data().requests.imported.body).toBe('Native answer completed');
    expect(data().requests.own.body).toBe('Original app answer');
    await workspace.flushSave(); expect(workspace.getState().saveStatus).toBe('saved');
  });

  it('恢复正在替换数据库时同时拒绝常规编辑和原生缓存刷新', async () => {
    let release!: () => void;
    vi.mocked(restoreWorkspaceBackup).mockImplementationOnce(async value => { await new Promise<void>(resolve => { release = resolve; }); vi.mocked(loadWorkspace).mockResolvedValue(structuredClone(value)); });
    const restoring = workspace.restoreBackup(initial, assets);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    try {
      expect(() => workspace.updateData(value => { value.cards['card-a'].body = 'Overlapping edit'; })).toThrow(/正在恢复/);
      expect(() => workspace.updateData(value => { value.requests.imported.body = 'Overlapping native refresh'; }, { nativeHistoryRef: 'ref-original' })).toThrow(/正在恢复/);
    } finally { release(); await restoring; }
    expect(data().requests.imported.body).toBe('Cached native answer');
  });

  it('其他机器没有对应本机绑定时保留备份记录和输入，使用原workspace身份核验而不偷偷重绑', async () => {
    const backup = await readWorkspaceBackup(await createWorkspaceBackup(initial, assets));
    await workspace.restoreBackup(backup.data, backup.assets);
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ error: '本机没有此目录关联，请重新连接。' }, { status: 409 })); vi.stubGlobal('fetch', fetch);
    await expect(getResearchDirectory('research-a')).rejects.toThrow(/重新连接/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ workspaceId: 'workspace-original', researchId: 'research-a' });
    expect(data().researches['research-a'].directory).toEqual(directory);
    expect(data().conversations[conversationId]).toMatchObject({ nativeSessionRef: 'ref-original', input: 'Unsent research question', nativeCanResume: false });
  });

  it('恢复另一工作区后忽略恢复前迟到的原生历史，不能把旧项目消息导入同名研究', async () => {
    let respond!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })));
    const oldRead = refreshProjectConversation('research-a', conversationId);
    const replacement = structuredClone(initial); replacement.agentWorkspaceId = 'workspace-restored-other';
    replacement.researches['research-a'].directory = { id: 'binding-other', projectId: 'project-other', path: '/fixture/project-other' };
    replacement.conversations[conversationId].nativeSessionId = 'native-other'; replacement.conversations[conversationId].nativeSessionRef = 'ref-other';
    replacement.conversations[conversationId].requestIds = []; replacement.requests = {};
    await workspace.restoreBackup(replacement, assets);
    const count = Object.keys(data().conversations).length;
    const snapshot: NativeSessionSnapshot = { id: 'ref-original', agentId: 'codex', nativeSessionId: 'native-original', title: 'Old project', updatedAt: '2026-10-17T01:00:00Z', state: 'unknown', canResume: true, origin: 'native', messages: [{ id: 'old-user', role: 'user', text: 'Must not import into the restored workspace' }, { id: 'old-answer', role: 'assistant', text: 'Old project answer' }] };
    respond(Response.json(snapshot)); await expect(oldRead).rejects.toThrow(/工作区|研究目录|关联|变化|改变/);
    expect(data().agentWorkspaceId).toBe('workspace-restored-other');
    expect(Object.keys(data().conversations)).toHaveLength(count);
    expect(Object.values(data().conversations).some(conversation => conversation.nativeSessionId === 'native-original')).toBe(false);
    expect(data().requests).toEqual({});
  });
});
