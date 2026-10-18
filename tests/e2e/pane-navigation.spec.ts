import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { SourceCandidate } from '../../src/domain/types';
import { mockProjectService } from './project-fixture';
import { openResearchPage, switchResearch } from './knowledge-helpers';
import { dragView, goTo, groups, layout, main, pane, paneAction, paneById, panes, panel, saved, split, state, waitForPdf } from './workspace-split-helpers';

const paperA = 'Adaptive Retrieval: Evidence & Reliability';
const paperB = 'Retrieval Baselines & Trade-offs';
const cardTitle = '相关性是检索收益的前提';
const output = 'docs/verification/pane-navigation';

async function boot(page: Page, seed = createSeed()) {
  seed.panelWidth = 340;
  seed.sessions['research-a'].panel.mode = 'ai';
  for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'demo';
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: true, model: 'navigation-fixture', mode: 'demo', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/chat', () => { throw new Error('Navigation acceptance must not contact a model'); });
  await page.goto('/');
  await expect(main(page)).toBeVisible();
  await expect(panes(page)).toHaveCount(1);
  await saved(page);
}

async function openPaper(target: Locator, title = paperA) {
  await target.getByRole('button', { name: title, exact: true }).click();
  await waitForPdf(target);
}

async function chooseTab(target: Locator, name: string) {
  await target.getByRole('tab', { name, exact: true }).click();
}

async function tabById(page: Page, id: string) { return main(page).getByRole('tab').and(main(page).locator(`[data-tab-id="${id}"]`)); }

