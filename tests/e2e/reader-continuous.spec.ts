import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { createSeed } from '../../src/data/seed';
import type { WorkspaceData } from '../../src/domain/types';
import { mockProjectService } from './project-fixture';
import { openSource, switchResearch } from './knowledge-helpers';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const primary = (page: Page) => main(page).getByRole('region', { name: 'PDF 阅读器 主区', exact: true });
const secondary = (page: Page) => main(page).getByRole('region', { name: 'PDF 阅读器 对照位置', exact: true });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');

async function state(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const journal = localStorage.getItem('papertrail-recovery-v3');
    if (journal) return JSON.parse(journal);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { return await new Promise<WorkspaceData>((resolve, reject) => {
      const request = db.transaction('workspace').objectStore('workspace').get('current');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  });
}

async function start(page: Page, seed = createSeed()) {
  seed.panelWidth = 340;
  seed.sessions['research-a'].panel.mode = 'ai';
  for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'demo';
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: true, model: 'reader-fixture', mode: 'demo', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/chat', () => { throw new Error('Reader tests must not call a real model'); });
  await page.goto('/');
  await openSource(page, seed.documents['paper-a'].title);
  await expect(primary(page).locator('.pdf-text-layer').first()).not.toBeEmpty();
  await expect(primary(page).locator('.pdf-page-loading')).toHaveCount(0);
}

async function goTo(pane: Locator, page: number) {
  await pane.getByLabel('PDF 页码', { exact: true }).fill(String(page));
  await expect(pane.locator(`.pdf-sheet[data-page-index="${page - 1}"] canvas`)).toBeVisible();
  await expect(pane.locator('.pdf-page-loading')).toHaveCount(0);
  await expectPageTop(pane, page);
}

async function expectPageTop(pane: Locator, page: number) {
  await expect.poll(() => pane.locator(`.pdf-sheet[data-page-index="${page - 1}"]`).evaluate(sheet => {
    const scroll = sheet.closest('.pdf-scroll')!;
    return Math.abs(sheet.getBoundingClientRect().top - scroll.getBoundingClientRect().top - parseFloat(getComputedStyle(scroll).paddingTop));
  })).toBeLessThanOrEqual(2);
}

test('滚动连续跨页，第二页原文摘录仍保存正确页索引与引用', async ({ page }) => {
  await start(page);
  const pane = primary(page), scroller = pane.locator('.pdf-scroll');
  const top = await scroller.evaluate(node => node.scrollTop);
  await scroller.hover(); await page.mouse.wheel(0, 1000);
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(top + 300);
  await expect(pane.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  const beforeSplit = await scroller.evaluate(async node => {
    node.scrollTop += 90;
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    return node.scrollTop;
  });
  await main(page).getByRole('button', { name: '分屏阅读', exact: true }).click();
  await expect(pane.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect.poll(() => scroller.evaluate((node, savedTop) => Math.abs(node.scrollTop - savedTop), beforeSplit)).toBeLessThanOrEqual(2);
  await expect(secondary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  const second = pane.locator('.pdf-sheet[data-page-index="1"]');
  const span = second.locator('.pdf-text-layer span').filter({ hasText: 'The fixed baseline always selects' }).first();
  await span.scrollIntoViewIfNeeded();
  const quote = await span.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return node.textContent!.replace(/\s+/g, ' ').trim();
  });
  await expect(second.getByLabel('原文选区操作')).toBeVisible();
  await second.getByRole('button', { name: '摘录', exact: true }).click();
  await expect.poll(async () => Object.values((await state(page)).evidence).filter(item => item.quote === quote && item.researchId === 'research-a').map(item => item.pageIndex)).toEqual([1]);
  await expect(second.locator('.pdf-excerpt-highlight')).not.toHaveCount(0);
});

test('同篇内部双窗独立翻页缩放，关闭重开、刷新与研究切换恢复两个位置', async ({ page }) => {
  await start(page);
  await main(page).getByRole('button', { name: '分屏阅读', exact: true }).click();
  await goTo(primary(page), 2); await goTo(secondary(page), 3);
  await secondary(page).getByRole('button', { name: '放大 PDF', exact: true }).click();
  await expect(secondary(page).locator('.pdf-zoom')).toContainText('125%');
  await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(primary(page).locator('.pdf-zoom')).toContainText('100%');
  await expect.poll(async () => (await state(page)).sessions['research-a'].readers['main-secondary:paper-a']).toMatchObject({ pageIndex: 2, scale: 1.25 });
  await main(page).getByRole('button', { name: '关闭阅读器分屏', exact: true }).click();
  await expect(secondary(page)).toHaveCount(0);
  await main(page).getByRole('button', { name: '分屏阅读', exact: true }).click();
  await expect(secondary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await main(page).getByLabel('阅读器分屏方向').selectOption('horizontal');
  await expectPageTop(primary(page), 2); await expectPageTop(secondary(page), 3);
  await main(page).getByLabel('阅读器分屏方向').selectOption('vertical');
  await expectPageTop(primary(page), 2); await expectPageTop(secondary(page), 3);
  await saved(page); await page.reload();
  await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(secondary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(secondary(page).locator('.pdf-zoom')).toContainText('125%');
  await switchResearch(page, 'research-b'); await switchResearch(page, 'research-a');
  await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(secondary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(page.getByRole('complementary', { name: '参考面板' }).getByLabel('向 AI 提问')).toBeVisible();
});

test('长文连续阅读只保留附近页面画布，快速切研究保留页内位置', async ({ page }) => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 60; i++) pdf.addPage([612, 792]).drawText(`Continuous reading page ${i + 1}`, { x: 45, y: 720, size: 15 });
  const bytes = Buffer.from(await pdf.save());
  const seed = createSeed();
  Object.assign(seed.documents['paper-a'], { sampleUrl: '/samples/long-reader.pdf', filename: 'long-reader.pdf', assetId: 'long-reader-fixture', pageCount: 60 });
  await page.route('**/samples/long-reader.pdf', route => route.fulfill({ contentType: 'application/pdf', body: bytes }));
  await start(page, seed);
  expect(await primary(page).locator('canvas').count()).toBeLessThanOrEqual(6);
  await goTo(primary(page), 40);
  await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('40');
  expect(await primary(page).locator('canvas').count()).toBeLessThanOrEqual(6);
  await expect(primary(page).locator('.pdf-sheet[data-page-index="0"] canvas')).toHaveCount(0);
  const scroller = primary(page).locator('.pdf-scroll');
  await scroller.evaluate(node => { node.scrollTop += 140; });
  await expect.poll(async () => (await state(page)).sessions['research-a'].readers['main:paper-a'].offset ?? 0).toBeGreaterThan(.1);
  const before = (await state(page)).sessions['research-a'].readers['main:paper-a'];
  await switchResearch(page, 'research-b'); await switchResearch(page, 'research-a');
  await expect.poll(async () => primary(page).locator('.pdf-scroll').evaluate(node => node.scrollTop)).toBeGreaterThan(10000);
  await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('40');
  const after = (await state(page)).sessions['research-a'].readers['main:paper-a'];
  expect(after.offset).toBeCloseTo(before.offset!, 2);
});

for (const width of [1440, 1280, 1024]) test(`连续分屏与右侧 AI ${width}px 无横向溢出`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
  await start(page);
  await main(page).getByRole('button', { name: '分屏阅读', exact: true }).click();
  await main(page).getByLabel('阅读器分屏方向').selectOption('horizontal');
  await goTo(secondary(page), 3);
  await expect(primary(page).locator('.pdf-page-loading')).toHaveCount(0);
  const first = (await primary(page).boundingBox())!, second = (await secondary(page).boundingBox())!;
  const container = (await main(page).locator('.pdf-reader-layout').boundingBox())!;
  if (container.width <= 760) expect(second.y).toBeGreaterThan(first.y + first.height - 3);
  else expect(second.x).toBeGreaterThan(first.x + first.width - 3);
  for (const pane of [primary(page), secondary(page)]) expect((await pane.locator('.pdf-scroll').boundingBox())!.height).toBeGreaterThanOrEqual(245);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await expect(page.getByRole('complementary', { name: '参考面板' }).getByLabel('向 AI 提问')).toBeVisible();
  await saved(page); await page.evaluate(() => document.fonts.ready);
  await mkdir('docs/verification/reader-images', { recursive: true });
  await page.screenshot({ path: `docs/verification/reader-images/reader-split-${width}.png` });
});
