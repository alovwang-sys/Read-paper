import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import { goTo, pane, saved, start, state } from './workspace-split-helpers';
import { openSource, switchResearch } from './knowledge-helpers';

async function fixture(page: Page, count = 6) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < count; i++) {
    const sheet = pdf.addPage([600, 500]);
    sheet.drawText(`PAGE ${i + 1} opening paragraph with original evidence`, { x: 45, y: 420, size: 15 });
    sheet.drawText(`PAGE ${i + 1} middle paragraph with unique facts`, { x: 45, y: 250, size: 15 });
    sheet.drawText(`PAGE ${i + 1} final paragraph continues on next page`, { x: 45, y: 80, size: 15 });
  }
  const bytes = Buffer.from(await pdf.save()), seed = createSeed();
  Object.assign(seed.documents['paper-a'], { sampleUrl: '/samples/cross-page.pdf', filename: 'cross-page.pdf', assetId: 'cross-page-fixture', pageCount: count });
  await page.route('**/samples/cross-page.pdf', route => route.fulfill({ contentType: 'application/pdf', body: bytes }));
  await start(page, seed);
  await expect(pane(page, 1).locator('.pdf-text-layer span').filter({ hasText: 'PAGE 1 opening' })).toBeVisible();
}

async function crossText(page: Page, reverse = false) {
  const target = pane(page, 1), scroller = target.locator('.pdf-scroll');
  await goTo(target, reverse ? 2 : 1);
  const startSpan = target.locator('.pdf-text-layer span').filter({ hasText: reverse ? 'PAGE 2 opening' : 'PAGE 1 final' });
  await startSpan.scrollIntoViewIfNeeded();
  const start = (await startSpan.boundingBox())!, bounds = (await scroller.boundingBox())!;
  await page.mouse.move(start.x + (reverse ? start.width - 2 : 2), start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + (reverse ? 30 : 270), reverse ? bounds.y + 4 : bounds.y + bounds.height - 4, { steps: 12 });
  const endpoint = target.locator('.pdf-text-layer span').filter({ hasText: reverse ? 'PAGE 1 final' : 'PAGE 2 opening' });
  await expect.poll(async () => {
    const box = await endpoint.boundingBox();
    return !!box && box.y >= bounds.y + 10 && box.y + box.height < bounds.y + bounds.height - 12;
  }).toBe(true);
  const end = (await endpoint.boundingBox())!;
  await page.mouse.move(end.x + (reverse ? 2 : end.width - 2), end.y + end.height / 2, { steps: 12 });
  await page.mouse.up();
  const menu = page.getByLabel('原文选区操作', { exact: true });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('PDF 第 1–2 页');
  return menu;
}

async function dragThroughThreePages(page: Page) {
  const target = pane(page, 1), bounds = (await target.locator('.pdf-scroll').boundingBox())!;
  const start = (await target.locator('.pdf-text-layer span').filter({ hasText: 'PAGE 1 final' }).boundingBox())!;
  await page.mouse.move(start.x + 2, start.y + start.height / 2); await page.mouse.down();
  await page.mouse.move(start.x + 250, bounds.y + bounds.height - 3, { steps: 10 });
  const endpoint = target.locator('.pdf-text-layer span').filter({ hasText: 'PAGE 3 opening' });
  await expect.poll(async () => { const box = await endpoint.boundingBox(); return !!box && box.y > bounds.y + 10 && box.y + box.height < bounds.y + bounds.height - 15; }, { timeout: 15000, intervals: [20] }).toBe(true);
  const end = (await endpoint.boundingBox())!;
  await page.mouse.move(end.x + end.width - 2, end.y + end.height / 2, { steps: 2 }); await page.mouse.up();
}

