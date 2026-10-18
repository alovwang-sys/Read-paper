import { expect, test, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import { openResearchPage } from './knowledge-helpers';
import { groups, layout, pane, paneById, panes, saved, split, start, state } from './workspace-split-helpers';

const output = 'docs/verification/pane-navigation';
const cardTitle = '相关性是检索收益的前提';

async function selectText(editor: Locator, start: number, end: number, scrollTop = 0) {
  await editor.focus();
  await editor.evaluate((element, position) => {
    const input = element as HTMLTextAreaElement;
    input.setSelectionRange(position.start, position.end);
    input.scrollTop = position.scrollTop;
    input.dispatchEvent(new Event('select', { bubbles: true }));
  }, { start, end, scrollTop });
}

test('同一卡片正文共享，两个视图的光标和正文滚动独立并恢复', async ({ page }) => {
  await start(page); await openResearchPage(page, '卡片');
  const leftId = (await pane(page, 1).getAttribute('data-pane-id'))!;
  const left = paneById(page, leftId);
  await left.getByRole('button', { name: cardTitle, exact: true }).click();
  const body = `${Array.from({ length: 45 }, (_, index) => `第 ${index + 1} 行：共享正文，各处保留阅读位置。`).join('\n')}`;
  const leftBody = left.getByLabel('卡片正文', { exact: true });
  await leftBody.fill(body);
  await selectText(leftBody, 2, 8, 95);
  await expect.poll(async () => { const group = groups((await layout(page)).root)[0]; return group.tabs.find(tab => tab.id === group.activeTabId)?.viewState?.['card:card-a:body.selectionStart']; }).toBe(2);
  const right = await split(page, left, '右');
  const rightBody = right.getByLabel('卡片正文', { exact: true });
  await expect(rightBody).toHaveValue(body);
  await selectText(rightBody, 60, 70, 220);
  await saved(page);
  await rightBody.fill(`${body}\n补充这一句，另一视图同步显示。`);
  await selectText(rightBody, 60, 70, 220);
  await expect(leftBody).toHaveValue(`${body}\n补充这一句，另一视图同步显示。`);
  await expect.poll(() => leftBody.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(2);
  await expect.poll(() => rightBody.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(60);
  await saved(page); await page.reload();
  await expect(panes(page)).toHaveCount(2);
  await expect.poll(() => leftBody.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(2);
  await expect.poll(() => rightBody.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(60);
  await expect.poll(() => leftBody.evaluate(element => element.scrollTop)).toBeGreaterThan(50);
  await expect.poll(() => rightBody.evaluate(element => element.scrollTop)).toBeGreaterThan(150);
  const cards = (await state(page)).cards;
  expect(Object.values(cards).filter(card => card.title === cardTitle)).toHaveLength(1);
  await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/shared-card-independent-cursors.png` });
});

test('同一白板的平移缩放独立，刷新后恢复，不复制白板或节点', async ({ page }) => {
  await start(page); await openResearchPage(page, '白板');
  const left = pane(page, 1);
  await left.getByRole('button', { name: '证据与论证', exact: true }).click();
  const before = await state(page);
  const right = await split(page, left, '右');
  await right.getByRole('button', { name: '放大白板', exact: true }).click();
  await right.getByRole('button', { name: '放大白板', exact: true }).click();
  await left.locator('.board-viewport').evaluate(element => { element.scrollLeft = 120; element.scrollTop = 90; });
  await right.locator('.board-viewport').evaluate(element => { element.scrollLeft = 420; element.scrollTop = 260; });
  await expect(left.getByRole('button', { name: '重置白板缩放', exact: true })).toHaveText('100%');
  await expect(right.getByRole('button', { name: '重置白板缩放', exact: true })).toHaveText('120%');
  await expect.poll(async () => groups((await layout(page)).root).map(group => group.tabs.find(tab => tab.id === group.activeTabId)?.boardViewport)).toEqual([{ x: 120, y: 90, scale: 1 }, { x: 420, y: 260, scale: 1.2 }]);
  const markerIds = await page.locator('.board-edges marker').evaluateAll(elements => elements.map(element => element.id));
  expect(new Set(markerIds).size).toBe(markerIds.length);
  await saved(page); await page.reload();
  await expect(panes(page)).toHaveCount(2);
  await expect.poll(() => left.locator('.board-viewport').evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }))).toEqual({ x: 120, y: 90 });
  await expect.poll(() => right.locator('.board-viewport').evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }))).toEqual({ x: 420, y: 260 });
  expect((await state(page)).boards).toEqual(before.boards);
  expect((await state(page)).placements).toEqual(before.placements);
  await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/independent-board-viewports.png` });
});

test('两份资料列表的筛选独立，切换标签与刷新后仍保留', async ({ page }) => {
  await start(page); await openResearchPage(page, '资料');
  const leftId = (await pane(page, 1).getAttribute('data-pane-id'))!;
  const left = paneById(page, leftId);
  await left.getByLabel('搜索研究资料', { exact: true }).fill('Adaptive');
  const right = await split(page, left, '右');
  await right.getByLabel('搜索研究资料', { exact: true }).fill('Baselines');
  await expect(left.getByRole('button', { name: 'Adaptive Retrieval: Evidence & Reliability', exact: true })).toBeVisible();
  await expect(right.getByRole('button', { name: 'Retrieval Baselines & Trade-offs', exact: true })).toBeVisible();
  await right.getByRole('button', { name: 'Retrieval Baselines & Trade-offs', exact: true }).click();
  await right.getByRole('tab', { name: '资料', exact: true }).click();
  await expect(right.getByLabel('搜索研究资料', { exact: true })).toHaveValue('Baselines');
  await expect(left.getByLabel('搜索研究资料', { exact: true })).toHaveValue('Adaptive');
  await saved(page); await page.reload();
  await expect(left.getByLabel('搜索研究资料', { exact: true })).toHaveValue('Adaptive');
  await expect(right.getByLabel('搜索研究资料', { exact: true })).toHaveValue('Baselines');
});

test('同一文稿共享正文但光标、预览模式和内部滚动互不覆盖', async ({ page }) => {
  await start(page); await openResearchPage(page, '文稿');
  const left = pane(page, 1);
  await left.getByRole('button', { name: '检索增强的适用条件', exact: true }).click();
  const leftBody = left.getByLabel('结论正文', { exact: true });
  const body = Array.from({ length: 35 }, (_, index) => `研究段落 ${index + 1}：对照独立，正文共享。`).join('\n\n');
  await leftBody.fill(body); await selectText(leftBody, 3, 9, 80);
  await saved(page);
  const right = await split(page, left, '右');
  await expect(right.getByLabel('结论正文', { exact: true })).toHaveValue(body);
  await right.getByRole('button', { name: '预览引用', exact: true }).click();
  await expect(right.getByRole('region', { name: '文稿预览', exact: true })).toBeVisible();
  await expect(leftBody).toBeVisible();
  await left.locator('.writing-scroll').evaluate(element => { element.scrollTop = 160; });
  await right.locator('.writing-scroll').evaluate(element => { element.scrollTop = 320; });
  await saved(page); await page.reload();
  await expect(leftBody).toBeVisible();
  await expect(right.getByRole('button', { name: '编辑正文', exact: true })).toBeVisible();
  await expect.poll(() => leftBody.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(3);
  await expect.poll(() => left.locator('.writing-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  await expect.poll(() => right.locator('.writing-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(250);
});

test('窄窗格的资料行菜单支持键盘选方向，菜单不被列表裁剪', async ({ page }) => {
  await start(page); await openResearchPage(page, '资料');
  await page.setViewportSize({ width: 1280, height: 800 });
  const source = pane(page, 1);
  const right = await split(page, source, '右');
  const titleBounds = (await source.getByRole('button', { name: 'Adaptive Retrieval: Evidence & Reliability', exact: true }).boundingBox())!;
  expect(titleBounds.width).toBeGreaterThan(200); expect(titleBounds.height).toBeLessThan(70);
  await source.getByRole('button', { name: 'Adaptive Retrieval: Evidence & Reliability 的更多操作', exact: true }).click();
  const menu = page.getByRole('menu', { name: '打开位置', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '在新分屏打开', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '选择分屏方向', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu.getByRole('menuitem', { name: '向左分屏打开', exact: true })).toBeVisible();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: '向下分屏打开', exact: true })).toBeFocused();
  const bounds = (await menu.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
  await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/list-direction-menu-1280.png` });
  await page.keyboard.press('Enter');
  await expect(panes(page)).toHaveCount(3);
  await expect(source.getByRole('heading', { name: '资料', exact: true })).toBeVisible();
  await expect(right.getByRole('heading', { name: '资料', exact: true })).toBeVisible();
  const opened = paneById(page, (await layout(page)).focusedPaneId);
  await expect(opened.getByLabel('PDF 页码', { exact: true })).toBeVisible();
  await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/list-direction-keyboard-1280.png` });
});

test('从左栏进入资料后 A 快捷键可用，两份列表同时打开只响应一次', async ({ page }) => {
  await start(page); await openResearchPage(page, '资料');
  await page.evaluate(() => {
    const requests: string[] = [];
    Object.assign(window, { sourceShortcutRequests: requests });
    window.addEventListener('papertrail:add-source', event => requests.push((event as CustomEvent).detail.paneId));
  });
  const first = pane(page, 1), firstId = (await first.getAttribute('data-pane-id'))!;
  await expect(page.locator('.sidebar').getByRole('button', { name: '资料', exact: true })).toBeFocused();
  await page.keyboard.press('a');
  const dialog = page.getByRole('dialog', { name: '添加资料', exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { sourceShortcutRequests: string[] }).sourceShortcutRequests)).toEqual([firstId]);
  await dialog.getByRole('button', { name: '关闭添加资料', exact: true }).click();
  const second = await split(page, first, '右');
  const secondId = (await second.getAttribute('data-pane-id'))!;
  await openResearchPage(page, '资料');
  await page.keyboard.press('a'); await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { sourceShortcutRequests: string[] }).sourceShortcutRequests)).toEqual([firstId, secondId]);
  await expect(dialog).toHaveCount(1);
});

