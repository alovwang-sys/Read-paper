import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { ContextSnapshot, NativeSessionSnapshot } from '../../src/domain/types';
import { openResearchNavigation, switchResearch } from './knowledge-helpers';
import { fixtureSessionRef, mockProjectService } from './project-fixture';
import { state } from './workspace-split-helpers';

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const input = (page: Page) => panel(page).getByLabel('向 AI 提问');
const title = '垂直空间验收 · 模拟会话';
const question = '模拟问题：检索增强的收益依赖哪些条件？';
const pendingInput = '尚未发送：继续核对原文中的限制条件';
const answer = [
  '模拟回答，仅用于布局与恢复验收，未调用真实模型。',
  '检索增强的收益依赖证据的相关性，核查时需要保留实验设置和适用范围。 [1]',
  ...Array.from({ length: 8 }, (_, index) => `${index + 1}. 核查点：把论文报告的事实与研究者自己的推断分开，逐项记录语料条件、来源页码、评估方式及尚未验证的限制。`),
  '继续阅读时，可以把仍有疑问的原文保留为本轮材料，再形成可编辑的观点草稿。',
].join('\n\n');

async function start(page: Page) {
  const seed = createSeed();
  const evidence = seed.evidence['evidence-a'];
  const document = seed.documents[evidence.documentId];
  const context: ContextSnapshot = { evidenceId: evidence.id, documentId: document.id, documentHash: document.hash ?? '', title: document.title, pageIndex: evidence.pageIndex, quote: evidence.quote };
  const nativeSessionId = 'ai-space-simulated-session';
  const session: NativeSessionSnapshot = {
    id: fixtureSessionRef(nativeSessionId), agentId: 'codex', nativeSessionId, title,
    updatedAt: '2026-10-20T08:00:00.000Z', state: 'idle', canResume: true, origin: 'read-paper',
    messages: [
      { id: 'ai-space-user', role: 'user', text: question, requestId: 'request-ai-space' },
      { id: 'ai-space-assistant', role: 'assistant', text: answer },
    ],
  };
  for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'codex';
  Object.assign(seed.conversations['conversation-research-a'], {
    title, input: pendingInput, contextIds: [evidence.id], requestIds: ['request-ai-space'],
    nativeSessionId, nativeSessionRef: session.id, nativeState: 'idle', nativeCanResume: true,
    sentContext: [context], historyRange: 'all', updatedAt: session.updatedAt,
  });
  seed.requests['request-ai-space'] = {
    id: 'request-ai-space', researchId: 'research-a', conversationId: 'conversation-research-a',
    prompt: question, context: [context], createdAt: session.updatedAt, status: 'done', body: answer,
    evidenceIds: [evidence.id], purpose: 'chat', mode: 'live', connectionId: 'codex', nativeSessionId,
    model: 'layout-test-model · 模拟模型', history: [],
  };
  seed.sessions['research-a'].active = { kind: 'draft', id: 'draft-a' };
  seed.sessions['research-a'].openItems = [{ kind: 'draft', id: 'draft-a' }];
  seed.sessions['research-a'].panel.mode = 'ai';
  seed.sessions['research-a'].panel.aiMode = 'live';
  seed.sessions['research-a'].activeConversationId = 'conversation-research-a';

  const unexpected: string[] = [];
  let runs = 0;
  // Catch every other AI endpoint so this layout test cannot reach a real local service.
  await page.route('**/api/ai/**', route => {
    unexpected.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 501, json: { error: '布局验收未模拟此接口' } });
  });
  await mockProjectService(page, { seed, sessions: [session] });
  await page.route('**/api/ai/config', route => route.fulfill({ json: {
    configured: false, images: false, model: '模拟连接',
    limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 },
  } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [{
    id: 'codex', name: 'Codex · 模拟连接', state: 'ready',
    capabilities: { images: false, tools: true, resume: true, permissions: 'read-only' },
  }] } }));
  await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: {
    models: [{ id: 'layout-test-model', name: '布局验收 · 模拟模型', isDefault: true, reasoningEfforts: [{ effort: 'medium', description: '模拟档位' }], defaultReasoningEffort: 'medium' }],
    skills: [], plan: true, accessModes: ['read-only', 'full-access'],
  } }));
  await page.route('**/api/ai/agents/run', route => {
    runs++;
    return route.fulfill({ contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'delta', text: '意外发送的模拟回答' })}\n${JSON.stringify({ type: 'done', model: 'layout-test-model' })}\n` });
  });
  await page.goto('/');
  await expect(page.getByRole('main').getByLabel('结论正文')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Codex 推理强度', exact: true })).toHaveText('Medium');
  await expect(panel(page).getByRole('log', { name: '对话消息' })).toContainText('模拟回答，仅用于布局与恢复验收');
  await expect(input(page)).toHaveValue(pendingInput);
  return { evidence, document, unexpected, runs: () => runs };
}

async function checkLayout(page: Page, viewport: { width: number; height: number }) {
  const chat = panel(page).getByRole('log', { name: '对话消息' });
  await expect.poll(async () => (await chat.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(viewport.height - 205);
  expect(await chat.evaluate(element => element.scrollHeight)).toBeGreaterThan((await chat.boundingBox())!.height);
  const bounds = (await panel(page).boundingBox())!;
  const chatBounds = (await chat.boundingBox())!;
  expect(chatBounds.y).toBeLessThanOrEqual(85);
  expect((await input(page).boundingBox())!.height).toBeLessThanOrEqual(48);
  expect((await input(page).boundingBox())!.y - chatBounds.y - chatBounds.height).toBeLessThanOrEqual(36);
  for (const control of [input(page), panel(page).getByRole('button', { name: '发送问题', exact: true })]) {
    await expect(control).toBeVisible();
    await expect(control).toBeInViewport({ ratio: 1 });
    const box = (await control.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(bounds.y);
    expect(box.y + box.height).toBeLessThanOrEqual(Math.min(viewport.height, bounds.y + bounds.height) + 1);
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  }
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  const composer = panel(page).locator('.codex-composer-tools');
  expect(await composer.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual((await composer.boundingBox())!.width + 1);
  expect((await composer.locator('.codex-composer-toolbar').boundingBox())!.height).toBeLessThanOrEqual(43);
}

async function saveBeforeScreenshot(page: Page) {
  await panel(page).getByRole('log', { name: '对话消息' }).evaluate(element => { element.scrollTop = 0; });
  // Scroll positions are persisted after the 250 ms debounce.
  await page.waitForTimeout(300);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await expect(page.locator('.project-file-compact')).toContainText('目录文件已更新');
  await mkdir('docs/verification/ai-space-expanded', { recursive: true });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`AI 对话保留纵向阅读空间，材料与输入按研究恢复 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await start(page);
    const picker = panel(page).getByRole('button', { name: '切换 AI 助手', exact: true });
    await picker.click();
    await expect(panel(page).getByRole('dialog', { name: '选择 AI 助手', exact: true })).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await expect(picker).toBeFocused();
    await expect(panel(page).locator('.ai-board-options')).not.toHaveAttribute('open', '');
    const materials = panel(page).locator('.ai-materials');
    await expect(materials).not.toHaveAttribute('open', '');
    await expect(materials.locator(':scope > summary')).toContainText('本轮材料 · 1');
    await expect(materials.locator(':scope > summary')).toContainText(fixture.document.title);
    await checkLayout(page, viewport);
    await input(page).fill(Array.from({ length: 10 }, (_, index) => `第 ${index + 1} 条尚未发送的核查问题`).join('\n'));
    await expect.poll(async () => (await input(page).boundingBox())!.height).toBeGreaterThanOrEqual(100);
    await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeInViewport({ ratio: 1 });
    await input(page).fill(pendingInput);
    await checkLayout(page, viewport);

    await materials.locator(':scope > summary').click();
    await expect(materials.getByRole('button', { name: '移除本轮材料 1', exact: true })).toBeVisible();
    await materials.locator('.ai-material details > summary').click();
    await expect(materials.locator('blockquote')).toHaveText(fixture.evidence.quote);
    await expect(materials.locator('.ai-material details > summary')).toContainText(`PDF 第 ${fixture.evidence.pageIndex + 1} 页`);
    if (viewport.width === 1440) {
      await saveBeforeScreenshot(page);
      await page.screenshot({ path: 'docs/verification/ai-space-expanded/materials-1440.png' });
    }
    await materials.locator(':scope > summary').click();

    const scope = panel(page).locator('.ai-context-settings');
    await scope.locator(':scope > summary').click();
    await expect(scope.locator(':scope > summary')).toHaveText('连续对话');
    await expect(scope.getByLabel('前序对话范围')).toHaveCount(0);
    await expect(scope).toContainText('每轮继续同一个 Codex 会话，上下文由 Codex 管理');
    expect((await state(page)).conversations['conversation-research-a'].historyRange).toBe('all');
    const directory = (await openResearchNavigation(page)).getByRole('button', { name: '项目设置 · 检索增强，何时有效？', exact: true });
    await expect(directory).toBeVisible();
    await expect(directory).toHaveAttribute('title', /\/fixture\/research-a/);
    if (viewport.width <= 1024) await page.getByRole('button', { name: '关闭导航抽屉', exact: true }).click();
    await scope.locator('.ai-history-scope > summary').click();
    await scope.locator('.ai-history-scope > details > summary').click();
    await expect(scope.locator('.ai-history-scope')).toContainText(question);
    await expect(scope.locator('.ai-history-scope')).toContainText('模拟回答，仅用于布局与恢复验收');
    await scope.locator(':scope > summary').click();
    await expect(input(page)).toHaveValue(pendingInput);

    await panel(page).getByRole('button', { name: '查看会话历史', exact: true }).click();
    await expect(panel(page).locator('.ai-history-item')).toContainText(title);
    await panel(page).getByRole('button', { name: '返回当前对话', exact: true }).click();
    await expect(input(page)).toHaveValue(pendingInput);
    await panel(page).getByRole('tab', { name: '摘录', exact: true }).click();
    await expect(panel(page).getByRole('tab', { name: '摘录', exact: true })).toHaveAttribute('aria-selected', 'true');
    await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await expect(input(page)).toHaveValue(pendingInput);

    await switchResearch(page, 'research-b');
    await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await expect(input(page)).toHaveValue('');
    await expect(panel(page).locator('.ai-materials > summary')).toContainText('本轮材料 · 0');
    await switchResearch(page, 'research-a');
    await expect(input(page)).toHaveValue(pendingInput);
    await expect(panel(page).locator('.ai-materials > summary')).toContainText('本轮材料 · 1');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    await page.reload();
    await expect(input(page)).toHaveValue(pendingInput);
    await expect(panel(page).locator('.ai-materials > summary')).toContainText(fixture.document.title);
    await expect(panel(page).getByRole('log', { name: '对话消息' })).toContainText(question);
    await checkLayout(page, viewport);
    const chatHeight = (await panel(page).getByRole('log', { name: '对话消息' }).boundingBox())!.height;
    console.info(`${viewport.width}×${viewport.height}: 对话区 ${chatHeight}px，占视口 ${(chatHeight / viewport.height * 100).toFixed(1)}%`);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.runs()).toBe(0);

    await saveBeforeScreenshot(page);
    await page.screenshot({ path: `docs/verification/ai-space-expanded/chat-${viewport.width}.png` });
  });
}