test('主页、列表、PDF和卡片共用窗格；导航只改变目标并在三尺寸可操作', async ({ page }) => {
  await boot(page);
  const leftId = (await pane(page, 1).getAttribute('data-pane-id'))!;
  const left = paneById(page, leftId);
  const right = await split(page, left, '右');
  const rightId = (await right.getAttribute('data-pane-id'))!;
  await expect(right.getByLabel('核心研究问题')).toBeVisible();
  await openResearchPage(page, '资料');
  await openPaper(right);
  await goTo(right, 2);
  const bottom = await split(page, right, '下');
  const bottomId = (await bottom.getAttribute('data-pane-id'))!;
  await openResearchPage(page, '卡片');
  await bottom.getByRole('button', { name: cardTitle, exact: true }).click();
  await expect(bottom.getByLabel('卡片标题')).toHaveValue(cardTitle);
  await bottom.getByLabel('卡片正文').fill('这段研究笔记应在切换列表、研究与刷新之后保留。');
  await panel(page).getByLabel('向 AI 提问').fill('继续核对语料相关性的未发送问题');
  await left.getByRole('tab', { name: '研究主页', exact: true }).click();
  await openResearchPage(page, '资料');
  await left.getByLabel('搜索研究资料').fill('Retrieval');
  await expect(right.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(bottom.getByLabel('卡片正文')).toHaveValue('这段研究笔记应在切换列表、研究与刷新之后保留。');
  const beforeOther = groups((await layout(page)).root).filter(group => group.id !== leftId).map(group => ({ id: group.id, tab: group.activeTabId }));
  await openPaper(left, paperB);
  await expect(left.getByRole('tab', { name: '资料', exact: true })).toBeVisible();
  await expect(right.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await chooseTab(left, '资料');
  await expect(left.getByLabel('搜索研究资料')).toHaveValue('Retrieval');
  expect(groups((await layout(page)).root).filter(group => group.id !== leftId).map(group => ({ id: group.id, tab: group.activeTabId }))).toEqual(beforeOther);
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(left.getByRole('heading', { name: '资料', exact: true })).toBeVisible();
    await expect(right.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
    await expect(bottom.getByLabel('卡片正文')).toHaveValue('这段研究笔记应在切换列表、研究与刷新之后保留。');
    await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('继续核对语料相关性的未发送问题');
    await saved(page); await mkdir(output, { recursive: true });
    await page.screenshot({ path: `${output}/list-paper-card-${width}.png` });
    await right.getByRole('button', { name: /^放大窗格 \d+$/ }).click();
    await expect.poll(async () => (await layout(page)).zoomedPaneId).toBe(rightId);
    await expect(left).toBeHidden(); await expect(bottom).toBeHidden();
    await expect(right.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
    await page.screenshot({ path: `${output}/focused-reading-${width}.png` });
    await right.getByRole('button', { name: /^还原窗格 \d+$/ }).click();
    await expect.poll(async () => (await layout(page)).zoomedPaneId).toBeUndefined();
    await expect(left).toBeVisible(); await expect(bottom).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await saved(page); await page.reload();
  await expect(panes(page)).toHaveCount(3);
  await expect(left.getByLabel('搜索研究资料')).toHaveValue('Retrieval');
  await expect(right.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(bottom.getByLabel('卡片正文')).toHaveValue('这段研究笔记应在切换列表、研究与刷新之后保留。');
  await switchResearch(page, 'research-b'); await expect(panes(page)).toHaveCount(1);
  await switchResearch(page, 'research-a'); await expect(panes(page)).toHaveCount(3);
  expect(groups((await layout(page)).root).map(group => group.id)).toEqual([leftId, rightId, bottomId]);
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('继续核对语料相关性的未发送问题');
});

test('卡片、白板、文稿和无全文资料从列表可直接在新分屏打开', async ({ page }) => {
  await boot(page);
  const sourceId = (await pane(page, 1).getAttribute('data-pane-id'))!;
  const source = paneById(page, sourceId);
  for (const [navigation, title, assertion] of [
    ['卡片', cardTitle, '卡片标题'],
    ['白板', '证据与论证', '白板标题'],
    ['文稿', '检索增强的适用条件', '结论标题'],
    ['资料', 'Attention Is All You Need', '资料标题'],
  ] as const) {
    await source.getByRole('tab').first().click();
    await openResearchPage(page, navigation);
    await expect(source.getByRole('heading', { name: navigation, exact: true })).toBeVisible();
    const count = groups((await layout(page)).root).length;
    await source.getByRole('button', { name: `${title} 的更多操作`, exact: true }).click();
    await page.getByRole('menu', { name: '打开位置', exact: true }).getByRole('menuitem', { name: '在新分屏打开', exact: true }).click();
    await expect(panes(page)).toHaveCount(count + 1);
    const opened = paneById(page, (await layout(page)).focusedPaneId);
    if (assertion === '白板标题') await expect(opened.getByRole('button', { name: '平移白板', exact: true })).toBeVisible();
    else await expect(opened.getByLabel(assertion, { exact: true })).toHaveValue(title);
    await expect(source.getByRole('heading', { name: navigation, exact: true })).toBeVisible();
    await paneAction(page, source, '收拢所有标签');
    await expect(panes(page)).toHaveCount(1);
  }
});

test('同篇PDF已有两处阅读位置时，定位引用新开视图并可返回', async ({ page }) => {
  await boot(page); await openResearchPage(page, '资料'); await openPaper(pane(page, 1));
  const leftId = (await pane(page, 1).getAttribute('data-pane-id'))!, left = paneById(page, leftId);
  const original = groups((await layout(page)).root)[0].tabs.find(tab => tab.ref.kind === 'document')!;
  await goTo(left, 1); await left.getByRole('button', { name: '放大 PDF', exact: true }).click();
  const right = await split(page, left, '右'); await goTo(right, 2);
  await right.getByRole('button', { name: '放大 PDF', exact: true }).click();
  await (await tabById(page, original.id)).click();
  await openResearchPage(page, '摘录');
  await left.locator('[data-evidence-id="evidence-a"]').getByRole('button', { name: '定位原文', exact: true }).click();
  await expect(left.getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  const leftDocuments = groups((await layout(page)).root).find(group => group.id === leftId)!.tabs.filter(tab => tab.ref.kind === 'document');
  expect(leftDocuments).toHaveLength(2); expect(leftDocuments.find(tab => tab.id === original.id)?.reading).toMatchObject({ pageIndex: 0, scale: 1.25 });
  await expect(right.getByLabel('PDF 页码', { exact: true })).toHaveValue('2'); await expect(right.locator('.pdf-zoom')).toContainText('150%');
  await page.getByRole('button', { name: '主区返回', exact: true }).click();
  await expect(left.getByRole('heading', { name: '摘录', exact: true })).toBeVisible();
  await (await tabById(page, original.id)).click();
  await expect(left.getByLabel('PDF 页码', { exact: true })).toHaveValue('1'); await expect(left.locator('.pdf-zoom')).toContainText('125%');
  await saved(page); await page.reload();
  await expect(left.getByLabel('PDF 页码', { exact: true })).toHaveValue('1'); await expect(right.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
});

test('未收录来源预览可分屏、刷新恢复；收录前不创建资料', async ({ page }) => {
  const seed = createSeed();
  const candidate: SourceCandidate = { kind: 'paper', title: '尚未收录的来源线索', authors: 'Example Research Group', year: '2026', url: 'https://example.org/uncollected', identifiers: { url: 'https://example.org/uncollected' }, abstract: { text: '作者提供的摘要，保留原网页来源。', url: 'https://example.org/uncollected', retrievedAt: '2026-10-18T08:00:00Z' } };
  seed.sessions['research-a'].sourcePreview = { candidate };
  await page.route('**/api/sources/resolve', route => route.fulfill({ json: candidate }));
  await boot(page, seed);
  const first = pane(page, 1); await expect(first.getByRole('heading', { name: candidate.title, exact: true })).toBeVisible();
  const before = await state(page);
  const second = await split(page, first, '右');
  await expect(second.getByRole('heading', { name: candidate.title, exact: true })).toBeVisible();
  await expect(second.getByRole('button', { name: '加入本研究', exact: true })).toBeEnabled();
  expect((await state(page)).documents).toEqual(before.documents);
  expect((await state(page)).researches['research-a'].documentIds).toEqual(before.researches['research-a'].documentIds);
  await saved(page); await page.reload();
  await expect(panes(page)).toHaveCount(2);
  for (const target of [pane(page, 1), pane(page, 2)]) await expect(target.getByRole('heading', { name: candidate.title, exact: true })).toBeVisible();
  expect((await state(page)).documents).toEqual(before.documents);
  await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/uncollected-preview.png` });
});

test('关闭和收拢可撤销，阅读进度继续保留，空窗格仍能打开资料和分屏', async ({ page }) => {
  await boot(page); await openResearchPage(page, '资料'); await openPaper(pane(page, 1));
  const firstId = (await pane(page, 1).getAttribute('data-pane-id'))!, first = paneById(page, firstId);
  const second = await split(page, first, '右'), secondId = (await second.getAttribute('data-pane-id'))!;
  await goTo(second, 2);
  await paneAction(page, second, '关闭窗格');
  await expect(panes(page)).toHaveCount(1);
  await goTo(first, 3);
  await main(page).getByRole('button', { name: '撤销', exact: true }).click();
  await expect(panes(page)).toHaveCount(2);
  await expect(first.getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(paneById(page, secondId).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  const ids = groups((await layout(page)).root).flatMap(group => group.tabs.map(tab => tab.id)).sort();
  await paneAction(page, first, '收拢所有标签');
  await expect(panes(page)).toHaveCount(1);
  expect(groups((await layout(page)).root).flatMap(group => group.tabs.map(tab => tab.id)).sort()).toEqual(ids);
  await main(page).getByRole('button', { name: '撤销', exact: true }).click();
  await expect(panes(page)).toHaveCount(2);
  await paneAction(page, second, '关闭窗格');
  await openResearchPage(page, '摘录');
  await expect(main(page).getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);
  await paneAction(page, first, '关闭窗格');
  await expect(panes(page)).toHaveCount(1);
  await expect(first.getByRole('button', { name: '打开资料', exact: true })).toBeVisible();
  const emptyCopy = await split(page, first, '右');
  await expect(emptyCopy.getByRole('button', { name: '打开资料', exact: true })).toBeVisible();
  await emptyCopy.getByRole('button', { name: '打开资料', exact: true }).click();
  await expect(emptyCopy.getByRole('heading', { name: '资料', exact: true })).toBeVisible();
  const data = await state(page);
  expect(Object.keys(data.documents)).toHaveLength(4);
  expect(data.researches['research-a'].documentIds).toEqual(createSeed().researches['research-a'].documentIds);
  await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/empty-pane-and-list.png` });
});

test('真实拖动自身边缘：一个或多个标签均保留来源并另开，不需要Option', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.addEventListener('drop', event => {
    const drag = event as DragEvent;
    const recorder = window as unknown as { paneDrops?: { trusted: boolean; alt: boolean }[] };
    (recorder.paneDrops ??= []).push({ trusted: drag.isTrusted, alt: drag.altKey });
  }, true));
  const initial = groups((await layout(page)).root)[0], first = paneById(page, initial.id);
  expect(initial.tabs).toHaveLength(1);
  await dragView(page, initial.tabs[0].id, first, 'right', false, async () => {
    await expect(first.locator('.pane-drop-preview')).toHaveAttribute('data-drop-mode', 'copy');
    await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/home-native-drag-copy-preview.png` });
  }, '保留原标签');
  await expect(panes(page)).toHaveCount(2);
  expect(groups((await layout(page)).root)[0].tabs[0].id).toBe(initial.tabs[0].id);
  await chooseTab(first, '研究主页'); await openResearchPage(page, '资料'); await openPaper(first); await goTo(first, 2);
  const before = groups((await layout(page)).root).find(group => group.id === initial.id)!;
  expect(before.tabs.length).toBeGreaterThan(1);
  const reading = before.tabs.find(tab => tab.ref.kind === 'document')!;
  await dragView(page, reading.id, first, 'down', false, async () => {
    await expect(first.locator('.pane-drop-preview')).toHaveAttribute('data-drop-mode', 'copy');
    await page.screenshot({ path: `${output}/multi-tab-native-copy-preview.png` });
  }, '保留原标签');
  await expect(panes(page)).toHaveCount(3);
  const after = groups((await layout(page)).root);
  expect(after.find(group => group.id === initial.id)?.tabs.map(tab => tab.id)).toEqual(before.tabs.map(tab => tab.id));
  const copies = after.flatMap(group => group.tabs).filter(tab => tab.ref.kind === 'document');
  expect(copies).toHaveLength(2); expect(new Set(copies.map(tab => tab.id)).size).toBe(2);
  expect(copies.every(tab => tab.reading?.pageIndex === 1)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { paneDrops: unknown }).paneDrops)).toEqual([{ trusted: true, alt: false }, { trusted: true, alt: false }]);
});

test('真实拖动资料行到新窗格，列表仍留原位且资料没有复制或额外关联', async ({ page }) => {
  await boot(page); await openResearchPage(page, '资料');
  const firstId = (await pane(page, 1).getAttribute('data-pane-id'))!, first = paneById(page, firstId);
  const second = await split(page, first, '右');
  const before = await state(page);
  const row = first.locator('article').filter({ has: page.getByRole('button', { name: paperA, exact: true }) });
  await row.scrollIntoViewIfNeeded();
  const start = (await row.boundingBox())!, destination = (await second.locator('[data-pane-content]').boundingBox())!;
  await page.evaluate(() => window.addEventListener('drop', event => {
    const drag = event as DragEvent;
    (window as unknown as { resourceDrop: { trusted: boolean; alt: boolean } }).resourceDrop = { trusted: drag.isTrusted, alt: drag.altKey };
  }, true));
  const from = { x: start.x + 22, y: start.y + Math.min(35, start.height / 2) };
  const to = { x: destination.x + destination.width / 2, y: destination.y + destination.height - 8 };
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  try {
    await page.mouse.move(from.x + 12, from.y, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 16 }); await page.mouse.move(to.x, to.y);
    const preview = second.locator('.pane-drop-preview[data-drop-side="down"]');
    await expect(preview).toBeVisible(); await expect(preview).toContainText('在下方');
    await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/source-row-native-drag-preview.png` });
    await page.mouse.up();
  } finally { await page.mouse.up(); }
  await expect(panes(page)).toHaveCount(3);
  await expect(first.getByRole('heading', { name: '资料', exact: true })).toBeVisible();
  await expect(second.getByRole('heading', { name: '资料', exact: true })).toBeVisible();
  const third = paneById(page, (await layout(page)).focusedPaneId); await waitForPdf(third);
  await expect(third.getByLabel('PDF 页码', { exact: true })).toHaveValue('1');
  const after = await state(page);
  expect(Object.keys(after.documents)).toEqual(Object.keys(before.documents));
  expect(after.researches['research-a'].documentIds).toEqual(before.researches['research-a'].documentIds);
  expect(await page.evaluate(() => (window as unknown as { resourceDrop: unknown }).resourceDrop)).toEqual({ trusted: true, alt: false });
});
