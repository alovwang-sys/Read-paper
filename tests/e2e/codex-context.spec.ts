import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { AIRequest } from '../../src/domain/types';
import { fixtureSessionRef, mockProjectService } from './project-fixture';
import { openSource } from './knowledge-helpers';

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const longHistory = '之前已经完成的研究讨论，继续保留适用条件。'.repeat(4500);

async function start(page: Page, connectionId: 'codex' | 'model') {
  const seed = createSeed(), conversation = seed.conversations['conversation-research-a'];
  conversation.connectionId = connectionId;
  conversation.contextIds = Array.from({ length: 17 }, (_, index) => `codex-context-${index}`);
  for (const id of conversation.contextIds) seed.evidence[id] = { ...seed.evidence['evidence-a'], id, quote: `明确选择的材料 ${id}。` + '原文证据应当完整保留，不可静默截断。'.repeat(90) };
  seed.requests['previous-long-answer'] = {
    id: 'previous-long-answer', researchId: 'research-a', conversationId: conversation.id,
    connectionId, purpose: 'chat', mode: 'live', createdAt: '2026-10-19T00:00:00.000Z', status: 'done',
    prompt: '此前的研究问题', body: longHistory, context: [], history: [], evidenceIds: [],
  };
  conversation.requestIds = ['previous-long-answer'];
  await mockProjectService(page, { seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: true, model: 'fixture-model', images: false, mode: 'live', provider: 'fixture', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [{ id: 'codex', name: 'Codex', state: 'ready', capabilities: { images: false, tools: true, resume: true, permissions: 'read-only' } }] } }));
  await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: { models: [{ id: 'fixture-model', name: 'Fixture model', isDefault: true }], skills: [], plan: false, accessModes: ['read-only'] } }));
  await page.goto('/');
  await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
  await expect(page.getByRole('main').locator('canvas').first()).toBeVisible();
  await expect(page.getByRole('main').locator('.pdf-page-loading')).toHaveCount(0);
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(panel(page).getByText('本轮材料 · 17', { exact: true })).toBeVisible();
  return conversation.contextIds;
}

test('Codex 完整发送超过旧容量的材料且不重发历史，保留引用及刷新记录', async ({ page }) => {
  const runs: AIRequest[] = [];
  await page.route('**/api/ai/agents/run', route => {
    runs.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/x-ndjson', body: [
      { type: 'session', nativeSessionId: 'codex-context-session', nativeSessionRef: fixtureSessionRef('codex-context-session') },
      { type: 'delta', text: '已完整接收 17 条显式材料，并继续前序研究讨论。材料首尾都有可核查依据 [1] [17]。' },
      { type: 'done', nativeSessionId: 'codex-context-session', nativeSessionRef: fixtureSessionRef('codex-context-session'), model: 'fixture-model' },
    ].map(event => JSON.stringify(event)).join('\n') + '\n' });
  });
  const ids = await start(page, 'codex');
  const prompt = '结合全部 17 条材料，继续刚才的研究讨论并保留出处。';
  await panel(page).getByLabel('向 AI 提问').fill(prompt);
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect.poll(() => runs.length).toBe(1);
  expect(runs[0].context.map(item => item.evidenceId)).toEqual(ids);
  expect(runs[0].context.reduce((total, item) => total + item.quote.length, 0)).toBeGreaterThan(24_000);
  expect(runs[0]).toMatchObject({ history: [], managed: true });
  expect(longHistory.length).toBeGreaterThan(80_000);
  await expect(panel(page).locator('.ai-answer').last()).toContainText('已完整接收 17 条显式材料');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.reload();
  await expect(panel(page).locator('.ai-answer').last()).toContainText('已完整接收 17 条显式材料');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('');
  await panel(page).getByText('本轮材料 · 17', { exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  await mkdir('docs/verification/native-continuity', { recursive: true });
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
    await expect(panel(page).getByLabel('向 AI 提问')).toBeVisible();
    await page.screenshot({ path: `docs/verification/native-continuity/context-codex-${width}.png` });
  }
});

test('模型连接仍明确拦截超过旧容量的请求并保留输入', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/ai/chat', route => { calls++; return route.fulfill({ status: 500 }); });
  await start(page, 'model');
  const prompt = '模型直连仍应在超出容量时保留待发送的问题。';
  await panel(page).getByLabel('向 AI 提问').fill(prompt);
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(panel(page).getByRole('alert').filter({ hasText: '上下文过大' })).toBeVisible();
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue(prompt);
  expect(calls).toBe(0);
});
