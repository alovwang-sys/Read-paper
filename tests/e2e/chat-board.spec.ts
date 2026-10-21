import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { WorkspaceData } from '../../src/domain/types';
import { openResearchPage, openSource, switchResearch } from './knowledge-helpers';
import { layout, pane, panes, split } from './workspace-split-helpers';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
async function openBoardTools(page: Page) {
  const tools = panel(page).locator('.ai-board-options');
  if (await tools.getAttribute('open') === null) await tools.locator(':scope > summary').click();
}
const result = (page: Page) => panel(page).getByRole('region', { name: '聊天生成的白板', exact: true }).last();
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
async function data(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => { const path = '/src/services/workspace.ts'; return (await import(path)).workspace.getState().data; });
}
async function start(page: Page, view: 'pdf' | 'draft' = 'draft') {
  const seed = createSeed();
  seed.agentWorkbench = false;
  seed.boards = {}; seed.placements = {}; seed.edges = {};
  await page.addInitScript(value => { if (!sessionStorage.getItem('chat-board-seeded')) { localStorage.setItem('papertrail-recovery-v3', JSON.stringify(value)); sessionStorage.setItem('chat-board-seeded', '1'); } }, seed);
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, model: 'chat-board-test', images: false } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/chat', route => route.fulfill({ status: 503, json: { error: '本测试禁止真实模型调用' } }));
  await page.goto('/'); await saved(page);
  if (view === 'pdf') { await openSource(page, 'Adaptive Retrieval: Evidence & Reliability'); await expect(main(page).locator('canvas').first()).toBeVisible(); }
  else await openResearchPage(page, '检索增强的适用条件');
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
  await panel(page).getByRole('button', { name: '演示模式', exact: true }).click();
  await openBoardTools(page);
  await expect(panel(page).getByRole('button', { name: '生成白板', exact: true })).toBeEnabled();
  expect(Object.keys((await data(page)).boards)).toHaveLength(0);
}
async function send(page: Page, prompt: string) {
  await panel(page).getByLabel('向 AI 提问').fill(prompt);
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect.poll(async () => Object.values((await data(page)).requests).at(-1)?.status).toBe('done');
}
async function created(page: Page) {
  await expect(result(page).getByText('已保存', { exact: true })).toBeVisible();
  await expect(result(page).locator('.board-graph-node')).toHaveCount(3);
  await expect(result(page).locator('.board-graph-edge')).toHaveCount(2);
  await saved(page);
}

