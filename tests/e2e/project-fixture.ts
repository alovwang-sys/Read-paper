import type { Page } from '@playwright/test';
import { createSeed } from '../../src/data/seed';
import type { NativeSessionSnapshot, NativeSessionSummary, ResearchDirectory } from '../../src/domain/types';

export const fixtureDirectory: ResearchDirectory = { id: 'binding-research-a', projectId: 'project-research-a', path: '/fixture/research-a' };
export const fixtureSessionRef = (nativeSessionId: string) => `fixture-${nativeSessionId}`;

// Deterministic project service; it never reads or writes the user's filesystem or native histories.
export async function mockProjectService(page: Page, options: { bound?: boolean; sessions?: NativeSessionSnapshot[]; seed?: ReturnType<typeof createSeed>; names?: Record<string, string> } = {}) {
  const seed = options.seed ?? createSeed();
  if (options.bound !== false) for (const research of Object.values(seed.researches)) research.directory = { id: `binding-${research.id}`, projectId: `project-${research.id}`, path: `/fixture/${research.id}` };
  await page.addInitScript(value => { if (!sessionStorage.getItem('papertrail-project-fixture-ready')) { localStorage.setItem('papertrail-recovery-v2', JSON.stringify(value)); sessionStorage.setItem('papertrail-project-fixture-ready', 'true'); } }, seed);
  const state = { names: { ...options.names } as Record<string, string>, bound: options.bound !== false, sessions: options.sessions ?? [], calls: [] as { action: string; body: Record<string, unknown> }[], errors: [] as { agentId: string; error: string }[], failList: false, failDirectory: false };
  await page.route('**/api/ai/agents/projects/*', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const action = new URL(route.request().url()).pathname.split('/').at(-1)!;
    state.calls.push({ action, body });
    const name = state.names[String(body.researchId)];
    const directory = { id: `binding-${body.researchId}`, projectId: `project-${body.researchId}`, path: `/fixture/${body.researchId}`, ...(name ? { name } : {}) };
    if (action === 'status') return route.fulfill(state.failDirectory ? { status: 409, json: { error: '研究目录暂时不可用，请重新连接。' } } : { json: state.bound ? directory : null });
    if (action === 'browse') return route.fulfill({ json: { path: body.path || '/fixture', parent: body.path === '/fixture' || !body.path ? '/' : '/fixture', directories: body.path === '/fixture/research-a' ? [] : [{ name: 'research-a', path: '/fixture/research-a' }] } });
    if (action === 'preview') return route.fulfill({ json: { path: body.path, name: String(body.path).split('/').at(-1) } });
    if (action === 'bind') { state.bound = true; const name = String(body.path).split(/[\\/]/).filter(Boolean).at(-1)!; state.names[String(body.researchId)] = name; return route.fulfill({ json: { ...directory, name, path: body.path, researchId: body.researchId } }); }
    if (action === 'list') return route.fulfill(state.failList ? { status: 503, json: { error: '暂时无法更新，显示上次记录。' } } : { json: { sessions: state.sessions.map(({ messages: _messages, ...summary }) => summary satisfies NativeSessionSummary), errors: state.errors } });
    if (action === 'read') {
      const snapshot = state.sessions.find(item => item.id === body.sessionRef);
      return route.fulfill({ json: snapshot ?? { id: body.sessionRef, agentId: 'codex', nativeSessionId: String(body.sessionRef).replace(/^fixture-/, ''), title: '模拟项目对话', updatedAt: '', state: 'idle', canResume: true, origin: 'read-paper', messages: [] } });
    }
    return route.fulfill({ status: 404, json: { error: 'Unknown test action' } });
  });
  return state;
}
