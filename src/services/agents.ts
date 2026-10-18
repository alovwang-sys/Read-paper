import type { AgentConnection, AgentEvent, AIConnectionId, CodexCapabilities, Conversation, ResearchDirectory, NativeSessionSummary, NativeSessionSnapshot } from '../domain/types';
import { getActiveConversation, workspace, uid } from './workspace';

export function connectionLabel(id?: AIConnectionId) {
  return { model: '模型直连', demo: '演示模式', codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' }[id ?? 'model'];
}

export function conversationConnection(conversation: Conversation): AIConnectionId {
  const data = workspace.getState().data;
  return conversation.connectionId ?? (conversation.requestIds.map(id => data.requests[id]).filter(Boolean).at(-1)?.mode === 'demo'
    || data.sessions[conversation.researchId]?.panel.aiMode === 'demo' ? 'demo' : 'model');
}

export async function getAgents(): Promise<AgentConnection[]> {
  const response = await fetch('/api/ai/agents');
  if (!response.ok) throw new Error('无法连接本机助手服务，请启动 npm run ai 后重新检测。');
  const result = await response.json();
  if (!Array.isArray(result.agents)) throw new Error('助手服务返回了无效连接信息，请重启本地服务。');
  return result.agents.map((agent: AgentConnection) => {
    if (!agent.installation) return agent;
    try {
      const url = new URL(agent.installation.url);
      if (url.protocol === 'https:' && ['learn.chatgpt.com', 'developers.openai.com', 'code.claude.com', 'claude.com', 'opencode.ai'].includes(url.hostname) && !url.username && !url.password)
        return agent;
    } catch { /* Invalid links are omitted; installation never runs automatically. */ }
    const { installation: _untrusted, ...connection } = agent;
    return connection;
  });
}

export async function getCodexCapabilities(): Promise<CodexCapabilities> {
  const response = await fetch('/api/ai/agents/codex/capabilities');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '无法读取 Codex 的模型与 Skills，请重新检测。');
  if (!Array.isArray(result.skills) || !Array.isArray(result.models) || typeof result.plan !== 'boolean') throw new Error('Codex 能力信息格式无效，请升级本机 Codex。');
  return result;
}

export function codexSupportsImages(catalog: CodexCapabilities | undefined, modelId?: string): boolean {
  const model = modelId
    ? catalog?.models.find(item => item.id === modelId)
    : catalog?.models.find(item => item.isDefault) ?? catalog?.models[0];
  return Array.isArray(model?.inputModalities) && model.inputModalities.includes('image');
}

export async function currentAssistantSupportsImages(researchId: string): Promise<boolean> {
  const conversation = getActiveConversation(workspace.getState().data, researchId);
  if (!conversation) return false;
  const connection = conversationConnection(conversation);
  if (connection === 'demo') return true;
  if (connection === 'codex') return codexSupportsImages(await getCodexCapabilities(), conversation.codex?.model);
  if (connection !== 'model') return false;
  const response = await fetch('/api/ai/config');
  if (!response.ok) return false;
  return (await response.json()).images === true;
}

function projectIdentity(researchId: string) {
  if (!workspace.getState().data.agentWorkspaceId) workspace.updateData(data => { data.agentWorkspaceId = uid('workspace'); });
  const { data } = workspace.getState();
  if (!data.researches[researchId]) throw new Error('研究不存在。');
  return { workspaceId: data.agentWorkspaceId!, researchId };
}

