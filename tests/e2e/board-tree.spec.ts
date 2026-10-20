import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import { mockProjectService } from './project-fixture';
import { openResearchPage } from './knowledge-helpers';
import { main, panel, saved, state } from './workspace-split-helpers';

async function start(page: Page, tree = false, seed = createSeed()) {
  if (tree) {
    seed.boards['board-a'].layout = 'tree';
    seed.placements['placement-b'].parentPlacementId = 'placement-a';
    seed.placements['placement-b'].order = 0;
    seed.placements['placement-doc'] = { id: 'placement-doc', boardId: 'board-a', resourceRef: { kind: 'document', id: 'paper-a' }, x: 700, y: 90, group: '', parentPlacementId: 'placement-a', order: 1 };
    seed.cards['card-a'].evidenceIds = ['evidence-a', 'evidence-b'];
  }
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: 'tree-fixture' } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/chat', () => { throw new Error('Manual tree editing must not call a model'); });
  await page.goto('/');
  await saved(page);
  await openResearchPage(page, '证据与论证');
  await expect(main(page).locator('[data-placement-id="placement-a"]')).toBeVisible();
  return seed;
}
const node = (page: Page, id: string) => main(page).locator(`[data-placement-id="${id}"]`);
const outline = (page: Page) => main(page).getByRole('complementary', { name: '研究图大纲' });

test('旧图转换先预览，父级和排序同步大纲，新增卡片复用共享实体', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page);
  const before = await state(page);
  await main(page).getByRole('button', { name: '预览层级整理', exact: true }).click();
  await expect(main(page).getByRole('dialog', { name: '预览层级整理' })).toBeVisible();
  expect((await state(page)).placements).toEqual(before.placements);
  const preview = await page.locator('[data-preview-placement]').evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-preview-placement')!, x: parseFloat((element as HTMLElement).style.left), y: parseFloat((element as HTMLElement).style.top) })));
  await main(page).getByRole('button', { name: '确认层级整理', exact: true }).click();
  expect((await state(page)).boards['board-a'].layout).toBe('tree');
  for (const position of preview) expect((await state(page)).placements[position.id]).toMatchObject({ x: position.x, y: position.y });
  expect(Object.values((await state(page)).placements).filter(item => item.boardId === 'board-a').every(item => !item.parentPlacementId)).toBe(true);
  await node(page, 'placement-b').click();
  await outline(page).getByLabel('节点所属分支').selectOption('placement-a');
  expect((await state(page)).placements['placement-b'].parentPlacementId).toBe('placement-a');
  await node(page, 'placement-a').click();
  await outline(page).getByLabel('新节点标题').fill('人工补充的评估计划');
  await outline(page).getByRole('button', { name: '添加节点', exact: true }).click();
  let current = await state(page);
  const added = Object.values(current.placements).find(item => item.resourceRef.kind === 'card' && current.cards[item.resourceRef.id]?.title === '人工补充的评估计划')!;
  expect(added.parentPlacementId).toBe('placement-a');
  const beforeOrder = current.placements['placement-b'].order;
  await outline(page).getByRole('button', { name: '上移', exact: true }).click();
  current = await state(page);
  expect(current.placements[added.id].order).toBe(beforeOrder);
  await expect(node(page, added.id)).toHaveCSS('height', '100px');
  await node(page, added.id).getByRole('button', { name: /^编辑内容：/ }).click();
  await panel(page).getByLabel('卡片正文', { exact: true }).fill('建议：按相同输入比较恢复前后的结果。');
  await saved(page); await page.reload();
  expect((await state(page)).placements[added.id].parentPlacementId).toBe('placement-a');
  await main(page).getByRole('button', { name: '显示摘要', exact: true }).click();
  await expect(node(page, added.id)).toContainText('按相同输入比较');
  await expect(node(page, added.id)).toHaveCSS('height', '160px');
  expect(errors).toEqual([]);
});

test('折叠只是视图，刷新恢复；搜索展开祖先；移出父节点提升子节点且可完整撤销', async ({ page }) => {
  await start(page, true);
  const before = await state(page), revision = before.boardRevisions?.['board-a'] ?? 0;
  const root = node(page, 'placement-a');
  await root.getByRole('button', { name: /^收起分支：/ }).click();
  await expect(node(page, 'placement-b')).toHaveCount(0);
  await expect(main(page).getByRole('button', { name: '1 条关联因折叠隐藏' })).toBeVisible();
  expect((await state(page)).boardRevisions?.['board-a'] ?? 0).toBe(revision);
  await saved(page); await page.reload();
  await expect(node(page, 'placement-b')).toHaveCount(0);
  await main(page).getByLabel('查找白板资料').fill('无关材料可能放大不确定性');
  await main(page).getByLabel('白板查找结果').getByRole('button').first().click();
  await expect(node(page, 'placement-b')).toBeVisible();
  expect((await state(page)).boardRevisions?.['board-a'] ?? 0).toBe(revision);
  await main(page).getByLabel('查找白板资料').fill('');
  await root.click();
  await main(page).getByRole('button', { name: '移出白板', exact: true }).click();
  let current = await state(page);
  expect(current.placements['placement-a']).toBeUndefined();
  expect(current.placements['placement-b'].parentPlacementId).toBeUndefined();
  expect(current.cards).toEqual(before.cards);
  await main(page).getByRole('button', { name: '撤销移出', exact: true }).click();
  current = await state(page);
  expect(current.placements).toEqual(before.placements);
  expect(current.edges).toEqual(before.edges);
});

