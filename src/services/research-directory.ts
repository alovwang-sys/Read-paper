import type { ResearchDirectory } from '../domain/types';
import { uid, workspace } from './workspace';

export type DirectoryDraft = { workspaceId: string; researchId: string; operationId: string };
export type DirectoryMode = 'new' | 'existing';
type CreateInput = { title: string; question: string; path: string; mode: DirectoryMode };
type Pending = { draft: DirectoryDraft; input: CreateInput };
const PENDING = 'papertrail-pending-research-create-v1';
const PARENT = 'papertrail-research-parent-v1';
export class DirectoryError extends Error {
  code?: string;
  ownerResearchId?: string;
}

export function directoryPath(parent: string, name: string) {
  return parent.replace(/[\\/]+$/, '') + (parent.includes('\\') ? '\\' : '/') + name.trim();
}

function readPending(key: string): Pending | undefined {
  const raw = localStorage.getItem(key);
  if (!raw) return;
  const value = JSON.parse(raw) as Pending;
  if (!value?.draft || !['workspaceId', 'researchId', 'operationId'].every(key => typeof value.draft[key as keyof DirectoryDraft] === 'string' && value.draft[key as keyof DirectoryDraft]) || !value.input || !['title', 'question', 'path'].every(key => typeof value.input[key as keyof CreateInput] === 'string') || !value.input.path || !['new', 'existing'].includes(value.input.mode))
    throw new Error('待完成研究记录损坏，原目录未更改，请先导出工作区备份。');
  return value;
}
function storePending(key: string, pending: Pending) {
  const serialized = JSON.stringify(pending);
  localStorage.setItem(key, serialized);
  if (localStorage.getItem(key) !== serialized) throw new Error('无法可靠保存创建恢复记录，请保留当前页面并检查本机存储。');
}
const archiveKey = (workspaceId: string) => `${PENDING}:${workspaceId}`;
export function pendingResearch(): Pending | undefined {
  const workspaceId = workspace.getState().data.agentWorkspaceId;
  const current = readPending(PENDING);
  if (current?.draft.workspaceId === workspaceId) return current;
  if (current) {
    const archived = readPending(archiveKey(current.draft.workspaceId));
    if (archived && submissionKey(archived) !== submissionKey(current)) throw new Error('原工作区存在不同的待确认创建，恢复记录均已保留，请先核对。');
    storePending(archiveKey(current.draft.workspaceId), current);
    localStorage.removeItem(PENDING);
  }
  if (!workspaceId) return;
  const archived = readPending(archiveKey(workspaceId));
  if (archived) storePending(PENDING, archived);
  return archived;
}
function clearPending(pending: Pending) {
  for (const key of [archiveKey(pending.draft.workspaceId), PENDING]) {
    const stored = readPending(key);
    if (stored?.draft.workspaceId === pending.draft.workspaceId && stored.draft.operationId === pending.draft.operationId) localStorage.removeItem(key);
  }
}

export function createDirectoryDraft(): DirectoryDraft {
  return { workspaceId: workspace.getState().data.agentWorkspaceId ?? uid('workspace'), researchId: uid('research'), operationId: uid('create') };
}

