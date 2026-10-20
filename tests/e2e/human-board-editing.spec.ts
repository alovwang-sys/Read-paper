import { expect, test, type Locator, type Page } from '@playwright/test';
import { createSeed } from '../../src/data/seed';
import type { WorkspaceData } from '../../src/domain/types';
import { openResearchPage, switchResearch } from './knowledge-helpers';
import { mockProjectService } from './project-fixture';
import { pane, split, state as data } from './workspace-split-helpers';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
const node = (target: Locator, id: string) => target.locator(`[data-placement-id="${id}"]`);
const changes = (state: WorkspaceData) => Object.values(state.boardChanges ?? {}).filter(change => change.boardId === 'board-a');
async function start(page: Page) {
  const seed = createSeed();
  seed.cards['card-a'].provenance = {
    origin: 'conversation', researchId: 'research-a', conversationId: 'human-board-fixture',
    conversationTitle: '关系图讨论', requestId: 'human-board-fixture-request', prompt: '比较材料的适用条件。',
    answer: '相关性是检索收益的前提。', selection: '相关性是检索收益的前提。', context: [],
    generationRequestIds: [], createdAt: '2026-10-20T00:00:00.000Z', model: '本地测试来源快照',
  };
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, model: 'human-board-fixture', images: false } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/chat', () => { throw new Error('Human board editing must not call a model'); });
  await page.goto('/');
  await saved(page);
  await openResearchPage(page, '证据与论证');
  await expect(node(main(page), 'placement-a')).toBeVisible();
}
async function drag(page: Page, target: Locator, dx: number, dy: number, during?: () => Promise<void>) {
  const handle = target.locator('.board-node-header');
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const point = { x: box.x + 45, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 8 });
  await during?.();
  await page.mouse.up();
}

test('多选拖动只提交一条历史，方向键按 1px/10px 移动，刷新与历史恢复保留共享来源', async ({ page }) => {
  await start(page);
  const first = node(main(page), 'placement-a'), second = node(main(page), 'placement-b');
  await first.locator('.board-node-header').click();
  await second.locator('.board-node-header').click({ modifiers: ['Shift'] });
  await expect(main(page).getByLabel('白板选中项操作')).toContainText('已选 2 项');
  const before = await data(page);
  await drag(page, second, 80, 45, async () => {
    expect((await data(page)).placements).toEqual(before.placements);
    expect(changes(await data(page))).toHaveLength(changes(before).length);
    await expect(first).toHaveCSS('left', '135px');
    await expect(second).toHaveCSS('left', '465px');
  });
  let state = await data(page);
  expect(changes(state)).toHaveLength(changes(before).length + 1);
  expect(state.placements['placement-a']).toMatchObject({ x: 135, y: 135 });
  expect(state.placements['placement-b']).toMatchObject({ x: 465, y: 295 });
  await expect(main(page).getByLabel('白板选中项操作')).toContainText('已选 2 项');
  await first.focus();
  await first.press('ArrowRight');
  await expect(first).toHaveCSS('left', '136px');
  await expect(second).toHaveCSS('left', '466px');
  await first.press('Shift+ArrowDown');
  await expect(first).toHaveCSS('top', '145px');
  await expect(second).toHaveCSS('top', '305px');
  state = await data(page);
  expect(state.cards).toEqual(before.cards);
  expect(state.evidence).toEqual(before.evidence);
  expect(state.edges).toEqual(before.edges);
  expect(state.placements['placement-a2']).toEqual(before.placements['placement-a2']);
  expect(state.placements['placement-c']).toEqual(before.placements['placement-c']);
  await saved(page); await page.reload();
  await expect(first).toHaveCSS('left', '136px');
  await expect(second).toHaveCSS('top', '305px');
  await first.getByRole('button', { name: /^编辑内容：/ }).click();
  await panel(page).getByLabel('卡片正文', { exact: true }).fill('人工确认后的共享正文，恢复布局时仍须保留。');
  await main(page).getByRole('button', { name: '白板版本历史', exact: true }).click();
  const history = main(page).getByRole('region', { name: '白板版本历史', exact: true });
  await history.locator('.board-history-item').first().click();
  await history.getByRole('button', { name: '恢复此次变更前', exact: true }).click();
  await saved(page);
  state = await data(page);
  expect(state.placements['placement-a']).toMatchObject({ x: 136, y: 135 });
  expect(state.placements['placement-b']).toMatchObject({ x: 466, y: 295 });
  expect(state.cards['card-a'].body).toBe('人工确认后的共享正文，恢复布局时仍须保留。');
  expect(state.cards['card-a'].provenance).toEqual(before.cards['card-a'].provenance);
  expect(state.cards['card-a'].evidenceIds).toEqual(before.cards['card-a'].evidenceIds);
  expect(state.evidence).toEqual(before.evidence);
  expect(state.edges).toEqual(before.edges);
  expect(state.placements['placement-a2']).toEqual(before.placements['placement-a2']);
});

