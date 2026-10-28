import { useSyncExternalStore } from 'react';
import type { AIConnectionId } from '../domain/types';
import type { AgentDiagnostics, ResearchAgentCapability } from '../domain/research-agent';
import { getResearchAgentCapabilities } from './research-agent';

type State = { list: ResearchAgentCapability[]; error: string; loading: boolean; checkedAt?: number };
let state: State = { list: [], error: '', loading: false };
let inflight: Promise<void> | undefined;
const listeners = new Set<() => void>();
function update(next: Partial<State>) { state = { ...state, ...next }; listeners.forEach(listener => listener()); }

/** One shared detection for the composer and failed turns; concurrent callers reuse the same request. */
export function refreshCapabilities() {
  inflight ??= (async () => {
    update({ loading: true });
    try { update({ list: await getResearchAgentCapabilities(), error: '', checkedAt: Date.now() }); }
    catch (problem) { update({ error: (problem as Error).message }); }
    finally { update({ loading: false }); inflight = undefined; }
  })();
  return inflight;
}

export function useCapabilities() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
}

// Demo is never offered as a stand-in for a real assistant.
const PREFERENCE: AIConnectionId[] = ['codex', 'claude', 'opencode', 'model'];
export function readyAlternative(list: ResearchAgentCapability[], current: AIConnectionId) {
  return PREFERENCE.find(id => id !== current && list.find(item => item.id === id)?.research);
}

export async function getAgentDiagnostics(): Promise<AgentDiagnostics> {
  const response = await fetch('/api/ai/research/diagnose');
  if (!response.ok) throw new Error('无法读取本机助手诊断，请确认本机 AI 服务正在运行。');
  const result = await response.json();
  if (!Array.isArray(result.agents) || !result.environment) throw new Error('诊断信息格式无效，请重启本机服务。');
  return result;
}