for (const reverse of [false, true]) test(`文字${reverse ? '反向' : '正向'}跨页拖选自动滚动，一次存卡并逐页回查、刷新和研究隔离`, async ({ page }) => {
  await fixture(page);
  const before = new Set(Object.keys((await state(page)).evidence));
  const menu = await crossText(page, reverse);
  await menu.getByLabel('更多操作').click();
  await menu.getByRole('button', { name: '写成卡片', exact: true }).click();
  await expect.poll(async () => Object.values((await state(page)).evidence).filter(item => !before.has(item.id)).length).toBe(2);
  const data = await state(page), fragments = Object.values(data.evidence).filter(item => !before.has(item.id)).sort((a, b) => a.pageIndex - b.pageIndex);
  expect(fragments.map(item => item.pageIndex)).toEqual([0, 1]);
  expect(fragments.every(item => item.researchId === 'research-a' && item.textAnchor && item.quote.includes(`PAGE ${item.pageIndex + 1}`))).toBe(true);
  expect(fragments[0].selectionGroupId).toBeTruthy();
  expect(fragments[1].selectionGroupId).toBe(fragments[0].selectionGroupId);
  expect(Object.values(data.cards).some(card => fragments.every(item => card.evidenceIds.includes(item.id)))).toBe(true);
  await saved(page); await page.reload();
  await expect(pane(page, 1).locator('.pdf-text-layer span').filter({ hasText: 'PAGE 2 opening' })).toBeVisible();
  const marker = pane(page, 1).locator(`.pdf-activity-marker[data-evidence-id="${fragments[1].id}"]`);
  await marker.click();
  await expect(page.getByLabel('原文选区操作')).toContainText('PDF 第 1–2 页');
  await page.getByLabel('逐页查看选区').getByRole('button', { name: '第 1 页', exact: true }).click();
  await expect(pane(page, 1).getByLabel('PDF 页码', { exact: true })).toHaveValue('1');
  await mkdir('docs/verification/cross-page-selection', { recursive: true });
  await page.screenshot({ path: `docs/verification/cross-page-selection/text-${reverse ? 'reverse' : 'forward'}-1440.png`, fullPage: true });
  await switchResearch(page, 'research-b');
  expect(Object.values((await state(page)).evidence).filter(item => item.researchId === 'research-b' && item.selectionGroupId === fragments[0].selectionGroupId)).toHaveLength(0);
  await openSource(page, data.documents['paper-a'].title);
  await expect(pane(page, 1).locator(`.pdf-activity-marker[data-evidence-id="${fragments[0].id}"]`)).toHaveCount(0);
  await switchResearch(page, 'research-a');
  const restored = await state(page);
  expect(fragments.every(item => !!restored.evidence[item.id])).toBe(true);
});

test('区域跨五页自动滚动裁图排除空隙，超4页提示仍可一次保存摘录', async ({ page }) => {
  await fixture(page);
  const target = pane(page, 1), scroller = target.locator('.pdf-scroll');
  await target.getByRole('button', { name: '区域框选', exact: true }).click();
  const sheet = target.locator('.pdf-sheet[data-page-index="0"]');
  const bounds = (await scroller.boundingBox())!, box = (await sheet.boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + 120); await page.mouse.down();
  await page.mouse.move(box.x + 350, bounds.y + bounds.height - 3, { steps: 12 });
  const finalSheet = target.locator('.pdf-sheet[data-page-index="4"]');
  await expect.poll(async () => { const end = (await finalSheet.boundingBox())!; return end.y > bounds.y + 20 && end.y < bounds.y + bounds.height - 80; }, { timeout: 15000, intervals: [20] }).toBe(true);
  await expect(sheet.locator('canvas')).toHaveCount(1);
  const end = (await finalSheet.boundingBox())!;
  await page.mouse.move(box.x + 350, end.y + 50, { steps: 2 }); await page.mouse.up();
  const menu = page.getByLabel('原文选区操作');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('PDF 第 1–5 页');
  await menu.getByRole('button', { name: '提问', exact: true }).click();
  await expect(target.getByRole('alert')).toContainText('单次最多发送 4 张图片');
  await expect(menu).toBeVisible();
  await menu.getByLabel('更多操作').click(); await menu.getByRole('button', { name: '摘录', exact: true }).click();
  await expect.poll(async () => Object.values((await state(page)).evidence).filter(item => item.selectionGroupId && item.kind === 'region').length).toBe(5);
  const regions = Object.values((await state(page)).evidence).filter(item => item.selectionGroupId && item.kind === 'region').sort((a, b) => a.pageIndex - b.pageIndex);
  expect(regions.map(item => item.pageIndex)).toEqual([0, 1, 2, 3, 4]);
  expect(new Set(regions.map(item => item.selectionGroupId)).size).toBe(1);
  expect(regions.slice(1, -1).every(item => item.region!.rect.y === 0 && item.region!.rect.height === 1)).toBe(true);
  const assetCount = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('papertrail', 1); request.onsuccess = () => resolve(request.result); });
    try { return await new Promise<number>(resolve => { const request = db.transaction('assets').objectStore('assets').count(); request.onsuccess = () => resolve(request.result); }); } finally { db.close(); }
  });
  const assetsBefore = await assetCount();
  await menu.getByRole('button', { name: '摘录', exact: true }).click(); await saved(page);
  expect(await assetCount()).toBe(assetsBefore);
  await saved(page); await page.reload();
  await goTo(pane(page, 1), 3);
  await pane(page, 1).locator('.pdf-sheet[data-page-index="2"] .pdf-region-activity-marker').last().click();
  await expect(page.getByLabel('原文选区操作')).toContainText('PDF 第 1–5 页');
  await page.getByLabel('原文选区操作').getByText('查看所选区域', { exact: true }).click();
  await expect(page.getByLabel('原文选区操作').locator('img')).toHaveCount(5);
  await mkdir('docs/verification/cross-page-selection', { recursive: true });
  await page.screenshot({ path: 'docs/verification/cross-page-selection/region-five-pages-1440.png', fullPage: true });
});

