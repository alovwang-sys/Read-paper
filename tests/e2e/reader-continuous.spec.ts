import { expect, test, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { createSeed } from '../../src/data/seed';
import { switchResearch } from './knowledge-helpers';
import { dragView, expectPageTop, goTo, groups, layout, pane, paneAction, paneById, panes, panel, saved, split, start, state } from './workspace-split-helpers';

async function viewportPosition(target: Locator) {
  return target.locator('.pdf-scroll').evaluate(node => {
    const scroll = node.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(node).paddingTop);
    const sheets = [...node.querySelectorAll<HTMLElement>('.pdf-sheet')];
    const sheet = sheets.find(sheet => sheet.getBoundingClientRect().bottom > scroll.top + padding + 1)!;
    const box = sheet.getBoundingClientRect();
    return { pageIndex: Number(sheet.dataset.pageIndex), offset: (scroll.top + padding - box.top) / box.height };
  });
}

test('滚动连续跨页后立即分窗保持页内位置，第二页摘录仍保存正确页索引与引用', async ({ page }) => {
  await start(page);
  const firstId = (await pane(page, 1).getAttribute('data-pane-id'))!;
  const first = paneById(page, firstId), scroller = first.locator('.pdf-scroll');
  const top = await scroller.evaluate(node => node.scrollTop);
  const pageStep = await first.locator('.pdf-sheet[data-page-index="0"]').evaluate(sheet => sheet.getBoundingClientRect().height + 24);
  await scroller.hover(); await page.mouse.wheel(0, pageStep + 10);
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(top + pageStep);
  await expect(first.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await scroller.evaluate(async node => {
    node.scrollTop += 90;
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  });
  const before = await viewportPosition(first);
  expect(before.pageIndex).toBe(1);
  const second = await split(page, first, '右');
  for (const target of [first, second]) {
    await expect(target.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
    await expect.poll(async () => Math.abs((await viewportPosition(target)).offset - before.offset)).toBeLessThanOrEqual(.02);
  }
  const secondPage = first.locator('.pdf-sheet[data-page-index="1"]');
  const span = secondPage.locator('.pdf-text-layer span').filter({ hasText: 'The fixed baseline always selects' }).first();
  await span.scrollIntoViewIfNeeded();
  const quote = await span.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return node.textContent!.replace(/\s+/g, ' ').trim();
  });
  await expect(page.getByLabel('原文选区操作')).toBeVisible();
  await page.getByLabel('原文选区操作').getByLabel('更多操作', { exact: true }).click();
  await page.getByLabel('原文选区操作').getByRole('button', { name: '摘录', exact: true }).click();
  await expect.poll(async () => Object.values((await state(page)).evidence).filter(item => item.quote === quote && item.researchId === 'research-a').map(item => item.pageIndex)).toEqual([1]);
  await expect(secondPage.locator('.pdf-excerpt-highlight')).not.toHaveCount(0);
});