async function projectRequest<T>(researchId: string, action: string, values: object = {}): Promise<T> {
  const identity = projectIdentity(researchId);
  const scope = () => {
    const data = workspace.getState().data, directory = data.researches[researchId]?.directory;
    return JSON.stringify([data.agentWorkspaceId, !!data.researches[researchId], directory?.id, directory?.projectId, directory?.path]);
  };
  const submittedScope = scope();
  const payload = JSON.stringify({ ...identity, ...values });
  const unavailable = '无法连接研究目录服务，请启动 npm run ai 后重试。';
  const response = await fetch(`/api/ai/agents/projects/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }).catch(() => { throw new Error(unavailable); });
  const result = await response.json().catch(() => { throw new Error(unavailable); });
  if (scope() !== submittedScope) throw new Error('研究或工作区已恢复，已忽略较早的目录与会话读取，请重新刷新。');
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : unavailable);
  return result as T;
}

export async function getResearchDirectory(researchId: string): Promise<ResearchDirectory | undefined> {
  const directory = await projectRequest<ResearchDirectory | null>(researchId, 'status');
  if (directory) workspace.updateData(data => {
    const research = data.researches[researchId];
    research.directory = directory;
    if (directory.name) research.title = directory.name;
  });
  return directory ?? undefined;
}
export function previewResearchDirectory(path: string, researchId?: string): Promise<{ path: string; name: string }> {
  const scope = workspace.getState().data.scope;
  const id = researchId ?? (scope.kind === 'research' ? scope.researchId : undefined);
  if (!id) return Promise.reject(new Error('请先选择研究。'));
  return projectRequest(id, 'preview', { path });
}
export function browseResearchDirectories(path?: string, researchId?: string): Promise<{ path: string; parent?: string; directories: { name: string; path: string }[] }> {
  const scope = workspace.getState().data.scope;
  const id = researchId ?? (scope.kind === 'research' ? scope.researchId : undefined);
  if (!id) return Promise.reject(new Error('请先选择研究。'));
  return projectRequest(id, 'browse', path ? { path } : {});
}
export async function bindResearchDirectory(researchId: string, path: string): Promise<ResearchDirectory> {
  const directory = await projectRequest<ResearchDirectory>(researchId, 'bind', { path });
  workspace.updateData(data => {
    const research = data.researches[researchId];
    research.directory = directory;
    if (directory.name) research.title = directory.name;
  });
  return directory;
}
export function listProjectSessions(researchId: string): Promise<{ sessions: NativeSessionSummary[]; errors: { agentId: string; error: string }[] }> {
  return projectRequest(researchId, 'list');
}
const historyReads = new Map<string, number>();
async function readLatestHistory(researchId: string, sessionRef: string) {
  const key = JSON.stringify([workspace.getState().data.agentWorkspaceId, researchId, sessionRef]);
  const version = (historyReads.get(key) ?? 0) + 1;
  historyReads.set(key, version);
  const snapshot = await projectRequest<NativeSessionSnapshot>(researchId, 'read', { sessionRef });
  return historyReads.get(key) === version ? snapshot : undefined;
}

function mergeNativeSession(researchId: string, snapshot: NativeSessionSnapshot): string {
  const { data } = workspace.getState();
  const previous = Object.values(data.conversations).find(c => c.researchId === researchId && c.connectionId === snapshot.agentId && (c.nativeSessionRef === snapshot.id || !!snapshot.nativeSessionId && c.nativeSessionId === snapshot.nativeSessionId));
  const id = previous?.id ?? uid('conversation');
  workspace.updateData(next => {
    const existing = next.conversations[id];
    const conversation = next.conversations[id] ??= { id, researchId, connectionId: snapshot.agentId, title: snapshot.title, contextIds: [], requestIds: [], input: '', historyRange: 'all', createdAt: snapshot.updatedAt || new Date().toISOString(), nativeImported: true };
    conversation.nativeSessionRef = snapshot.id;
    conversation.nativeSessionId = snapshot.nativeSessionId;
    conversation.nativeState = snapshot.state;
    conversation.nativeCanResume = snapshot.canResume;
    conversation.nativeReason = [snapshot.reason, snapshot.archiveError].filter(Boolean).join(' ') || undefined;
    if (!existing || !conversation.updatedAt || snapshot.updatedAt > conversation.updatedAt) conversation.updatedAt = snapshot.updatedAt;
    let turn: { id: string; prompt: string; body: string; createdAt: string; original?: string; events?: AgentEvent[] } | undefined;
    const saveTurn = () => {
      if (!turn || !turn.prompt && !turn.body) return;
      const own = turn.original && next.requests[turn.original];
      if (own && own.researchId === researchId && own.conversationId === id) return;
      const prior = conversation.requestIds.map(id => next.requests[id]).find(r => r?.nativeImported && r.nativeMessageId === turn!.id);
      const requestId = prior?.id ?? uid('request');
      const old = next.requests[requestId];
      if (old?.status === 'generating') return;
      next.requests[requestId] = { id: requestId, researchId, conversationId: id, connectionId: snapshot.agentId, nativeSessionId: snapshot.nativeSessionId, nativeImported: true, nativeMessageId: turn.id, prompt: turn.prompt, body: turn.body, events: turn.events, context: [], evidenceIds: [], createdAt: turn.createdAt, status: turn.body.trim() ? 'done' : 'interrupted', ...(!turn.body.trim() ? { error: '这轮原生记录尚无可见回答，请先核对原生记录。' } : {}), purpose: 'chat', mode: 'live', history: [] };
      if (!conversation.requestIds.includes(requestId)) conversation.requestIds.push(requestId);
    };
    for (const message of snapshot.messages) {
      if (message.role === 'user') { saveTurn(); turn = { id: message.id, prompt: message.text, body: '', createdAt: message.createdAt || snapshot.updatedAt || new Date(0).toISOString(), original: message.requestId }; }
      else { turn ??= { id: message.id, prompt: '', body: '', createdAt: message.createdAt || snapshot.updatedAt || new Date(0).toISOString() }; turn.body += (turn.body ? '\n\n' : '') + message.text; }
      if (message.events?.length && turn) turn.events = [...(turn.events ?? []), ...message.events].slice(0, 200);
    }
    saveTurn();
    if (snapshot.truncated) conversation.nativeReason = [conversation.nativeReason, '当前仅载入部分原生历史，完整原始记录仍由原生客户端管理。'].filter(Boolean).join(' ');
  }, { nativeHistoryRef: snapshot.id });
  return id;
}
export async function openProjectSession(researchId: string, summary: NativeSessionSummary): Promise<string> {
  const snapshot = await readLatestHistory(researchId, summary.id);
  const id = snapshot ? mergeNativeSession(researchId, snapshot) : Object.values(workspace.getState().data.conversations).find(c => c.researchId === researchId && c.nativeSessionRef === summary.id)?.id;
  if (!id) throw new Error('正在读取更新的原生记录，请稍后重试。');
  workspace.selectConversation(researchId, id);
  return id;
}
export async function refreshProjectConversation(researchId: string, conversationId: string): Promise<void> {
  const conversation = workspace.getState().data.conversations[conversationId];
  if (!conversation?.nativeSessionRef || conversation.researchId !== researchId || conversation.requestIds.some(id => workspace.getState().data.requests[id]?.status === 'generating')) return;
  const snapshot = await readLatestHistory(researchId, conversation.nativeSessionRef);
  if (snapshot) mergeNativeSession(researchId, snapshot);
}

export function selectAgent(researchId: string, connectionId: AIConnectionId) {
  const data = workspace.getState().data;
  if (!data.researches[researchId]) throw new Error('请先选择研究。');
  const current = getActiveConversation(data, researchId);
  if (current && conversationConnection(current) === connectionId) {
    workspace.updateData(next => { next.conversations[current.id].connectionId = connectionId; });
    return current.id;
  }
  // Keep an explicit identity before the legacy panel preference changes.
  if (current) workspace.updateData(next => { next.conversations[current.id].connectionId = conversationConnection(current); });
  const target = Object.values(workspace.getState().data.conversations)
    .filter(item => item.researchId === researchId && !item.archived && item.connectionId === connectionId)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
  const id = target?.id ?? workspace.createConversation(researchId);
  workspace.updateData(next => {
    const conversation = next.conversations[id];
    conversation.connectionId = connectionId;
    if (!target) conversation.contextIds = [...(current?.contextIds ?? [])];
    next.sessions[researchId].panel.aiMode = connectionId === 'demo' ? 'demo' : 'live';
  });
  workspace.selectConversation(researchId, id);
  return id;
}