test('PDF聊天直接画图自动保存，刷新后撤销并恢复，重新生成独立白板', async ({ page }) => {
  await start(page, 'pdf');
  const right = await split(page, pane(page, 1), '右');
  await right.getByLabel('PDF 页码', { exact: true }).fill('2');
  await expect(right.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await saved(page);
  const beforeLayout = await layout(page);
  await send(page, '把当前讨论画成关系图，分为研究问题、分析步骤和待核查结论。');
  await created(page);
  await expect(panes(page)).toHaveCount(2);
  await expect(pane(page, 1).getByRole('region', { name: 'PDF 阅读器', exact: true })).toBeVisible();
  await expect(right.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(panel(page).getByRole('button', { name: '确认应用此批变更', exact: true })).toHaveCount(0);
  expect(await layout(page)).toEqual(beforeLayout);
  const state = await data(page), request = Object.values(state.requests).at(-1)!;
  expect(request.connectionId).toBe('demo');
  expect(request.boardContext?.intent).toBe('create');
  const boardId = request.boardContext!.boardId;
  expect(state.boards[boardId].researchId).toBe('research-a');
  expect(Object.values(state.boardChanges ?? {}).filter(change => change.requestId === request.id)).toHaveLength(1);
  await page.reload();
  await created(page);
  await expect(panes(page)).toHaveCount(2);
  await expect(pane(page, 1).getByRole('region', { name: 'PDF 阅读器', exact: true })).toBeVisible();
  await expect(right.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await result(page).getByRole('button', { name: '撤销创建', exact: true }).click();
  await expect(result(page).getByText('已撤销创建', { exact: true })).toBeVisible();
  await saved(page);
  expect((await data(page)).boards[boardId]).toBeUndefined();
  await expect(result(page).getByRole('button', { name: '重试保存白板', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(result(page).getByText('已撤销创建', { exact: true })).toBeVisible();
  expect((await data(page)).boards[boardId]).toBeUndefined();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'workspace') { IDBObjectStore.prototype.put = original; throw new DOMException('restore test quota', 'QuotaExceededError'); }
      return original.apply(this, args);
    };
  });
  await result(page).getByRole('button', { name: '恢复白板', exact: true }).click();
  await expect(result(page).getByRole('alert')).toContainText('保存');
  const historyBeforeRetry = (await data(page)).boardChanges;
  await result(page).getByRole('button', { name: '重试保存恢复', exact: true }).click();
  await expect(result(page).getByRole('alert')).toHaveCount(0);
  expect((await data(page)).boardChanges).toEqual(historyBeforeRetry);
  await created(page);
  const restored = await data(page);
  expect(restored.boards[boardId]).toEqual(state.boards[boardId]);
  const createdCards = Object.values(state.boardChanges ?? {}).find(change => change.requestId === request.id)!.createdCards!;
  for (const card of createdCards) expect(restored.cards[card.id]).toEqual(card);
  await expect(panes(page)).toHaveCount(2);
  await expect(pane(page, 1).getByRole('region', { name: 'PDF 阅读器', exact: true })).toBeVisible();
  await expect(right.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await page.reload(); await created(page);
  expect((await data(page)).boards[boardId]).toEqual(state.boards[boardId]);
  await panel(page).getByRole('button', { name: '再生成一张白板', exact: true }).click();
  await expect.poll(async () => Object.keys((await data(page)).boards).length).toBe(2);
  await expect(panel(page).getByRole('dialog')).toHaveCount(0);
  expect((await data(page)).boards[boardId]).toEqual(state.boards[boardId]);
  await expect(panes(page)).toHaveCount(2);
  await expect(pane(page, 1).getByRole('region', { name: 'PDF 阅读器', exact: true })).toBeVisible();
  await expect(right.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
});

test('普通和否定问答不画，文稿中按钮用当前输入生成；打开白板由用户触发，三尺寸可用', async ({ page }) => {
  await start(page);
  await send(page, '请解释检索增强的适用条件。');
  await send(page, '不要画白板，只解释证据相关性的含义。');
  expect(Object.keys((await data(page)).boards)).toHaveLength(0);
  await panel(page).getByLabel('向 AI 提问').fill('比较检索与生成环节，再联系证据核查。');
  await openBoardTools(page);
  await panel(page).getByRole('button', { name: '生成白板', exact: true }).click();
  await created(page);
  await expect(main(page).getByLabel('结论正文')).toBeVisible();
  expect(Object.values((await data(page)).requests).at(-1)?.prompt).toBe('比较检索与生成环节，再联系证据核查。');
  await mkdir('docs/verification/chat-board', { recursive: true });
  await result(page).evaluate(element => element.scrollIntoView({ block: 'start' }));
  await expect(result(page).getByRole('button', { name: '打开白板', exact: true })).toBeInViewport();
  await expect(result(page).getByRole('button', { name: '撤销创建', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'docs/verification/chat-board/result-heading-1440.png' });
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await openBoardTools(page);
    await expect(panel(page).getByRole('button', { name: '生成白板', exact: true })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeVisible();
    await result(page).locator('.board-graph-preview').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: `docs/verification/chat-board/created-${width}.png` });
  }
  await result(page).getByRole('button', { name: '打开白板', exact: true }).click();
  await expect(main(page).locator('.board-node')).toHaveCount(3);
  await panel(page).getByLabel('向 AI 提问').fill('这段输入还没有发送');
  await switchResearch(page, 'research-b'); await switchResearch(page, 'research-a');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('这段输入还没有发送');
  await saved(page); await page.reload();
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('这段输入还没有发送');
});

const structuredQuestion = '请比较以下流程：\n- 输入：研究问题与材料\n- 分析：比较支持与反例\n- 输出：待核查结论';
test('关系建议只提示一次，忽略后不再出现且不创建白板', async ({ page }) => {
  await start(page);
  await send(page, structuredQuestion);
  const suggestion = panel(page).getByLabel('白板建议', { exact: true });
  await expect(suggestion).toBeVisible();
  expect(Object.keys((await data(page)).boards)).toHaveLength(0);
  await suggestion.getByRole('button', { name: '暂不需要', exact: true }).click();
  await send(page, structuredQuestion + '，继续逐项说明。');
  await expect(suggestion).toHaveCount(0);
  await saved(page); await page.reload();
  await expect(suggestion).toHaveCount(0);
  expect(Object.keys((await data(page)).boards)).toHaveLength(0);
});

test('点击关系建议直接创建，迟到结果归原研究且不切走当前工作区', async ({ page }) => {
  await start(page);
  await send(page, structuredQuestion);
  await panel(page).getByLabel('向 AI 提问').fill('还没写完的下一轮问题，请勿发送');
  await panel(page).getByRole('button', { name: '生成关系图', exact: true }).click();
  await switchResearch(page, 'research-b');
  await expect(panel(page).getByRole('region', { name: '聊天生成的白板', exact: true })).toHaveCount(0);
  await expect.poll(async () => Object.values((await data(page)).boards).length).toBe(1);
  const state = await data(page);
  expect(state.scope).toEqual({ kind: 'research', researchId: 'research-b' });
  expect(Object.values(state.boards)[0].researchId).toBe('research-a');
  await switchResearch(page, 'research-a');
  await created(page);
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('还没写完的下一轮问题，请勿发送');
  expect(Object.values((await data(page)).requests).at(-1)!.prompt).not.toContain('还没写完');
  await expect(main(page).getByLabel('结论正文')).toBeVisible();
  await expect(panel(page).getByLabel('白板建议', { exact: true })).toHaveCount(0);
});

test('停止不落白板；自动保存失败可重试，创建批次保持唯一', async ({ page }) => {
  await start(page);
  await panel(page).getByLabel('向 AI 提问').fill('把讨论画成白板。' + '请保留材料的来源和边界。'.repeat(70));
  await openBoardTools(page);
  await panel(page).getByRole('button', { name: '生成白板', exact: true }).click();
  await panel(page).getByRole('button', { name: '停止生成', exact: true }).click();
  await expect.poll(async () => Object.values((await data(page)).requests).at(-1)?.status).toBe('stopped');
  expect(Object.keys((await data(page)).boards)).toHaveLength(0);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as unknown as { boardTestAllowSave: boolean }).boardTestAllowSave = false;
    IDBObjectStore.prototype.put = function (...args) {
      const value = args[0];
      if (this.name === 'workspace' && !(window as unknown as { boardTestAllowSave: boolean }).boardTestAllowSave && Object.values(value?.boardChanges ?? {}).some(change => (change as { requestId?: string }).requestId)) throw new DOMException('chat board test quota', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await panel(page).getByLabel('向 AI 提问').fill('画一张研究步骤白板。');
  await openBoardTools(page);
  await panel(page).getByRole('button', { name: '生成白板', exact: true }).click();
  await expect(result(page).getByRole('alert')).toContainText('保存');
  const before = await data(page), changes = Object.values(before.boardChanges ?? {}).filter(change => change.requestId);
  expect(changes).toHaveLength(1);
  await page.evaluate(() => { (window as unknown as { boardTestAllowSave: boolean }).boardTestAllowSave = true; });
  await result(page).getByRole('button', { name: '重试保存白板', exact: true }).click();
  await expect(result(page).getByRole('alert')).toHaveCount(0);
  await created(page);
  expect(Object.keys((await data(page)).boards)).toEqual(Object.keys(before.boards));
  expect(Object.values((await data(page)).boardChanges ?? {}).filter(change => change.requestId)).toEqual(changes);
});