test('长摘录列表使用工作区滚动，切标签与刷新后恢复当前位置', async ({ page }) => {
  const seed = createSeed();
  for (let index = 0; index < 35; index++) {
    const id = `scroll-excerpt-${index}`;
    seed.evidence[id] = { id, documentId: 'paper-a', researchId: 'research-a', pageIndex: index % 3, quote: `摘录 ${index + 1}：需要在多篇资料之间持续保留查阅位置，并且可以回到原文核对。` };
  }
  await start(page, seed); await openResearchPage(page, '摘录');
  const target = pane(page, 1), body = target.locator('[data-pane-content]');
  await body.hover(); await page.mouse.wheel(0, 1000);
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(800);
  await expect.poll(async () => groups((await layout(page)).root)[0].tabs.find(tab => tab.ref.kind === 'researchView' && tab.ref.id === 'excerpts')?.viewState?.scrollTop).toBeGreaterThan(800);
  const pdfId = groups((await layout(page)).root)[0].tabs.find(tab => tab.ref.kind === 'document')!.id;
  await target.getByRole('tab').and(target.locator(`[data-tab-id="${pdfId}"]`)).click();
  await expect(target.getByLabel('PDF 页码', { exact: true })).toBeVisible();
  await target.getByRole('tab', { name: '摘录', exact: true }).click();
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(800);
  await saved(page); await page.reload();
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(800);
});

