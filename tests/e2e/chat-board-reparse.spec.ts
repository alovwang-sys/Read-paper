import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { WorkspaceData } from '../../src/domain/types';
import { mockProjectService } from './project-fixture';
import { openSource } from './knowledge-helpers';

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
async function state(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => { const path = '/src/services/workspace.ts'; return (await import(path)).workspace.getState().data; });
}

test('已完成原生白板在本地重新解析，无标签连线可保存且不重新发送问题', async ({ page }) => {
  const seed = createSeed(), conversationId = 'conversation-research-a', requestId = 'saved-board-request', boardId = 'reparsed-board';
  seed.boards = {}; seed.placements = {}; seed.edges = {};
  const summary = '已整理类库、运行镜像与训练流程之间的关系，缺少原文的部分保留为建议。';
  const rawBody = JSON.stringify({ summary, title: '训练流程关系', layout: 'flow', nodes: [
    { group: '代码', card: { title: '类库', body: '定义训练步骤使用的接口；待核查建议。', evidenceIds: [] } },
    { group: '环境', card: { title: '运行镜像', body: '保存依赖和执行环境；待核查建议。', evidenceIds: [] } },
    { group: '流程', card: { title: '训练流程', body: '按顺序执行训练与评估；待核查建议。', evidenceIds: [] } },
  ], edges: [{ from: 0, to: 1 }, { from: 1, to: 2, label: null }] });
  Object.assign(seed.conversations[conversationId], { title: '白板本地恢复 · 测试记录', connectionId: 'codex', requestIds: [requestId], nativeSessionId: 'saved-thread', nativeSessionRef: 'saved-session', nativeState: 'idle', nativeCanResume: true, input: '尚未发送的新问题' });
  seed.requests[requestId] = { id: requestId, researchId: 'research-a', conversationId, connectionId: 'codex', purpose: 'chat', mode: 'live', prompt: '把训练相关组件画成白板', body: rawBody, rawBody, evidenceIds: [], context: [], history: [], status: 'done', createdAt: '2026-10-20T00:00:00.000Z', nativeSessionId: 'saved-thread', nativeTurnId: 'saved-turn', validationError: '白板连线端点或说明无效。',
    boardContext: { intent: 'create', researchId: 'research-a', boardId, revision: 0, snapshot: { board: { id: boardId, researchId: 'research-a', title: '对话白板' }, placements: [], edges: [] }, resources: [], allowedEvidenceIds: [] },
    nativeRun: { managed: true, cursor: 9, delivery: 'accepted', state: 'completed', transport: 'connected', turnId: 'saved-turn', items: [{ id: 'saved-final', type: 'agentMessage', status: 'done', phase: 'final_answer', text: rawBody }] } };
  await mockProjectService(page, { seed, sessions: [{ id: 'saved-session', nativeSessionId: 'saved-thread', agentId: 'codex', title: '已完成白板', updatedAt: '2026-10-20T00:00:00.000Z', state: 'idle', canResume: true, origin: 'read-paper', messages: [] }] });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [{ id: 'codex', name: 'Codex', state: 'ready', version: '模拟运行时', capabilities: { images: false, tools: true, resume: true, permissions: 'read-only' } }] } }));
  await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: { models: [], skills: [], plan: false } }));
  const submissions: string[] = [];
  await page.route(/\/api\/ai\/(chat|agents\/(run|observe|stop|control|respond))$/, route => { submissions.push(route.request().url()); return route.fulfill({ status: 500, json: { error: '本地重新解析不得调用模型或原生回合' } }); });
  await page.goto('/'); await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  const turn = panel(page).locator(`[data-request-id="${requestId}"]`);
  await expect(turn.getByRole('alert')).toContainText('白板方案暂未解析：');
  await expect(turn.getByRole('alert')).not.toContainText('引用检查未通过');
  await turn.getByRole('button', { name: '重新解析白板', exact: true }).click();
  const result = turn.getByRole('region', { name: '聊天生成的白板', exact: true });
  await expect(result.getByText('已保存', { exact: true })).toBeVisible();
  await expect(result.locator('.board-graph-node')).toHaveCount(3); await expect(result.locator('.board-graph-edge')).toHaveCount(2);
  await expect(turn.getByRole('alert')).toHaveCount(0); await expect(turn.locator('.ai-answer')).toContainText(summary);
  await expect(turn.locator('.ai-answer').locator(':scope > .ai-markdown')).toHaveText(summary);
  const repaired = await state(page);
  expect(repaired.requests[requestId]).toMatchObject({ body: rawBody, rawBody, status: 'done', nativeSessionId: 'saved-thread', nativeTurnId: 'saved-turn' });
  expect(repaired.requests[requestId].validationError).toBeUndefined(); expect(repaired.requests[requestId].boardProposal?.edges.map(edge => edge.label)).toEqual(['', '']);
  expect(repaired.conversations[conversationId].requestIds).toEqual([requestId]); expect(Object.keys(repaired.boards)).toEqual([boardId]);
  expect(Object.values(repaired.boardChanges ?? {}).filter(change => change.requestId === requestId)).toHaveLength(1);
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('尚未发送的新问题');
  await expect(page.getByRole('main').locator('canvas').first()).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.reload(); await expect(result.getByText('已保存', { exact: true })).toBeVisible();
  await expect(turn.locator('.ai-answer')).toContainText(summary);
  await result.locator('.board-graph-preview').scrollIntoViewIfNeeded(); await mkdir('docs/verification/native-history-state', { recursive: true });
  await page.screenshot({ path: 'docs/verification/native-history-state/board-reparsed-1440.png' });
  expect(submissions).toEqual([]);
});
