import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { WorkspaceLayout } from '../../src/domain/types';
import { openResearchPage, openSource, switchResearch } from './knowledge-helpers';
import { dragView, goTo, groups, layout, main, openCard, pane, paneAction, paneById, panes, panel, saved, split, start, state, waitForPdf } from './workspace-split-helpers';

const paperA = 'Adaptive Retrieval: Evidence & Reliability';
const paperB = 'Retrieval Baselines & Trade-offs';
const cardA = '相关性是检索收益的前提';
const draftA = '检索增强的适用条件';

function expectRestored(actual: WorkspaceLayout, expected: WorkspaceLayout) {
  const comparable = structuredClone(actual);
  const expectedTabs = groups(expected.root).flatMap(group => group.tabs);
  for (const tab of groups(comparable.root).flatMap(group => group.tabs)) {
    const beforeTab = expectedTabs.find(item => item.id === tab.id);
    // Leaving a mounted editor flushes previously untouched controls at their defaults.
    // Keep every saved value exact; only newly materialized zero/none defaults may be omitted.
    for (const [key, value] of Object.entries(tab.viewState ?? {})) {
      if (key in (beforeTab?.viewState ?? {})) continue;
      expect(value === 0 || value === 'none', `unexpected new view state ${key}`).toBe(true);
      delete tab.viewState![key];
    }
    if (!Object.keys(tab.viewState ?? {}).length && !beforeTab?.viewState) delete tab.viewState;
    const before = beforeTab?.reading;
    if (!tab.reading || !before) continue;
    // Scroll geometry rounds to pixels; page indexes, scale and the entire tree stay exact.
    expect(Math.abs((tab.reading.offset ?? 0) - (before.offset ?? 0))).toBeLessThanOrEqual(.002);
    if (before.offset === undefined) delete tab.reading.offset;
    else tab.reading.offset = before.offset;
  }
  expect(comparable).toEqual(expected);
}