export async function directoryRequest<T>(draft: Pick<DirectoryDraft, 'workspaceId' | 'researchId'>, action: string, values: object = {}, signal?: AbortSignal): Promise<T> {
  const unavailable = '无法连接研究目录服务，请检查本机服务后重试。';
  const controller = new AbortController();
  let reject!: (error: Error) => void;
  const canceled = new Promise<never>((_resolve, fail) => { reject = fail; });
  const cancel = (code: string, message: string) => { reject(Object.assign(new DirectoryError(message), { code })); controller.abort(); };
  const aborted = () => cancel('aborted', '目录操作已取消；尚未确认的创建结果仍会保留。');
  const timer = setTimeout(() => cancel('directory_timeout', '研究目录服务响应超时，请重试；尚未确认的创建结果仍会保留。'), action === 'sync' ? 60_000 : 15_000);
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    if (signal?.aborted) { aborted(); return await canceled; }
    return await Promise.race([canceled, (async () => {
      const response = await fetch(`/api/ai/agents/projects/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, ...values }), signal: controller.signal }).catch(() => { throw new Error(unavailable); });
      const result = await response.json().catch(() => { throw new Error(unavailable); });
      if (!response.ok) {
        const error = new DirectoryError(result.error || unavailable);
        error.code = result.code;
        if (workspace.getState().data.agentWorkspaceId === draft.workspaceId && typeof result.ownerResearchId === 'string' && workspace.getState().data.researches[result.ownerResearchId]) error.ownerResearchId = result.ownerResearchId;
        throw error;
      }
      return result;
    })()]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
}

export async function getDirectoryDefaults(draft: DirectoryDraft): Promise<{ path: string }> {
  const remembered = localStorage.getItem(PARENT);
  if (remembered) {
    try { return { path: (await browseDirectories(draft, remembered)).path }; } catch { /* A missing previous location is offered again in the picker. */ }
  }
  if (window.papertrailDesktop?.getProjectLocation) return { path: await window.papertrailDesktop.getProjectLocation() };
  const result = await directoryRequest<{ parentPath: string; path?: string }>(draft, 'defaults');
  return { path: result.path ?? result.parentPath };
}
export function browseDirectories(draft: DirectoryDraft, path?: string): Promise<{ path: string; parent?: string; directories: { name: string; path: string }[] }> {
  return directoryRequest(draft, 'browse', path ? { path } : {});
}
export function previewDirectory(draft: DirectoryDraft, input: { path: string; mode: DirectoryMode }): Promise<{ path: string; name: string }> {
  return directoryRequest(draft, 'preview', { ...input, operationId: draft.operationId });
}
export async function chooseDirectory(defaultPath?: string): Promise<{ supported: boolean; path?: string }> {
  if (!window.papertrailDesktop?.chooseDirectory) return { supported: false };
  return { supported: true, path: await window.papertrailDesktop.chooseDirectory(defaultPath) };
}

const submissionKey = ({ draft, input }: Pending) => JSON.stringify([draft.workspaceId, draft.researchId, draft.operationId, input.title, input.question, input.path, input.mode]);
let creating: { key: string; promise: Promise<string> } | undefined;
export async function createResearchWithDirectory(draft: DirectoryDraft, input: CreateInput): Promise<string> {
  const pending = { draft: { ...draft }, input: { ...input } }, key = submissionKey(pending);
  if (creating) {
    if (creating.key !== key) throw new Error('另一次研究创建正在处理中，请等待完成后重试。');
    return creating.promise;
  }
  const promise = completeResearch(pending.draft, pending.input).finally(() => { creating = undefined; });
  creating = { key, promise };
  return promise;
}
async function completeResearch(draft: DirectoryDraft, input: CreateInput) {
  const data = workspace.getState().data;
  if (data.agentWorkspaceId && data.agentWorkspaceId !== draft.workspaceId) throw new Error('工作区已改变，请重新打开创建窗口。');
  const generation = workspace.getGeneration();
  let expectedWorkspaceId = data.agentWorkspaceId;
  const checkWorkspace = () => {
    if (workspace.getGeneration() !== generation || workspace.getState().data.agentWorkspaceId !== expectedWorkspaceId) throw new Error('工作区已恢复或切换，创建结果已保留，请返回原工作区重试核对。');
  };
  const previous = pendingResearch();
  if (previous && submissionKey(previous) !== submissionKey({ draft, input })) throw new Error('上一次研究创建尚待确认，请先重试恢复。');
  if (!input.title.trim()) throw new Error('请填写研究名称。');
  const pending: Pending = previous ?? { draft, input };
  if (!previous) { await previewDirectory(draft, { path: input.path, mode: input.mode }); checkWorkspace(); }
  storePending(PENDING, pending);
  if (!data.agentWorkspaceId) {
    expectedWorkspaceId = draft.workspaceId;
    workspace.updateData(next => { next.agentWorkspaceId = draft.workspaceId; });
    await workspace.flushSave();
    checkWorkspace();
  }
  const existing = workspace.getState().data.researches[draft.researchId];
  if (!existing) {
    let directory: ResearchDirectory;
    try { directory = await directoryRequest<ResearchDirectory>(draft, 'bind', { path: input.path, mode: input.mode, operationId: draft.operationId }); }
    catch (error) {
      checkWorkspace();
      if (error instanceof DirectoryError && ['directory_exists', 'directory_in_use', 'directory_unwritable', 'invalid_directory', 'directory_unavailable', 'invalid_name'].includes(error.code ?? '')) clearPending(pending);
      throw error;
    }
    checkWorkspace();
    workspace.createResearch(directory.name || input.title, input.question, { id: draft.researchId, directory });
  } else if (!existing.directory) throw new Error('已有研究的目录关联缺失，创建记录已保留。');
  await workspace.flushSave();
  checkWorkspace();
  clearPending(pending);
  try { localStorage.setItem(PARENT, input.mode === 'new' ? input.path.replace(/[\\/][^\\/]+$/, '') : input.path); } catch { /* The research has already been saved. */ }
  workspace.switchResearch(draft.researchId);
  return draft.researchId;
}
export function createResearchLater(input: { title: string; question: string }) {
  return workspace.createResearch(input.title, input.question);
}
export async function resumePendingResearch(): Promise<string | undefined> {
  const pending = pendingResearch();
  if (pending) return createResearchWithDirectory(pending.draft, pending.input);
}
