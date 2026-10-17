import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { loadWorkspace, saveWorkspace } from '../../src/data/storage';
import type { AIRequest, NativeAgentId } from '../../src/domain/types';
import { regenerateAI, retryAI, stopAllAI, submitAI } from '../../src/services/ai';
import { syncResearchFiles } from '../../src/services/project-files';
import { workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn(), contentHash: vi.fn() }));
vi.mock('../../src/services/project-files', () => ({ syncResearchFiles: vi.fn() }));
const conversationId = 'conversation-research-a';
const prompt = '读取目录中的最新卡片';
const data = () => workspace.getState().data;
const done = () => new Response([{ type: 'delta', text: '已读取最新目录。' }, { type: 'done', model: 'mock-native' }].map(value => JSON.stringify(value)).join('\n') + '\n');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(finish => { resolve = finish; }); return { promise, resolve }; }
function prior(status: AIRequest['status']): AIRequest {
  return { id: 'previous-native-request', researchId: 'research-a', conversationId, prompt, body: status === 'done' ? '已有回答' : '', context: [], evidenceIds: [], history: [], status, purpose: 'chat', connectionId: 'codex', mode: 'live', createdAt: '2026-10-17T00:00:00Z' };
}

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(syncResearchFiles).mockReset().mockResolvedValue(undefined);
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  const seed = createSeed(); seed.agentWorkspaceId = 'workspace-native-preflight';
  seed.researches['research-a'].directory = { id: 'binding-a', projectId: 'project-a', path: '/fixture/research-a' };
  Object.assign(seed.conversations[conversationId], { connectionId: 'codex', contextIds: [], requestIds: [], input: prompt });
  seed.requests = {};
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(seed);
  await workspace.load();
  vi.stubGlobal('fetch', vi.fn(async () => done()));
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('本机聊天发送前的目录保存', () => {
  it.each<NativeAgentId>(['codex', 'claude', 'opencode'])('%s 等待目录保存完成，期间不生成请求或清空输入', async connectionId => {
    workspace.updateData(next => { next.conversations[conversationId].connectionId = connectionId; });
    const saving = deferred();
    vi.mocked(syncResearchFiles).mockReturnValue(saving.promise);
    const sending = submitAI('research-a', conversationId, prompt);
    await vi.waitFor(() => expect(syncResearchFiles).toHaveBeenCalledWith('research-a'));
    expect(fetch).not.toHaveBeenCalled();
    expect(data().conversations[conversationId].requestIds).toEqual([]);
    expect(data().conversations[conversationId].input).toBe(prompt);
    saving.resolve();
    const id = await sending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/ai/agents/run');
    expect(data().requests[id]).toMatchObject({ researchId: 'research-a', connectionId, status: 'done' });
    expect(data().conversations[conversationId].input).toBe('');
  });

  it('目录失败向调用者报错，保留输入，不发模型；明确再次提交可恢复', async () => {
    vi.mocked(syncResearchFiles).mockRejectedValueOnce(new Error('目录文件已在外部修改，未覆盖。'));
    await expect(submitAI('research-a', conversationId, prompt)).rejects.toThrow('外部修改');
    expect(fetch).not.toHaveBeenCalled();
    expect(data().conversations[conversationId].requestIds).toEqual([]);
    expect(data().conversations[conversationId].input).toBe(prompt);
    const id = await submitAI('research-a', conversationId, prompt);
    expect(data().requests[id].status).toBe('done');
    expect(syncResearchFiles).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('目录保存期间的重复点击不会创建第二次同步或模型请求', async () => {
    const saving = deferred(); vi.mocked(syncResearchFiles).mockReturnValue(saving.promise);
    const sending = submitAI('research-a', conversationId, prompt);
    await vi.waitFor(() => expect(syncResearchFiles).toHaveBeenCalledOnce());
    await expect(submitAI('research-a', conversationId, prompt)).rejects.toThrow('当前会话正在回答');
    expect(syncResearchFiles).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
    saving.resolve(); await sending;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['retry', 'regenerate'] as const)('%s 使用同一前置保存，未完成前保留原请求', async action => {
    const original = prior(action === 'retry' ? 'error' : 'done');
    workspace.updateData(next => { next.requests[original.id] = original; next.conversations[conversationId].requestIds = [original.id]; });
    const saving = deferred(); vi.mocked(syncResearchFiles).mockReturnValue(saving.promise);
    const sending = action === 'retry' ? retryAI(original.id) : regenerateAI(original.id);
    await vi.waitFor(() => expect(syncResearchFiles).toHaveBeenCalledOnce());
    expect(fetch).not.toHaveBeenCalled();
    expect(data().conversations[conversationId].requestIds).toEqual([original.id]);
    expect(data().requests[original.id].body).toBe(original.body);
    saving.resolve(); const id = await sending;
    expect(data().requests[id]).toMatchObject({ status: 'done', [action === 'retry' ? 'retryOf' : 'regeneratedFrom']: original.id });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('前置等待期间切换研究后仍只向原研究发送', async () => {
    const saving = deferred(); vi.mocked(syncResearchFiles).mockReturnValue(saving.promise);
    const sending = submitAI('research-a', conversationId, prompt);
    await vi.waitFor(() => expect(syncResearchFiles).toHaveBeenCalledOnce());
    workspace.switchResearch('research-b');
    saving.resolve(); const id = await sending;
    expect(data().scope).toEqual({ kind: 'research', researchId: 'research-b' });
    expect(data().requests[id].researchId).toBe('research-a');
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).researchId).toBe('research-a');
  });

  it('恢复到相同工作区和会话ID后，旧前置结果也不能发送', async () => {
    const saving = deferred(); vi.mocked(syncResearchFiles).mockReturnValue(saving.promise);
    const sending = submitAI('research-a', conversationId, prompt).catch(error => error);
    await vi.waitFor(() => expect(syncResearchFiles).toHaveBeenCalledOnce());
    vi.mocked(loadWorkspace).mockResolvedValue(structuredClone(data()));
    await workspace.load();
    saving.resolve();
    expect(await sending).toMatchObject({ message: expect.stringContaining('工作区已改变') });
    expect(fetch).not.toHaveBeenCalled();
    expect(data().conversations[conversationId].requestIds).toEqual([]);
    expect(data().conversations[conversationId].input).toBe(prompt);
  });

  it('目录绑定在等待期间改变时不发送旧请求', async () => {
    const saving = deferred(); vi.mocked(syncResearchFiles).mockReturnValue(saving.promise);
    const sending = submitAI('research-a', conversationId, prompt).catch(error => error);
    await vi.waitFor(() => expect(syncResearchFiles).toHaveBeenCalledOnce());
    workspace.updateData(next => { next.researches['research-a'].directory!.id = 'other-binding'; });
    saving.resolve();
    expect(await sending).toMatchObject({ message: expect.stringContaining('研究目录') });
    expect(fetch).not.toHaveBeenCalled();
    expect(data().conversations[conversationId].input).toBe(prompt);
  });

  it('关闭期间等待目录保存结束后取消发送，关闭可继续且输入保留', async () => {
    const saving = deferred(); vi.mocked(syncResearchFiles).mockReturnValue(saving.promise);
    const sending = submitAI('research-a', conversationId, prompt).catch(error => error);
    await vi.waitFor(() => expect(syncResearchFiles).toHaveBeenCalledOnce());
    const closing = stopAllAI();
    saving.resolve();
    expect(await sending).toMatchObject({ message: expect.stringContaining('关闭前取消') });
    await vi.runAllTimersAsync(); await closing;
    expect(fetch).not.toHaveBeenCalled();
    expect(data().conversations[conversationId].input).toBe(prompt);
    expect(data().conversations[conversationId].requestIds).toEqual([]);
  });

  it('模型直连沿用原发送路径，不等待研究目录', async () => {
    workspace.updateData(next => { next.conversations[conversationId].connectionId = 'model'; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/config') ? Response.json({ configured: true, model: 'mock-model', images: false }) : done()));
    const id = await submitAI('research-a', conversationId, prompt);
    expect(syncResearchFiles).not.toHaveBeenCalled();
    expect(data().requests[id]).toMatchObject({ connectionId: 'model', status: 'done' });
  });

  it('演示模式不触发目录保存或真实请求', async () => {
    workspace.updateData(next => { next.conversations[conversationId].connectionId = 'demo'; });
    const sending = submitAI('research-a', conversationId, prompt);
    await vi.runAllTimersAsync(); const id = await sending;
    expect(syncResearchFiles).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(data().requests[id]).toMatchObject({ connectionId: 'demo', status: 'done', mode: 'demo' });
  });

  it('未绑定研究保留原有目录提示和输入，不调用同步', async () => {
    workspace.updateData(next => { delete next.researches['research-a'].directory; });
    const id = await submitAI('research-a', conversationId, prompt);
    expect(syncResearchFiles).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(data().requests[id]).toMatchObject({ status: 'error', error: expect.stringContaining('选择目录') });
    expect(data().conversations[conversationId].input).toBe(prompt);
  });
});
