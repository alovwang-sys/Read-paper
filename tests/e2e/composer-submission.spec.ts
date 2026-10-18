import { test as base, expect, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { AIConnectionId, WorkspaceData } from '../../src/domain/types';
import { fixtureSessionRef, mockProjectService } from './project-fixture';
import { openSource, switchResearch } from './knowledge-helpers';

type Run = { requestId: string; researchId?: string; conversationId?: string; prompt?: string; messages?: { role: string; content: string }[] };
type API = { url: string; runs: Run[]; finish: (requestId: string) => void; disconnect: (requestId: string) => void };
const answer = '模拟回答：已完整接收问题，继续保留原文条件。';
const test = base.extend<{ api: API }>({ api: async ({}, use) => {
  const pending = new Map<string, ServerResponse>();
  const api: API = {
    url: '', runs: [],
    finish(requestId) {
      const response = pending.get(requestId);
      if (!response) throw new Error(`No pending request: ${requestId}`);
      response.end(JSON.stringify({ type: 'delta', text: answer }) + '\n' + JSON.stringify({ type: 'done', model: 'fixture-model' }) + '\n');
      pending.delete(requestId);
    },
    disconnect(requestId) {
      const response = pending.get(requestId);
      if (!response) throw new Error(`No pending request: ${requestId}`);
      response.destroy(); pending.delete(requestId);
    },
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Run;
    api.runs.push(body);
    response.setHeader('Content-Type', 'application/x-ndjson'); response.flushHeaders();
    if (request.url?.endsWith('/run')) response.write(JSON.stringify({ type: 'session', nativeSessionId: `submission-${api.runs.length}`, nativeSessionRef: fixtureSessionRef(`submission-${api.runs.length}`) }) + '\n');
    pending.set(body.requestId, response);
    response.on('close', () => pending.delete(body.requestId));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  api.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await use(api);
  for (const response of pending.values()) response.destroy();
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
} });

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const input = (page: Page) => panel(page).getByLabel('向 AI 提问');
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
async function state(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const recovery = localStorage.getItem('papertrail-recovery-v3');
    if (recovery) return JSON.parse(recovery);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const value = await new Promise<WorkspaceData>((resolve, reject) => {
      const request = db.transaction('workspace').objectStore('workspace').get('current');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close(); return value;
  });
}
async function start(page: Page, api: API, connectionId: AIConnectionId = 'codex') {
  const seed = createSeed();
  for (const conversation of Object.values(seed.conversations)) conversation.connectionId = connectionId;
  const project = await mockProjectService(page, { seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: true, images: false, model: 'fixture-model', provider: 'fixture', mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: ['codex', 'claude', 'opencode'].map(id => ({ id, name: id, state: 'ready', capabilities: { images: false, tools: true, resume: true, permissions: 'read-only' } })) } }));
  await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: { models: [{ id: 'fixture-model', name: 'Fixture Model', isDefault: true, reasoningEfforts: [{ effort: 'medium', description: '模拟默认档位' }], defaultReasoningEffort: 'medium' }], skills: [], plan: true, accessModes: ['read-only'] } }));
  for (const path of ['/api/ai/agents/run', '/api/ai/chat']) await page.route(`**${path}`, route => route.continue({ url: api.url + path }));
  await page.goto('/');
  await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible();
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  return project;
}
async function send(page: Page, api: API, prompt: string) {
  const count = api.runs.length;
  await input(page).fill(prompt); await expect(input(page)).toHaveValue(prompt);
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect.poll(() => api.runs.length).toBe(count + 1);
  return api.runs[count];
}
async function ended(page: Page, run: Run, status: 'done' | 'error') {
  await expect.poll(async () => (await state(page)).requests[run.requestId]?.status).toBe(status);
  await expect(panel(page).getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
}

for (const connection of ['codex', 'model'] as const) {
  test(`${connection}：超过六千中文字的问题完整进入请求和会话记录`, async ({ page, api }) => {
    await start(page, api, connection);
    const prompt = '这是一段用于核对长问题完整传输的中文内容。'.repeat(310) + '末尾校验：请保留全部研究条件。';
    expect(prompt.length).toBeGreaterThan(6000);
    const run = await send(page, api, prompt);
    expect(connection === 'model' ? run.messages?.at(-1)?.content : run.prompt).toBe(prompt);
    await expect(input(page)).toHaveValue('');
    api.finish(run.requestId); await ended(page, run, 'done');
    expect((await state(page)).requests[run.requestId].prompt).toBe(prompt);
    await expect(input(page)).toHaveValue('');
  });

  for (const outcome of ['done', 'error'] as const) {
    test(`${connection}：生成挂起时输入即清空，${outcome} 不覆盖下一条草稿`, async ({ page, api }) => {
      await start(page, api, connection);
      const run = await send(page, api, '请核对论文中的研究条件。');
      await expect(input(page)).toHaveValue('');
      await expect(input(page)).toBeEditable();
      const nextDraft = '下一条问题还没发送，请保留这段草稿。';
      await input(page).fill(nextDraft);
      if (outcome === 'done') api.finish(run.requestId); else api.disconnect(run.requestId);
      await ended(page, run, outcome); await expect(input(page)).toHaveValue(nextDraft);
      expect(api.runs).toHaveLength(1);
      await saved(page); await page.reload(); await expect(input(page)).toHaveValue(nextDraft);
    });
  }
}

test('原生发送前同步失败保留输入，且不建立或发送请求', async ({ page, api }) => {
  await start(page, api);
  await page.route('**/api/ai/agents/projects/sync', route => route.fulfill({ status: 503, json: { error: '模拟目录同步失败，原输入仍可重试。' } }));
  const prompt = '发送前失败应该保留的完整原输入。';
  await input(page).fill(prompt); await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(panel(page).getByRole('alert')).toContainText('模拟目录同步失败');
  await expect(input(page)).toHaveValue(prompt);
  expect(api.runs).toHaveLength(0); expect(Object.keys((await state(page)).requests)).toHaveLength(0);
  await saved(page); await page.reload(); await expect(input(page)).toHaveValue(prompt);
});

test('网络中断且没有新草稿时恢复原输入，刷新后可重试', async ({ page, api }) => {
  await start(page, api);
  const prompt = '网络中断后需要恢复的原问题。';
  const run = await send(page, api, prompt); await expect(input(page)).toHaveValue('');
  api.disconnect(run.requestId); await ended(page, run, 'error');
  await expect(input(page)).toHaveValue(prompt); await saved(page); await page.reload();
  await expect(input(page)).toHaveValue(prompt);
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeEnabled();
});

for (const outcome of ['done', 'error'] as const) {
  test(`研究切换后迟到的 ${outcome} 只更新原研究，输入分别恢复`, async ({ page, api }) => {
    await start(page, api, 'model');
    const prompt = '研究 A 正在提交的问题。', draftB = '研究 B 独立且尚未发送的草稿。';
    const run = await send(page, api, prompt); await expect(input(page)).toHaveValue('');
    await switchResearch(page, 'research-b'); await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await input(page).fill(draftB);
    if (outcome === 'done') api.finish(run.requestId); else api.disconnect(run.requestId);
    await ended(page, run, outcome); await expect(input(page)).toHaveValue(draftB);
    await switchResearch(page, 'research-a'); await expect(input(page)).toHaveValue(outcome === 'error' ? prompt : '');
    expect((await state(page)).requests[run.requestId].researchId).toBe('research-a');
    await saved(page); await page.reload(); await expect(input(page)).toHaveValue(outcome === 'error' ? prompt : '');
    await switchResearch(page, 'research-b'); await expect(input(page)).toHaveValue(draftB);
  });
}

test('回答尚未结束时刷新，已提交问题留在记录而下一条草稿恢复', async ({ page, api }) => {
  await start(page, api, 'model');
  const run = await send(page, api, '刷新前已提交的问题。'); await expect(input(page)).toHaveValue('');
  const draft = '刷新前写下且尚未提交的下一条。';
  await input(page).fill(draft); await saved(page); await page.reload();
  await expect(input(page)).toHaveValue(draft);
  const restored = (await state(page)).requests[run.requestId];
  expect(restored.prompt).toBe('刷新前已提交的问题。'); expect(restored.status).toBe('interrupted');
  expect(api.runs).toHaveLength(1);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`原文旁发送后继续写下一条草稿 ${viewport.width}`, async ({ page, api }) => {
    await page.setViewportSize(viewport); await start(page, api);
    await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
    await expect(page.getByRole('main').locator('canvas').first()).toBeVisible();
    await expect(page.getByRole('main').locator('.pdf-page-loading')).toHaveCount(0);
    const run = await send(page, api, '请核对这篇论文的实验条件。');
    await expect(input(page)).toHaveValue('');
    await input(page).fill('下一条草稿：这些条件是否适用于新的证据集？');
    const closeNotice = page.getByRole('button', { name: '关闭提示', exact: true }); if (await closeNotice.isVisible()) await closeNotice.click();
    const bounds = (await input(page).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await saved(page); await page.evaluate(() => document.fonts.ready);
    await mkdir('docs/verification/composer-fixes', { recursive: true });
    await page.screenshot({ path: `docs/verification/composer-fixes/composer-${viewport.width}.png` });
    api.finish(run.requestId); await ended(page, run, 'done');
    await expect(input(page)).toHaveValue('下一条草稿：这些条件是否适用于新的证据集？');
  });
}