test('来源先选择，紧凑图和大纲在三种宽度可用，节点正文不被拖动修改', async ({ page }) => {
  await start(page, true);
  const root = node(page, 'placement-a');
  await root.getByRole('button', { name: /^查看卡片原文：/ }).click();
  const source = main(page).getByRole('dialog', { name: '选择卡片原文' });
  await expect(source.getByRole('button', { name: /PDF 第/ })).toHaveCount(2);
  await source.getByRole('button', { name: /PDF 第/ }).first().click();
  await expect(panel(page).locator('canvas').first()).toBeVisible();
  const before = await state(page);
  await root.focus(); await root.press('ArrowRight');
  expect((await state(page)).placements).toEqual(before.placements);
  await mkdir('docs/verification/tree-board', { recursive: true });
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await main(page).getByRole('button', { name: '大纲与节点', exact: true }).click();
    await expect(outline(page)).toBeVisible();
    await expect(outline(page).getByLabel('新节点标题')).toBeInViewport();
    await expect(main(page).getByRole('button', { name: '关闭研究图大纲' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: `docs/verification/tree-board/board-tree-${width}.png` });
    await outline(page).getByRole('button', { name: '关闭研究图大纲' }).click();
    await page.screenshot({ path: `docs/verification/tree-board/board-tree-source-${width}.png` });
  }
});


test('新增关联立即可见，整枝删除要确认且不删共享内容', async ({ page }) => {
  await start(page, true);
  await main(page).getByRole('button', { name: '连接卡片', exact: true }).click();
  await node(page, 'placement-a').click();
  await node(page, 'placement-doc').click();
  await expect(main(page).getByRole('button', { name: '编辑关系：支持', exact: true })).toBeVisible();
  await node(page, 'placement-a').click();
  await main(page).getByRole('button', { name: '大纲与节点', exact: true }).click();
  await expect(outline(page).getByLabel('节点所属分支').locator('option[value="placement-b"]')).toHaveCount(0);
  await expect(outline(page).getByLabel('节点所属分支').locator('option[value="placement-doc"]')).toHaveCount(0);
  await outline(page).getByRole('button', { name: '关闭研究图大纲' }).click();
  const before = await state(page);
  await saved(page); await page.reload();
  await expect(node(page, 'placement-a')).toHaveClass(/is-selected/);
  await main(page).getByRole('button', { name: '移出整枝…', exact: true }).click();
  expect((await state(page)).placements).toEqual(before.placements);
  await main(page).getByRole('button', { name: '确认移出整枝', exact: true }).click();
  const current = await state(page);
  for (const id of ['placement-a', 'placement-b', 'placement-doc']) expect(current.placements[id]).toBeUndefined();
  expect(current.cards).toEqual(before.cards);
  expect(current.evidence).toEqual(before.evidence);
  await main(page).getByRole('button', { name: '撤销移出', exact: true }).click();
  expect((await state(page)).placements).toEqual(before.placements);
});


test('长标题与正文从层级切回自由布局不重叠，共享资料保持原样', async ({ page }) => {
  const seed = createSeed();
  for (const card of Object.values(seed.cards)) {
    card.title = `${card.title}：${'补充适用条件、实验设置和需要核查的问题。'.repeat(8)}`;
    card.body = '这是需要保留完整内容的人工研究笔记。\n'.repeat(30);
  }
  seed.documents['paper-a'].title = '超长文献标题：'.repeat(24);
  seed.documents['paper-a'].authors = 'Author One, Author Two, Author Three; '.repeat(20);
  seed.placements['placement-b'].parentPlacementId = 'placement-a';
  seed.placements['placement-b'].order = 0;
  seed.placements['placement-doc'] = { id: 'placement-doc', boardId: 'board-a', resourceRef: { kind: 'document', id: 'paper-a' }, x: 700, y: 90, group: '', parentPlacementId: 'placement-a', order: 1 };
  await start(page, false, seed);
  const before = await state(page);
  await main(page).getByRole('button', { name: '预览层级整理', exact: true }).click();
  await main(page).getByRole('button', { name: '确认层级整理', exact: true }).click();
  await expect(node(page, 'placement-a')).toHaveCSS('height', '100px');
  await main(page).getByRole('button', { name: '切换为自由布局', exact: true }).click();
  await expect(main(page).locator('.board-view')).not.toHaveClass(/is-tree/);
  const rectangles = await main(page).locator('.board-node').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { id: element.getAttribute('data-placement-id'), x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, height: rect.height };
  }));
  expect(rectangles).toHaveLength(4);
  expect(rectangles.every(rect => rect.height >= 215)).toBe(true);
  for (let i = 0; i < rectangles.length; i++) for (let j = i + 1; j < rectangles.length; j++) {
    const a = rectangles[i], b = rectangles[j];
    const overlap = a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
    expect(overlap, `${a.id} and ${b.id} must not overlap after leaving compact layout`).toBe(false);
  }
  const groups = await main(page).locator('.board-group').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { name: element.textContent, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
  }));
  for (const group of groups) for (const rect of rectangles.filter(rect => seed.placements[rect.id!]?.group === group.name)) {
    expect(rect.x).toBeGreaterThan(group.x); expect(rect.y).toBeGreaterThan(group.y);
    expect(rect.right).toBeLessThan(group.right); expect(rect.bottom).toBeLessThan(group.bottom);
  }
  const current = await state(page);
  expect(current.boards['board-a'].layout).toBe('free');
  expect(current.cards).toEqual(before.cards);
  expect(current.documents).toEqual(before.documents);
  expect(current.evidence).toEqual(before.evidence);
  expect(current.edges).toEqual(before.edges);
  expect(current.placements['placement-b'].parentPlacementId).toBe('placement-a');
  await saved(page);
  await mkdir('docs/verification/tree-board', { recursive: true });
  await page.screenshot({ path: 'docs/verification/tree-board/tree-to-free-long-content.png' });
});