test('多选边界保持相对距离，修饰键选择与另一个白板视图相互独立', async ({ page }) => {
  await start(page);
  const first = node(main(page), 'placement-a'), second = node(main(page), 'placement-b');
  await first.locator('.board-node-header').click();
  await second.locator('.board-node-header').click({ modifiers: ['ControlOrMeta'] });
  await expect(main(page).getByLabel('白板选中项操作')).toContainText('已选 2 项');
  await drag(page, second, -150, -100);
  await expect(first).toHaveCSS('left', '20px');
  await expect(first).toHaveCSS('top', '55px');
  await expect(second).toHaveCSS('left', '350px');
  await expect(second).toHaveCSS('top', '215px');
  await second.focus();
  await second.press('Shift+ArrowLeft');
  await second.press('ArrowUp');
  await expect(first).toHaveCSS('left', '20px');
  await expect(second).toHaveCSS('top', '215px');
  await second.locator('.board-node-header').click({ modifiers: ['Shift'] });
  await expect(main(page).getByLabel('白板选中项操作')).toContainText('已选 1 项');
  await second.locator('.board-node-header').click({ modifiers: ['Meta'] });
  await expect(main(page).getByLabel('白板选中项操作')).toContainText('已选 2 项');
  const left = pane(page, 1), right = await split(page, left, '右');
  await expect(right.locator('.board-node.is-selected')).toHaveCount(0);
  const rightFirst = node(right, 'placement-a');
  await rightFirst.focus();
  await rightFirst.press('ArrowRight');
  const state = await data(page);
  expect(state.placements['placement-a'].x).toBe(21);
  expect(state.placements['placement-b'].x).toBe(350);
  expect(state.placements['placement-a2'].x).toBe(60);
  await switchResearch(page, 'research-b');
  await switchResearch(page, 'research-a');
  await expect(right.locator('.board-node.is-selected')).toHaveCount(0);
});

test('编辑内容与原文入口可发现，标题正文共享而布局独立，三个宽度可操作', async ({ page }, testInfo) => {
  await start(page);
  const first = node(main(page), 'placement-a'), before = await data(page);
  const title = '人工修改：相关性与检索收益', body = '人工补充了适用条件，保留原始对话与论文引用。';
  await first.getByRole('button', { name: /^编辑内容：/ }).click();
  await panel(page).getByLabel('卡片标题', { exact: true }).fill(title);
  await panel(page).getByLabel('卡片正文', { exact: true }).fill(body);
  await expect(first.getByRole('heading')).toHaveText(title);
  await expect(first).toContainText(body);
  expect((await data(page)).placements).toEqual(before.placements);
  expect((await data(page)).cards['card-a'].provenance).toEqual(before.cards['card-a'].provenance);
  await saved(page); await page.reload();
  await expect(first.getByRole('heading')).toHaveText(title);
  await openResearchPage(page, '条件与限制');
  await expect(node(main(page), 'placement-a2')).toContainText(body);
  await openResearchPage(page, '证据与论证');
  await first.getByRole('button', { name: /^查看卡片原文：/ }).click();
  await expect(panel(page).locator('canvas').first()).toBeVisible();
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(main(page).getByRole('button', { name: '白板版本历史', exact: true })).toBeInViewport();
    await expect(main(page).locator('.board-bottom-hint')).toContainText('方向键 1px');
    await saved(page);
    await page.screenshot({ path: testInfo.outputPath(`board-source-${width}.png`) });
    await first.getByRole('button', { name: /^编辑内容：/ }).click();
    await expect(panel(page).getByLabel('卡片正文', { exact: true })).toHaveValue(body);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await saved(page);
    await page.screenshot({ path: testInfo.outputPath(`board-edit-${width}.png`) });
    await first.getByRole('button', { name: /^查看卡片原文：/ }).click();
  }
});

test('曲线跟随拖动与卡片高度，鼠标和键盘仍可编辑关系说明', async ({ page }) => {
  await start(page);
  const first = node(main(page), 'placement-a');
  const edge = main(page).getByRole('button', { name: '编辑关系：适用边界', exact: true });
  const path = edge.locator('.board-connection-stroke');
  await expect(path).toHaveAttribute('d', / C /);
  const before = await path.getAttribute('d');
  await drag(page, first, 30, -20, async () => {
    await expect(path).not.toHaveAttribute('d', before!);
  });
  const afterMove = await path.getAttribute('d');
  await first.getByRole('button', { name: /^编辑内容：/ }).click();
  await panel(page).getByLabel('卡片标题', { exact: true }).fill('需要核查材料适用范围与检索环节。'.repeat(8));
  await expect(path).not.toHaveAttribute('d', afterMove!);
  const midpoint = await edge.locator('.board-edge-hit').evaluate(element => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    return new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!).toJSON();
  });
  await page.mouse.click(midpoint.x, midpoint.y);
  await main(page).getByLabel('连线说明', { exact: true }).fill('人工确认的适用边界');
  const renamed = main(page).getByRole('button', { name: '编辑关系：人工确认的适用边界', exact: true });
  await renamed.focus();
  await renamed.press('Space');
  await expect(main(page).getByLabel('连线说明', { exact: true })).toHaveValue('人工确认的适用边界');
  await saved(page); await page.reload();
  await expect(renamed).toHaveCount(1);
  expect((await data(page)).edges['edge-a']).toMatchObject({ fromPlacementId: 'placement-a', toPlacementId: 'placement-b', label: '人工确认的适用边界' });
});