test('选区更新未到下一帧即关闭窗格，撤销恢复最新光标和正文滚动', async ({ page }) => {
  await start(page); await openResearchPage(page, '卡片');
  const target = pane(page, 1);
  await target.getByRole('button', { name: cardTitle, exact: true }).click();
  const editor = target.getByLabel('卡片正文', { exact: true });
  await editor.fill(Array.from({ length: 45 }, (_, index) => `第 ${index + 1} 行：关闭布局时保留当前查看位置。`).join('\n'));
  await selectText(editor, 2, 8, 40);
  await target.getByRole('button', { name: /^窗格 \d+ 操作$/ }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: '关闭窗格', exact: true })).toBeVisible();
  // Keep selection and close in the same browser task, before rAF can persist it.
  await target.evaluate(element => {
    const input = element.querySelector<HTMLTextAreaElement>('[aria-label="卡片正文"]')!;
    input.setSelectionRange(73, 88); input.scrollTop = 185;
    input.dispatchEvent(new Event('select', { bubbles: true }));
    [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === '关闭窗格')!.click();
  });
  await expect(target.getByLabel('卡片正文', { exact: true })).toHaveCount(0);
  await page.locator('.pane-layout-undo').getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect.poll(() => editor.evaluate(element => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd, scrollTop: element.scrollTop }))).toEqual({ start: 73, end: 88, scrollTop: 185 });
});