test('同篇独立翻页缩放，合并保留两个视图，重新拆分及刷新研究切换均恢复位置', async ({ page }) => {
  await start(page);
  const firstId = (await pane(page, 1).getAttribute('data-pane-id'))!;
  const first = paneById(page, firstId);
  const second = await split(page, first, '右');
  await goTo(first, 2); await goTo(second, 3);
  await second.getByRole('button', { name: '放大 PDF', exact: true }).click();
  await expect(second.locator('.pdf-zoom')).toContainText('125%');
  await expect(first.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(first.locator('.pdf-zoom')).toContainText('100%');
  await expect.poll(async () => groups((await layout(page)).root).flatMap(group => group.tabs).filter(tab => tab.ref.id === 'paper-a').map(tab => tab.reading)).toMatchObject([{ pageIndex: 1, scale: 1 }, { pageIndex: 2, scale: 1.25 }]);
  const originals = groups((await layout(page)).root).flatMap(group => group.tabs).filter(tab => tab.ref.id === 'paper-a');
  await paneAction(page, second, '收拢所有标签');
  await expect(panes(page)).toHaveCount(1);
  const merged = pane(page, 1);
  for (const view of originals) {
    await merged.getByRole('tab').and(merged.locator(`[data-tab-id="${view.id}"]`)).click();
    await expect(merged.getByLabel('PDF 页码', { exact: true })).toHaveValue(String(view.reading!.pageIndex + 1));
    await expect(merged.locator('.pdf-zoom')).toContainText(`${view.reading!.scale * 100}%`);
  }
  expect(groups((await layout(page)).root).flatMap(group => group.tabs).filter(tab => tab.ref.id === 'paper-a').map(tab => tab.id).sort()).toEqual(originals.map(tab => tab.id).sort());
  // Own-edge drag now preserves its source even when the group has multiple tabs.
  await merged.getByRole('tab').and(merged.locator(`[data-tab-id="${originals[0].id}"]`)).click();
  await dragView(page, originals[1].id, merged, 'right');
  await expect(panes(page)).toHaveCount(2);
  await expect(pane(page, 1).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(pane(page, 2).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expectPageTop(pane(page, 1), 2); await expectPageTop(pane(page, 2), 3);
  const duplicated = groups((await layout(page)).root).flatMap(group => group.tabs).filter(tab => tab.ref.id === 'paper-a');
  expect(duplicated).toHaveLength(3);
  expect(duplicated.map(tab => tab.id)).toContain(originals[1].id);
  expect(new Set(duplicated.map(tab => tab.id)).size).toBe(3);
  await saved(page); await page.reload();
  await expect(pane(page, 1).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(pane(page, 2).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(pane(page, 2).locator('.pdf-zoom')).toContainText('125%');
  await switchResearch(page, 'research-b'); await switchResearch(page, 'research-a');
  await expect(pane(page, 1).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(pane(page, 2).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(panel(page).getByLabel('向 AI 提问')).toBeVisible();
});

test('长文连续阅读只保留附近页面画布，快速切研究保留页内位置', async ({ page }) => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 60; i++) pdf.addPage([612, 792]).drawText(`Continuous reading page ${i + 1}`, { x: 45, y: 720, size: 15 });
  const bytes = Buffer.from(await pdf.save());
  const seed = createSeed();
  Object.assign(seed.documents['paper-a'], { sampleUrl: '/samples/long-reader.pdf', filename: 'long-reader.pdf', assetId: 'long-reader-fixture', pageCount: 60 });
  await page.route('**/samples/long-reader.pdf', route => route.fulfill({ contentType: 'application/pdf', body: bytes }));
  await start(page, seed);
  expect(await pane(page, 1).locator('canvas').count()).toBeLessThanOrEqual(6);
  await goTo(pane(page, 1), 40);
  expect(await pane(page, 1).locator('canvas').count()).toBeLessThanOrEqual(6);
  await expect(pane(page, 1).locator('.pdf-sheet[data-page-index="0"] canvas')).toHaveCount(0);
  const viewId = groups((await layout(page)).root)[0].activeTabId!;
  await pane(page, 1).locator('.pdf-scroll').evaluate(node => { node.scrollTop += 140; });
  await expect.poll(async () => groups((await layout(page)).root)[0].tabs.find(tab => tab.id === viewId)!.reading?.offset ?? 0).toBeGreaterThan(.1);
  const before = groups((await layout(page)).root)[0].tabs.find(tab => tab.id === viewId)!.reading!;
  await switchResearch(page, 'research-b'); await switchResearch(page, 'research-a');
  await expect.poll(() => pane(page, 1).locator('.pdf-scroll').evaluate(node => node.scrollTop)).toBeGreaterThan(10000);
  await expect(pane(page, 1).getByLabel('PDF 页码', { exact: true })).toHaveValue('40');
  const after = groups((await layout(page)).root)[0].tabs.find(tab => tab.id === viewId)!.reading!;
  expect(after.pageIndex).toBe(39);
  expect(after.offset).toBeCloseTo(before.offset!, 2);
});

for (const width of [1440, 1280, 1024]) test(`连续双窗与右侧AI ${width}px 保持布局和独立页码`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
  await start(page);
  const firstId = (await pane(page, 1).getAttribute('data-pane-id'))!;
  const first = paneById(page, firstId), second = await split(page, first, '右');
  await goTo(second, 3);
  await expect(first.locator('.pdf-page-loading')).toHaveCount(0);
  const firstBox = (await first.boundingBox())!, secondBox = (await second.boundingBox())!;
  expect(secondBox.x).toBeGreaterThan(firstBox.x + firstBox.width - 3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await expect(panel(page).getByLabel('向 AI 提问')).toBeVisible();
  await expect(first.getByLabel('PDF 页码', { exact: true })).toHaveValue('1');
  await expect(second.getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await saved(page); await page.evaluate(() => document.fonts.ready);
  await mkdir('docs/verification/pane-navigation', { recursive: true });
  await page.screenshot({ path: `docs/verification/pane-navigation/continuous-${width}.png` });
});
