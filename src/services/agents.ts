import type { AgentConnection, AIConnectionId, Conversation } from '../domain/types';
import { getActiveConversation, workspace } from './workspace';

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
  return result.agents;
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
