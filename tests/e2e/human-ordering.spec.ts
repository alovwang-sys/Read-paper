import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import { mockProjectService } from './project-fixture';
import { openResearchNavigation, openResearchPage, switchResearch } from './knowledge-helpers';
import { main, pane, panes, saved, state } from './workspace-split-helpers';

const longBoardTitle = '条件与限制：比较不同数据来源、适用范围和仍待核查的研究结论';
const output = 'docs/verification/human-board-control';
const nav = (page: Page) => page.getByRole('navigation', { name: '研究内导航' });
const rows = (page: Page, kind: 'board' | 'draft') => nav(page).locator(`[data-nav-kind="${kind}"] [data-order-id]`);
const ids = (list: Locator) => list.evaluateAll(items => items.map(item => item.getAttribute('data-order-id')));

async function boot(page: Page) {
  const seed = createSeed();
  seed.boards['board-a2'].title = longBoardTitle;
  seed.boards['board-b2'] = { id: 'board-b2', researchId: 'research-b', title: '长文阅读顺序' };
  seed.drafts['draft-a2'] = { id: 'draft-a2', researchId: 'research-a', title: '补充讨论', body: '', evidenceIds: [] };
  seed.researches['research-b'].cardIds = ['card-b', 'card-a'];
  seed.researches['research-b'].documentIds = ['paper-a', 'paper-b'];
  for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'demo';
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: 'order-fixture', limits: { maxInputChars: 120000, maxImages: 0, maxImageBytes: 0 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route(/\/api\/ai\/(chat|agents\/run)$/, () => { throw new Error('人工排序验收不得调用模型'); });
  await page.goto('/'); await expect(main(page)).toBeVisible(); await saved(page);
}

async function orderMenu(page: Page, title: string, direction: '上移' | '下移', target: Locator = nav(page)) {
  const trigger = target.getByRole('button', { name: `${title} 的排序操作`, exact: true });
  await trigger.focus(); await trigger.press('Enter');
  const option = page.getByRole('menu', { name: `${title} 的顺序`, exact: true }).getByRole('menuitem', { name: direction, exact: true });
  await expect(option).toBeFocused(); await option.press('Enter');
  await expect(trigger).toBeFocused();
}

async function dragBefore(page: Page, source: Locator, target: Locator, screenshot?: string) {
  const handle = source.locator('.resource-order-trigger');
  await handle.scrollIntoViewIfNeeded();
  const start = (await handle.boundingBox())!, end = (await target.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
  try {
    await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2, { steps: 4 });
    await page.mouse.move(end.x + end.width / 2, end.y + 4, { steps: 16 });
    await page.mouse.move(end.x + end.width / 2, end.y + 4);
    await expect(target).toHaveAttribute('data-order-drop', 'before');
    if (screenshot) { await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/${screenshot}` }); }
    await page.mouse.up();
  } finally { await page.mouse.up(); }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`分层导航与排序入口 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport); await boot(page); await openResearchNavigation(page);
    for (const [kind, name, icon] of [['board', '白板', 'layout-grid'], ['draft', '文稿', 'notebook-pen']] as const) {
      const parent = nav(page).getByRole('button', { name, exact: true }), child = rows(page, kind).first().locator('.nested-nav');
      await expect(parent.locator(`svg.lucide-${icon}`)).toHaveAttribute('width', '16');
      await expect(child.locator('svg')).toHaveAttribute('width', '14');
      const parentBox = (await parent.boundingBox())!, childBox = (await child.boundingBox())!;
      expect(childBox.x - parentBox.x).toBeGreaterThanOrEqual(30);
      expect(childBox.y).toBeGreaterThan(parentBox.y);
      await expect(rows(page, kind).first().locator('.resource-order-trigger')).toBeVisible();
    }
    const longTitle = nav(page).getByRole('button', { name: longBoardTitle, exact: true });
    await expect(longTitle).toHaveAttribute('title', longBoardTitle);
    expect(await longTitle.locator('span').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await nav(page).getByRole('button', { name: '收起白板列表', exact: true }).click();
    await expect(rows(page, 'board')).toHaveCount(0);
    await nav(page).getByRole('button', { name: '展开白板列表', exact: true }).click();
    await orderMenu(page, longBoardTitle, '上移');
    expect(await ids(rows(page, 'board'))).toEqual(['board-a2', 'board-a']);
    await dragBefore(page, rows(page, 'board').last(), rows(page, 'board').first(), `navigation-drop-${viewport.width}.png`);
    expect(await ids(rows(page, 'board'))).toEqual(['board-a', 'board-a2']);
    if (viewport.width === 1024) {
      const trigger = nav(page).getByRole('button', { name: `${longBoardTitle} 的排序操作`, exact: true });
      await trigger.focus(); await trigger.press('Enter');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu', { name: `${longBoardTitle} 的顺序`, exact: true })).toHaveCount(0);
      await expect(nav(page)).toBeVisible(); await expect(trigger).toBeFocused();
      await trigger.press('Enter'); await page.keyboard.press('Tab');
      await expect(page.getByRole('menu', { name: `${longBoardTitle} 的顺序`, exact: true })).toHaveCount(0);
      await expect(nav(page).getByRole('button', { name: '文稿', exact: true })).toBeFocused();
      await expect(nav(page)).toBeVisible();
    }
    expect((await state(page)).sessions['research-a'].active).toMatchObject({ kind: 'researchView', id: 'home' });
    await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/navigation-${viewport.width}.png` });
  });
}

test('白板和文稿顺序按研究恢复，菜单边界与当前正文保持一致', async ({ page }) => {
  await boot(page);
  await nav(page).getByRole('button', { name: '检索增强的适用条件', exact: true }).click();
  const body = main(page).getByLabel('结论正文'); await body.fill('尚未完成的人工结论 [1]');
  const before = await state(page), activeId = before.sessions['research-a'].active;
  await orderMenu(page, longBoardTitle, '上移');
  await orderMenu(page, '补充讨论', '上移');
  await expect(body).toHaveValue('尚未完成的人工结论 [1]');
  expect((await state(page)).sessions['research-a'].active).toEqual(activeId);
  await nav(page).getByRole('button', { name: `${longBoardTitle} 的排序操作`, exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '上移', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await nav(page).getByRole('button', { name: '收起白板列表', exact: true }).click();
  await switchResearch(page, 'research-b');
  expect(await ids(rows(page, 'board'))).toEqual(['board-b', 'board-b2']);
  expect(await ids(rows(page, 'draft'))).toEqual(['draft-b']);
  await nav(page).getByRole('button', { name: '研究结论 的排序操作', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '上移', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: '下移', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await switchResearch(page, 'research-a');
  await expect(rows(page, 'board')).toHaveCount(0); expect(await ids(rows(page, 'draft'))).toEqual(['draft-a2', 'draft-a']);
  await expect(body).toHaveValue('尚未完成的人工结论 [1]');
  await saved(page); await page.reload(); await expect(main(page)).toBeVisible();
  await expect(rows(page, 'board')).toHaveCount(0);
  await nav(page).getByRole('button', { name: '展开白板列表', exact: true }).click();
  expect(await ids(rows(page, 'board'))).toEqual(['board-a2', 'board-a']);
  expect(await ids(rows(page, 'draft'))).toEqual(['draft-a2', 'draft-a']);
  await expect(body).toHaveValue('尚未完成的人工结论 [1]');
  const after = await state(page);
  expect(after.drafts['draft-a'].evidenceIds).toEqual(before.drafts['draft-a'].evidenceIds);
  expect(after.placements).toEqual(before.placements);
});

test('卡片手动排序不改白板、共享正文和研究 B，筛选时保留打开拖动', async ({ page }) => {
  await boot(page); await openResearchPage(page, '卡片');
  const cards = main(page).locator('.research-card-grid [data-order-id]');
  const before = await state(page);
  await orderMenu(page, '无关材料可能放大不确定性', '上移', main(page));
  expect(await ids(cards)).toEqual(['card-b', 'card-a', 'card-c', 'card-unverified']);
  await dragBefore(page, main(page).locator('.research-card-grid [data-order-id="card-c"]'), cards.first(), 'cards-drop-1440.png');
  expect(await ids(cards)).toEqual(['card-c', 'card-b', 'card-a', 'card-unverified']);
  await expect(panes(page)).toHaveCount(1); await expect(main(page).getByRole('heading', { name: '卡片', exact: true })).toBeVisible();
  await page.screenshot({ path: `${output}/cards-manual-order-1440.png` });
  await main(page).getByLabel('搜索研究卡片').fill('相关性');
  await expect(main(page)).toContainText('清除搜索与筛选后可调整顺序');
  await expect(cards.first().getByRole('button', { name: '相关性是检索收益的前提 的排序操作', exact: true })).toBeDisabled();
  await expect(cards.first()).toHaveAttribute('draggable', 'true');
  await main(page).getByRole('button', { name: '清除筛选', exact: true }).click();
  await switchResearch(page, 'research-b'); await openResearchPage(page, '卡片');
  expect(await ids(cards)).toEqual(['card-b', 'card-a']);
  await switchResearch(page, 'research-a'); expect(await ids(cards)).toEqual(['card-c', 'card-b', 'card-a', 'card-unverified']);
  await saved(page); await page.reload(); await expect(main(page)).toBeVisible();
  expect(await ids(cards)).toEqual(['card-c', 'card-b', 'card-a', 'card-unverified']);
  const after = await state(page);
  expect(after.placements).toEqual(before.placements); expect(after.cards).toEqual(before.cards);
  expect(after.researches['research-b'].cardIds).toEqual(before.researches['research-b'].cardIds);
});

test('卡片排序拖动仍可在新窗格打开同一实体', async ({ page }) => {
  await boot(page); await openResearchPage(page, '卡片');
  const before = await state(page), source = main(page).locator('[data-order-id="card-a"] .resource-order-trigger');
  const start = (await source.boundingBox())!, content = (await pane(page, 1).locator('[data-pane-content]').boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
  try {
    await page.mouse.move(start.x + 14, start.y + start.height / 2, { steps: 4 });
    await page.mouse.move(content.x + content.width - 6, content.y + content.height / 2, { steps: 16 });
    await page.mouse.move(content.x + content.width - 6, content.y + content.height / 2);
    await expect(main(page).locator('.pane-drop-preview[data-drop-side="right"]')).toBeVisible();
    await page.mouse.up();
  } finally { await page.mouse.up(); }
  await expect(panes(page)).toHaveCount(2);
  await expect(main(page).getByLabel('卡片标题')).toHaveValue('相关性是检索收益的前提');
  const after = await state(page);
  expect(after.researches['research-a'].cardIds).toEqual(before.researches['research-a'].cardIds);
  expect(after.cards).toEqual(before.cards); expect(after.placements).toEqual(before.placements);
});