test('仅一个论文标签无Alt拖向自身右边缘复制同篇，保留页内位置且两窗独立恢复', async ({ page }) => {
  const seed = createSeed();
  seed.documents['paper-a'].hash = createHash('sha256').update(await readFile('public/samples/adaptive-retrieval.pdf')).digest('hex');
  await start(page, seed);
  const initial = groups((await layout(page)).root);
  expect(initial).toHaveLength(1);
  expect(initial[0].tabs).toHaveLength(1);
  const first = paneById(page, initial[0].id), originalView = initial[0].tabs[0];
  expect(originalView.ref).toEqual({ kind: 'document', id: 'paper-a' });
  const originalData = await state(page);
  await goTo(first, 2);
  await first.getByRole('button', { name: '放大 PDF', exact: true }).click();
  await expect(first.locator('.pdf-zoom')).toContainText('125%');
  await first.locator('.pdf-scroll').evaluate(async node => {
    const sheet = node.querySelector<HTMLElement>('.pdf-sheet[data-page-index="1"]')!;
    node.scrollTop += Math.round(sheet.getBoundingClientRect().height * .18);
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  });
  await expect.poll(async () => groups((await layout(page)).root)[0].tabs[0].reading?.offset ?? 0).toBeGreaterThan(.1);
  const before = groups((await layout(page)).root)[0].tabs[0].reading!;
  expect(before).toMatchObject({ pageIndex: 1, scale: 1.25 });
  await page.evaluate(() => window.addEventListener('drop', event => {
    const drag = event as DragEvent;
    (window as unknown as { nativePaneDrop: { alt: boolean; trusted: boolean } }).nativePaneDrop = { alt: drag.altKey, trusted: drag.isTrusted };
  }, true));
  await dragView(page, originalView.id, first, 'right', false, async () => {
    await mkdir('docs/verification/pane-navigation', { recursive: true });
    await page.screenshot({ path: 'docs/verification/pane-navigation/native-copy-preview-1440.png' });
  }, '保留原标签');
  await expect(panes(page)).toHaveCount(2);
  expect(await page.evaluate(() => (window as unknown as { nativePaneDrop: unknown }).nativePaneDrop)).toEqual({ alt: false, trusted: true });
  const duplicated = groups((await layout(page)).root);
  const views = duplicated.flatMap(group => group.tabs);
  expect(views).toHaveLength(2);
  expect(new Set(views.map(tab => tab.id)).size).toBe(2);
  expect(views.map(tab => tab.ref)).toEqual([originalView.ref, originalView.ref]);
  expect(views[0].id).toBe(originalView.id);
  for (const view of views) {
    expect(view.reading).toMatchObject({ pageIndex: 1, scale: 1.25 });
    expect(Math.abs((view.reading!.offset ?? 0) - before.offset!)).toBeLessThanOrEqual(.002);
  }
  const second = paneById(page, duplicated[1].id);
  for (const target of [first, second]) {
    await waitForPdf(target);
    await expect(target.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
    await expect(target.locator('.pdf-zoom')).toContainText('125%');
  }
  await saved(page);
  await page.screenshot({ path: 'docs/verification/pane-navigation/same-article-drag-1440.png' });
  await goTo(first, 1); await goTo(second, 3);
  await second.getByRole('button', { name: '放大 PDF', exact: true }).click();
  await expect(first.getByLabel('PDF 页码', { exact: true })).toHaveValue('1');
  await expect(first.locator('.pdf-zoom')).toContainText('125%');
  await expect(second.locator('.pdf-zoom')).toContainText('150%');
  await saved(page); await page.reload();
  await expect(first.getByLabel('PDF 页码', { exact: true })).toHaveValue('1');
  await expect(second.getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(first.locator('.pdf-zoom')).toContainText('125%');
  await expect(second.locator('.pdf-zoom')).toContainText('150%');
  expect(groups((await layout(page)).root).flatMap(group => group.tabs).map(tab => tab.id)).toEqual(views.map(tab => tab.id));
  const restored = await state(page);
  expect(Object.keys(restored.documents).sort()).toEqual(Object.keys(originalData.documents).sort());
  expect(restored.documents['paper-a'].hash).toMatch(/^[a-f0-9]{64}$/);
  expect(restored.documents['paper-a']).toMatchObject({ assetId: originalData.documents['paper-a'].assetId, hash: originalData.documents['paper-a'].hash });
});

test('窗格可递归分成三到六个不均匀区域，分隔条键盘/指针调整并放大还原', async ({ page }) => {
  await start(page);
  const originalId = await pane(page, 1).getAttribute('data-pane-id');
  const right = await split(page, pane(page, 1), '右');
  const bottom = await split(page, right, '下');
  await expect(panes(page)).toHaveCount(3);
  const fourth = await split(page, paneById(page, originalId!), '左');
  await split(page, bottom, '下');
  await split(page, fourth, '上');
  await expect(panes(page)).toHaveCount(6);
  const smallestId = await panes(page).evaluateAll(nodes => nodes.map(node => {
    const bounds = node.getBoundingClientRect();
    return { id: (node as HTMLElement).dataset.paneId!, area: bounds.width * bounds.height };
  }).sort((a, b) => a.area - b.area)[0].id);
  await paneById(page, smallestId).getByRole('button', { name: /^窗格 \d+ 操作$/ }).click();
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitem').first().press('End');
  const lastAction = menu.getByRole('menuitem', { name: '关闭窗格', exact: true });
  await expect(lastAction).toBeFocused();
  const menuBox = (await menu.boundingBox())!, lastBox = (await lastAction.boundingBox())!;
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(menuBox.y + menuBox.height + 1);
  await mkdir('docs/verification/pane-navigation', { recursive: true });
  await page.screenshot({ path: 'docs/verification/pane-navigation/six-panes-menu.png' });
  await lastAction.press('Escape');
  const areas = await panes(page).evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return box.width * box.height; }));
  expect(Math.max(...areas)).toBeGreaterThan(Math.min(...areas) * 1.5);
  const separator = main(page).getByRole('separator').first();
  const beforeKey = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus();
  await separator.press((await separator.getAttribute('aria-orientation')) === 'vertical' ? 'ArrowRight' : 'ArrowDown');
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(beforeKey);
  const beforeDrag = Number(await separator.getAttribute('aria-valuenow'));
  const box = (await separator.boundingBox())!;
  const vertical = await separator.getAttribute('aria-orientation') === 'vertical';
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + (vertical ? -45 : 0), box.y + box.height / 2 + (vertical ? 0 : -45), { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeLessThan(beforeDrag);
  const snapshot = await layout(page);
  const chosen = groups(snapshot.root)[2];
  await paneAction(page, paneById(page, chosen.id), '放大当前窗格');
  await expect.poll(async () => (await layout(page)).zoomedPaneId).toBe(chosen.id);
  await expect(paneById(page, chosen.id)).toBeVisible();
  for (const group of groups(snapshot.root).filter(group => group.id !== chosen.id)) await expect(paneById(page, group.id)).toBeHidden();
  await paneAction(page, paneById(page, chosen.id), '还原窗格布局');
  await expect.poll(async () => (await layout(page)).root).toEqual(snapshot.root);
  for (const group of groups(snapshot.root)) await expect(paneById(page, group.id)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
});

test('真实标签拖动显示落位预览，中心移动与Option复制，四边可依次拆成六窗', async ({ page }) => {
  test.setTimeout(90000);
  await start(page);
  await openSource(page, paperB);
  const firstId = await pane(page, 1).getAttribute('data-pane-id');
  const second = await split(page, pane(page, 1), '右');
  const secondId = await second.getAttribute('data-pane-id');
  await waitForPdf(paneById(page, firstId!)); await waitForPdf(second);
  const firstGroup = groups((await layout(page)).root).find(group => group.id === firstId)!;
  const viewA = firstGroup.tabs.find(tab => tab.ref.id === 'paper-a')!;
  await dragView(page, viewA.id, second, 'center');
  await expect.poll(async () => groups((await layout(page)).root).find(group => group.id === firstId)!.tabs.some(tab => tab.id === viewA.id)).toBe(false);
  await expect.poll(async () => groups((await layout(page)).root).find(group => group.id === secondId)!.tabs.some(tab => tab.id === viewA.id)).toBe(true);
  await dragView(page, viewA.id, paneById(page, firstId!), 'center', true);
  await expect.poll(async () => groups((await layout(page)).root).flatMap(group => group.tabs).filter(tab => tab.ref.id === 'paper-a').length).toBe(2);
  await waitForPdf(paneById(page, firstId!));
  for (const [index, side] of (['left', 'right', 'up', 'down'] as const).entries()) {
    const localView = groups((await layout(page)).root).find(group => group.id === firstId)!.tabs.find(tab => tab.ref.id === 'paper-a')!;
    await dragView(page, localView.id, paneById(page, firstId!), side, true);
    await expect(panes(page)).toHaveCount(index + 3);
  }
  const current = await layout(page);
  const viewsA = groups(current.root).flatMap(group => group.tabs).filter(tab => tab.ref.id === 'paper-a');
  expect(viewsA).toHaveLength(6);
  expect(new Set(viewsA.map(tab => tab.id)).size).toBe(6);
  expect(viewsA.every(tab => tab.ref.kind === 'document')).toBe(true);
  await saved(page); await page.reload();
  await expect(panes(page)).toHaveCount(6);
  expect(groups((await layout(page)).root).flatMap(group => group.tabs).filter(tab => tab.ref.id === 'paper-a').map(tab => tab.id).sort()).toEqual(viewsA.map(tab => tab.id).sort());
});

test('拖入仍在加载的论文窗格，PDF画布在预览期间替换后仍接受真实drop', async ({ page }) => {
  const bytes = await readFile('public/samples/retrieval-baseline.pdf');
  let releasePdf!: () => void;
  const pending = new Promise<void>(resolve => { releasePdf = resolve; });
  await page.route('**/samples/retrieval-baseline.pdf', async route => {
    await pending;
    await route.fulfill({ contentType: 'application/pdf', body: bytes });
  });
  try {
    await start(page);
    await openSource(page, paperB);
    const firstId = (await pane(page, 1).getAttribute('data-pane-id'))!;
    const second = await split(page, pane(page, 1), '右');
    const secondId = (await second.getAttribute('data-pane-id'))!;
    await expect(second.locator('.pdf-loading')).toBeVisible();
    const original = groups((await layout(page)).root).find(group => group.id === firstId)!.tabs.find(tab => tab.ref.id === 'paper-a')!;
    await dragView(page, original.id, second, 'center', false, async () => {
      const receiver = await second.locator('[data-pane-drop-receiver]').elementHandle();
      expect(receiver).toBeTruthy();
      releasePdf();
      await waitForPdf(second);
      await expect(second.locator('.pdf-loading')).toHaveCount(0);
      expect(await receiver!.evaluate(node => node.isConnected)).toBe(true);
      await expect(second.locator('.pane-drop-preview[data-drop-side="center"]')).toBeVisible();
    });
    await expect.poll(async () => groups((await layout(page)).root).find(group => group.id === firstId)!.tabs.some(tab => tab.id === original.id)).toBe(false);
    const destination = groups((await layout(page)).root).find(group => group.id === secondId)!;
    expect(destination.tabs.find(tab => tab.id === original.id)?.ref).toEqual({ kind: 'document', id: 'paper-a' });
    expect(destination.activeTabId).toBe(original.id);
    await expect(second.getByLabel('PDF 页码', { exact: true })).toHaveValue('1');
  } finally { releasePdf(); }
});

test('聚焦窗格承接打开操作，论文卡片白板文稿均可分屏，卡片共享正文', async ({ page }) => {
  await start(page);
  const firstId = await pane(page, 1).getAttribute('data-pane-id');
  const second = await split(page, pane(page, 1), '右');
  const secondId = await second.getAttribute('data-pane-id');
  await openCard(page, cardA);
  await expect(paneById(page, firstId!).getByLabel('PDF 页码', { exact: true })).toHaveValue('1');
  await expect(paneById(page, secondId!).getByLabel('卡片标题')).toHaveValue(cardA);
  const third = await split(page, paneById(page, secondId!), '下');
  const thirdId = await third.getAttribute('data-pane-id');
  const body = '多窗共享同一张卡片，编辑后仍能回到原文。';
  await third.getByLabel('卡片正文').fill(body);
  await expect(paneById(page, secondId!).getByLabel('卡片正文')).toHaveValue(body);
  await openResearchPage(page, '证据与论证');
  await expect(paneById(page, thirdId!).getByLabel('查找白板资料')).toBeVisible();
  const fourth = await split(page, paneById(page, thirdId!), '右');
  await openResearchPage(page, draftA);
  await expect(fourth.getByLabel('结论正文')).toBeVisible();
  await fourth.getByLabel('结论正文').fill('在同一工作台整理分屏阅读的结论。');
  const current = await state(page);
  expect(current.cards['card-a'].body).toBe(body);
  const activeRefs = groups(current.sessions['research-a'].layout!.root).map(group => group.tabs.find(tab => tab.id === group.activeTabId)!.ref.kind);
  expect(activeRefs).toEqual(['document', 'card', 'board', 'draft']);
  await saved(page); await page.reload();
  await expect(paneById(page, secondId!).getByLabel('卡片正文')).toHaveValue(body);
  await expect(fourth.getByLabel('结论正文')).toHaveValue('在同一工作台整理分屏阅读的结论。');
});

test('多窗格与聚焦状态按研究隔离，刷新后恢复原布局和每个视图的阅读位置', async ({ page }) => {
  await start(page);
  const firstId = await pane(page, 1).getAttribute('data-pane-id');
  const second = await split(page, pane(page, 1), '右');
  await goTo(paneById(page, firstId!), 3);
  await second.getByRole('tab').first().click();
  await openSource(page, paperB);
  await goTo(second, 2);
  const third = await split(page, second, '下');
  await openCard(page, cardA);
  await third.getByLabel('卡片标题').focus();
  await third.getByLabel('卡片正文').focus();
  const question = '对照两篇论文，继续核查证据的适用条件。';
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await panel(page).getByLabel('向 AI 提问').fill(question);
  await saved(page);
  const original = await layout(page);
  await switchResearch(page, 'research-b');
  await expect(panes(page)).toHaveCount(1);
  await expect(pane(page, 1).getByRole('tab', { name: '研究主页', exact: true })).toHaveAttribute('aria-selected', 'true');
  await openSource(page, paperA);
  const other = await split(page, pane(page, 1), '下');
  await goTo(other, 2);
  const alternate = await layout(page, 'research-b');
  expect(groups(alternate.root).flatMap(group => group.tabs).some(tab => tab.ref.id === 'paper-b' || tab.ref.id === 'card-a')).toBe(false);
  await switchResearch(page, 'research-a');
  await expect(panes(page)).toHaveCount(3);
  await expect(paneById(page, firstId!).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(second.getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(third.getByLabel('卡片标题')).toHaveValue(cardA);
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue(question);
  expect((await layout(page)).focusedPaneId).toBe(original.focusedPaneId);
  await saved(page); await page.reload();
  await expect(panes(page)).toHaveCount(3);
  expectRestored(await layout(page), original);
  expectRestored(await layout(page, 'research-b'), alternate);
});

for (const width of [1440, 1280, 1024]) test(`三窗格布局在 ${width}px 保持结构，放大后可恢复且右侧AI可用`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
  await start(page);
  await expect(pane(page, 1).getByRole('button', { name: '窗格 1 操作', exact: true }).getByText('分屏', { exact: true })).toBeVisible();
  const firstId = await pane(page, 1).getAttribute('data-pane-id');
  const right = await split(page, pane(page, 1), '右');
  const copiedViews = groups((await layout(page)).root).flatMap(group => group.tabs);
  expect(copiedViews.map(tab => tab.ref)).toEqual([{ kind: 'document', id: 'paper-a' }, { kind: 'document', id: 'paper-a' }]);
  expect(new Set(copiedViews.map(tab => tab.id)).size).toBe(2);
  await openCard(page, cardA);
  const below = await split(page, right, '下');
  await openResearchPage(page, draftA);
  // Capture the platform's native title selection before taking the restore baseline.
  await below.getByLabel('结论标题', { exact: true }).focus();
  await below.getByLabel('结论正文').fill('窄屏保留多窗格，通过放大查看当前内容。');
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await waitForPdf(paneById(page, firstId!));
  await saved(page);
  const original = await layout(page);
  const first = (await paneById(page, firstId!).boundingBox())!, second = (await right.boundingBox())!, third = (await below.boundingBox())!;
  expect(second.x).toBeGreaterThan(first.x + first.width - 3);
  expect(third.y).toBeGreaterThan(second.y + second.height - 3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await expect(panel(page).getByLabel('向 AI 提问')).toBeVisible();
  await saved(page); await page.evaluate(() => document.fonts.ready);
  await mkdir('docs/verification/pane-navigation', { recursive: true });
  await page.screenshot({ path: `docs/verification/pane-navigation/three-panes-${width}.png` });
  await paneAction(page, below, '放大当前窗格');
  await expect(below.getByLabel('结论正文')).toHaveValue('窄屏保留多窗格，通过放大查看当前内容。');
  await expect(paneById(page, firstId!)).toBeHidden();
  await paneAction(page, below, '还原窗格布局');
  await expect(paneById(page, firstId!)).toBeVisible();
  expectRestored(await layout(page), original);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
});