test('中间页文字延迟时保留跨页选区，加载后完整包含三页', async ({ page }) => {
  await page.route(/\/src\/features\/reader\/PdfPage\.tsx(?:\?.*)?$/, async route => {
    const response = await route.fetch(), source = await response.text();
    const needle = 'const content = await page.getTextContent();';
    expect(source).toContain(needle);
    await route.fulfill({ response, body: source.replace(needle, 'if (pageIndex === 1) await new Promise(resolve => { window.__releaseCrossMiddle = resolve; });\n' + needle) });
  });
  await fixture(page);
  await dragThroughThreePages(page);
  await expect(pane(page, 1).getByRole('status')).toContainText('正在等待所有选中页的文字');
  await expect(pane(page, 1).locator('.pdf-sheet[data-page-index="0"] canvas')).toHaveCount(1);
  await expect(page.getByLabel('原文选区操作')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __releaseCrossMiddle: () => void }).__releaseCrossMiddle());
  const menu = page.getByLabel('原文选区操作');
  await expect(menu).toBeVisible(); await expect(menu).toContainText('PDF 第 1–3 页');
  await menu.getByLabel('更多操作').click(); await menu.getByRole('button', { name: '摘录', exact: true }).click();
  const fragments = Object.values((await state(page)).evidence).filter(item => item.selectionGroupId && item.kind !== 'region');
  expect(fragments.map(item => item.pageIndex).sort()).toEqual([0, 1, 2]);
  expect(fragments.find(item => item.pageIndex === 1)?.quote).toContain('PAGE 2 middle paragraph');
});

for (const failure of ['empty', 'error']) test(`中间页文字${failure}明确提示并保留选择，不保存缺页摘录`, async ({ page }) => {
  await page.route(/\/src\/features\/reader\/PdfPage\.tsx(?:\?.*)?$/, async route => {
    const response = await route.fetch(), source = await response.text();
    const needle = 'const content = await page.getTextContent();';
    expect(source).toContain(needle);
    await route.fulfill({ response, body: source.replace(needle, failure === 'empty' ? 'const content = pageIndex === 1 ? { items: [] } : await page.getTextContent();' : 'if (pageIndex === 1 && !window.__recoverCrossMiddle) throw new Error("Text layer fixture failure");\n' + needle) });
  });
  await fixture(page);
  const before = Object.keys((await state(page)).evidence);
  await dragThroughThreePages(page);
  await expect(pane(page, 1).getByRole('alert').filter({ hasText: 'PDF 第 2 页没有可用文字或提取失败' })).toBeVisible();
  await expect(pane(page, 1).getByRole('button', { name: '重试文字提取并完成选区' })).toBeVisible();
  await expect(page.getByLabel('原文选区操作')).toHaveCount(0);
  expect(Object.keys((await state(page)).evidence)).toEqual(before);
  if (failure === 'error') {
    await page.evaluate(() => { (window as unknown as { __recoverCrossMiddle: boolean }).__recoverCrossMiddle = true; });
    await pane(page, 1).getByRole('button', { name: '重试文字提取并完成选区' }).click();
    await expect(page.getByLabel('原文选区操作')).toContainText('PDF 第 1–3 页');
    await expect(page.getByLabel('原文选区操作')).toContainText('第 2 页');
  } else {
    await pane(page, 1).getByRole('button', { name: '取消选区', exact: true }).click();
    await expect(pane(page, 1).getByRole('alert').filter({ hasText: '跨页选区' })).toHaveCount(0);
  }
});

test('已有标记跨页复制只含原文，Shift点击继续延伸同一选区', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await fixture(page);
  const target = pane(page, 1), before = new Set(Object.keys((await state(page)).evidence));
  const menu = await crossText(page);
  await menu.getByLabel('更多操作').click(); await menu.getByRole('button', { name: '摘录', exact: true }).click();
  const group = Object.values((await state(page)).evidence).filter(item => !before.has(item.id));
  await page.keyboard.press('Escape'); await goTo(target, 2); await goTo(target, 1);
  await crossText(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('PAGE 1 final'); expect(copied).toContain('PAGE 2 opening');
  expect(copied).not.toMatch(/(?:^|\n)1(?:\n|$)/);
  expect(copied).toBe(group.sort((a, b) => a.pageIndex - b.pageIndex).map(item => item.quote).join('\n\n'));
  await page.keyboard.press('Escape'); await goTo(target, 2); await goTo(target, 1);
  const first = target.locator('.pdf-text-layer span').filter({ hasText: 'PAGE 1 opening' });
  await first.evaluate(node => { const range = document.createRange(); range.setStart(node.firstChild!, 0); range.setEnd(node.firstChild!, 6); const selected = window.getSelection()!; selected.removeAllRanges(); selected.addRange(range); });
  await page.keyboard.down('Shift'); await target.locator('.pdf-text-layer span').filter({ hasText: 'PAGE 1 middle' }).click({ position: { x: 50, y: 6 } }); await page.keyboard.up('Shift');
  const extended = await page.evaluate(() => window.getSelection()?.toString());
  expect(extended).toContain('PAGE 1 opening'); expect(extended!.length).toBeGreaterThan(6);
});

test('区域反向跨页后保留两张独立截图，逐页回查并生成同一局部会话', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await fixture(page);
  const target = pane(page, 1), scroller = target.locator('.pdf-scroll');
  await goTo(target, 2);
  await target.getByRole('button', { name: '区域框选', exact: true }).click();
  const second = (await target.locator('.pdf-sheet[data-page-index="1"]').boundingBox())!, bounds = (await scroller.boundingBox())!;
  await page.mouse.move(second.x + 350, second.y + 110); await page.mouse.down();
  await page.mouse.move(second.x + 80, bounds.y + 3, { steps: 12 });
  const firstSheet = target.locator('.pdf-sheet[data-page-index="0"]');
  await expect.poll(async () => { const box = (await firstSheet.boundingBox())!; return box.y + box.height > bounds.y + 70; }, { intervals: [20] }).toBe(true);
  const first = (await firstSheet.boundingBox())!;
  await page.mouse.move(second.x + 80, first.y + first.height - 45, { steps: 2 }); await page.mouse.up();
  const menu = page.getByLabel('原文选区操作');
  await expect(menu).toBeVisible(); await expect(menu).toContainText('PDF 第 1–2 页');
  await menu.getByRole('button', { name: '提问', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '原文旁提问' });
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText('PDF 第 1–2 页');
  const conversation = Object.values((await state(page)).conversations).find(item => item.inlineSource?.evidenceIds?.length === 2)!;
  expect(conversation.contextIds).toEqual(conversation.inlineSource!.evidenceIds);
  const data = await state(page), regions = conversation.contextIds.map(id => data.evidence[id]);
  expect(regions.map(item => item.pageIndex)).toEqual([0, 1]);
  expect(regions.every(item => item.region?.assetId && item.region.hash)).toBe(true);
  await dialog.getByLabel('向原文旁助手提问').fill('请一起解释这两个区域');
  await dialog.getByRole('button', { name: '发送就地问题' }).click();
  await expect.poll(async () => (await state(page)).conversations[conversation.id].requestIds.length).toBeGreaterThan(0);
  await expect.poll(async () => {
    const current = await state(page), request = current.requests[current.conversations[conversation.id].requestIds.at(-1)!];
    return request?.status;
  }).toBe('done');
  const completed = await state(page), request = completed.requests[completed.conversations[conversation.id].requestIds.at(-1)!];
  expect(request.context.map(item => item.pageIndex)).toEqual([0, 1]);
  expect(request.context.every(item => item.kind === 'region' && item.region?.assetId)).toBe(true);
  await saved(page);
  await mkdir('docs/verification/cross-page-selection', { recursive: true });
  await page.screenshot({ path: 'docs/verification/cross-page-selection/region-reverse-1280.png', fullPage: true });
});

test('1024px文字跨页翻译提交两个原文片段并保持操作可达', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await fixture(page);
  const menu = await crossText(page);
  await menu.getByRole('button', { name: '翻译', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '原文旁翻译' });
  await expect(dialog).toBeVisible();
  await expect.poll(async () => Object.values((await state(page)).requests).find(item => item.readerOperation === 'translation')?.status).toBe('done');
  const request = Object.values((await state(page)).requests).find(item => item.readerOperation === 'translation')!;
  expect(request.context.map(item => item.pageIndex)).toEqual([0, 1]);
  expect(request.context.every(item => item.quote.includes(`PAGE ${item.pageIndex + 1}`))).toBe(true);
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(1024);
  await mkdir('docs/verification/cross-page-selection', { recursive: true });
  await page.screenshot({ path: 'docs/verification/cross-page-selection/text-translation-1024.png', fullPage: true });
});
