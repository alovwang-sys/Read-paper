import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { DrawingScene } from '../../src/domain/drawing';
import type { WorkspaceData } from '../../src/domain/types';
import { switchResearch } from './knowledge-helpers';
import { mockProjectService } from './project-fixture';
import { groups, layout, pane, paneAction, split } from './workspace-split-helpers';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const drawing = (page: Page) => main(page).getByLabel('白板自由绘图', { exact: true });
const canvas = (page: Page) => drawing(page).locator('canvas.interactive');
const note = '核对相关性与适用边界';

async function data(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => { const path = '/src/services/workspace.ts'; return (await import(path)).workspace.getState().data; });
}

async function readDrawing(page: Page) {
  return page.evaluate(async () => {
    const workspacePath = '/src/services/workspace.ts', storagePath = '/src/data/storage.ts', drawingPath = '/src/domain/drawing.ts';
    const ref = (await import(workspacePath)).workspace.getState().data.boards['board-a'].drawing;
    if (!ref) return undefined;
    const storage = await import(storagePath), blob = await storage.getAsset(ref.assetId);
    if (!blob) throw new Error('Saved drawing asset is missing');
    return { ref, hash: await storage.contentHash(await blob.arrayBuffer()), scene: (await import(drawingPath)).parseDrawingScene(await blob.text()) as DrawingScene };
  });
}

async function start(page: Page, tree = false) {
  const seed = createSeed();
  seed.sessions['research-a'].active = { kind: 'board', id: 'board-a' };
  seed.sessions['research-a'].openItems = [{ kind: 'board', id: 'board-a' }];
  seed.sessions['research-a'].viewports['drawing:board-a'] = { x: 0, y: 0, scale: .75 };
  seed.sessions['research-a'].panel = { ...seed.sessions['research-a'].panel, open: true, mode: 'ai', aiMode: 'demo' };
  seed.conversations['conversation-research-a'].connectionId = 'demo';
  seed.conversations['conversation-research-a'].contextIds = ['evidence-a'];
  seed.conversations['conversation-research-a'].input = '结合这条原文，核对图中的适用边界。';
  delete seed.placements['placement-b']; delete seed.placements['placement-c'];
  seed.placements['placement-a'].x = 45; seed.placements['placement-a'].y = 130;
  seed.placements['drawing-pdf'] = { id: 'drawing-pdf', boardId: 'board-a', resourceRef: { kind: 'document', id: 'paper-a' }, x: 360, y: 130, group: '原文' };
  if (tree) {
    seed.boards['board-a'].layout = 'tree';
    seed.placements['placement-a'].order = 0;
    seed.placements['drawing-pdf'].parentPlacementId = 'placement-a';
    seed.placements['drawing-pdf'].order = 0;
  }
  seed.edges['edge-a'].toPlacementId = 'drawing-pdf'; seed.edges['edge-a'].label = '核对原文';
  const unexpected: string[] = [];
  await page.route('**/api/ai/**', route => {
    unexpected.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 501, json: { error: '绘图验收未模拟此接口' } });
  });
  await mockProjectService(page, { seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: '绘图验收 · 模拟连接', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.goto('/');
  await expect(main(page).getByRole('button', { name: '绘图', exact: true })).toBeVisible();
  await expect(main(page).locator('[data-placement-id="placement-a"]')).toBeVisible();
  await main(page).getByRole('button', { name: '绘图', exact: true }).click();
  await expect(canvas(page)).toBeVisible();
  return { unexpected };
}

async function draw(page: Page) {
  const box = (await canvas(page).boundingBox())!;
  const x = box.x + 230, y = box.y + box.height * .58;
  await drawing(page).getByTestId('toolbar-rectangle').locator('..').click();
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 190, y + 65, { steps: 12 }); await page.mouse.up();
  await drawing(page).getByTestId('toolbar-freedraw').locator('..').click();
  await page.mouse.move(x + 15, y + 100); await page.mouse.down();
  for (const [dx, dy] of [[45, 75], [80, 110], [125, 85], [175, 100]]) await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
  await drawing(page).getByTestId('toolbar-text').locator('..').click();
  await canvas(page).click({ position: { x: 230, y: box.height * .58 + 145 } });
  await page.keyboard.insertText(note); await page.keyboard.press('Escape');
  await expect(panel(page)).toBeVisible();
  await expect.poll(async () => (await readDrawing(page))?.scene.elements.filter(element => !element.isDeleted).map(element => element.type)).toEqual(expect.arrayContaining(['rectangle', 'freedraw', 'text']));
  await expect(drawing(page).getByText('绘图已保存', { exact: true })).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await expect(panel(page)).toBeVisible();
  const saved = (await readDrawing(page))!;
  expect(saved.ref.assetId).toBe(`drawing-${saved.hash}`);
  expect(saved.ref.hash).toBe(saved.hash);
  expect(saved.scene.elements.some(element => element.type === 'text' && !element.isDeleted && element.text === note)).toBe(true);
  return saved;
}

async function openResource(page: Page, kind: 'card' | 'document') {
  await drawing(page).getByTestId('toolbar-selection').locator('..').click();
  const title = kind === 'card' ? '相关性是检索收益的前提' : 'Adaptive Retrieval: Evidence & Reliability';
  const resource = drawing(page).getByRole('article', { name: `白板资料：${title}`, exact: true });
  await expect(resource).toBeVisible();
  const box = (await resource.boundingBox())!;
  await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
  await expect(drawing(page).getByRole('button', { name: '右侧打开', exact: true })).toBeVisible();
  await expect(drawing(page).locator('.excalidraw-hyperlinkContainer:has([href^="papertrail://placement/"], [value^="papertrail://placement/"])')).toBeHidden();
  await drawing(page).getByRole('button', { name: '右侧打开', exact: true }).click();
  if (kind === 'card') await expect(panel(page).getByLabel('卡片标题', { exact: true })).toHaveValue(title);
  else await expect(panel(page).getByLabel('PDF 阅读器 参考面板', { exact: true }).locator('canvas').first()).toBeVisible();
  await expect(canvas(page)).toBeVisible();
}

test('真实手绘、文字与共享资料共存，切换布局、研究和刷新后恢复并保留绘图历史', async ({ page }) => {
  const fixture = await start(page);
  let saved = await draw(page);
  const drawnCount = saved.scene.elements.filter(element => !element.isDeleted && ['rectangle', 'freedraw', 'text'].includes(element.type) && !element.customData?.boardRelation).length;
  const freeElements = async () => (await readDrawing(page))!.scene.elements.filter(element => !element.isDeleted && ['rectangle', 'freedraw', 'text'].includes(element.type) && !element.customData?.boardRelation).length;
  await drawing(page).locator('.excalidraw').press('ControlOrMeta+z');
  await expect.poll(freeElements).toBe(drawnCount - 1);
  await drawing(page).locator('.excalidraw').press('ControlOrMeta+Shift+z');
  await expect.poll(freeElements).toBe(drawnCount);
  await openResource(page, 'card');
  const beforeRemoval = await data(page);
  await drawing(page).locator('.excalidraw').press('Delete');
  await expect.poll(async () => (await data(page)).placements['placement-a']).toBeUndefined();
  expect((await data(page)).cards['card-a']).toEqual(beforeRemoval.cards['card-a']);
  expect((await data(page)).edges['edge-a']).toBeUndefined();
  await drawing(page).locator('.excalidraw').press('ControlOrMeta+z');
  await expect.poll(async () => (await data(page)).placements['placement-a']).toEqual(beforeRemoval.placements['placement-a']);
  expect((await data(page)).edges['edge-a']).toEqual(beforeRemoval.edges['edge-a']);
  await expect(drawing(page).getByText('绘图已保存', { exact: true })).toBeVisible();
  saved = (await readDrawing(page))!;
  await openResource(page, 'document');
  expect((await readDrawing(page))!.ref).toEqual(saved.ref);
  await main(page).getByRole('button', { name: '卡片布局', exact: true }).click();
  await expect(main(page).locator('[data-placement-id="placement-a"]')).toBeVisible();
  await main(page).getByRole('button', { name: '绘图', exact: true }).click();
  await expect(canvas(page)).toBeVisible();
  expect((await readDrawing(page))!.ref).toEqual(saved.ref);
  await switchResearch(page, 'research-b');
  expect((await data(page)).boards['board-b'].drawing).toBeUndefined();
  await switchResearch(page, 'research-a');
  await expect(canvas(page)).toBeVisible();
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  expect((await data(page)).sessions['research-a'].boardModes?.['board-a']).toBe('draw');
  expect((await readDrawing(page))!.ref).toEqual(saved.ref);
  await main(page).getByRole('button', { name: '白板版本历史', exact: true }).click();
  const history = main(page).getByRole('region', { name: '白板版本历史', exact: true });
  await expect(history.getByRole('button', { name: /编辑白板绘图/ }).first()).toBeVisible();
  await history.getByRole('button', { name: /编辑白板绘图/ }).first().click();
  await expect(history.getByRole('heading', { name: '修改前', exact: true })).toBeVisible();
  await expect(history.getByRole('heading', { name: '修改后', exact: true })).toBeVisible();
  const latest = Object.values((await data(page)).boardChanges ?? {}).filter(change => change.boardId === 'board-a').sort((a, b) => b.revision - a.revision)[0];
  await history.getByRole('button', { name: '恢复此次变更前', exact: true }).click();
  await expect.poll(async () => (await data(page)).boards['board-a'].drawing).toEqual(latest.before!.board.drawing);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  expect(fixture.unexpected).toEqual([]);
});

test('层级节点在绘图中移出后保留子分支，撤销时恢复父子关系', async ({ page }) => {
  await start(page, true);
  await openResource(page, 'card');
  await drawing(page).locator('.excalidraw').press('Delete');
  await expect.poll(async () => (await data(page)).placements['placement-a']).toBeUndefined();
  expect((await data(page)).placements['drawing-pdf'].parentPlacementId).toBeUndefined();
  expect((await data(page)).boards['board-a'].layout).toBe('tree');
  await drawing(page).locator('.excalidraw').press('ControlOrMeta+z');
  await expect.poll(async () => (await data(page)).placements['drawing-pdf'].parentPlacementId).toBe('placement-a');
  await main(page).getByRole('button', { name: '卡片布局', exact: true }).click();
  await expect(main(page).getByRole('button', { name: '大纲与节点', exact: true })).toBeVisible();
  await expect(main(page).locator('[data-placement-id="placement-a"]')).toBeVisible();
});

test('同板的绘图视口与模式在分栏内独立并刷新恢复', async ({ page }) => {
  await start(page);
  const left = pane(page, 1), right = await split(page, left, '下');
  await expect(right.getByLabel('白板自由绘图', { exact: true })).toBeVisible();
  await right.getByLabel('白板自由绘图', { exact: true }).locator('.excalidraw').press('ControlOrMeta+=');
  const views = async () => groups((await layout(page)).root).map(group => {
    const value = group.tabs.find(tab => tab.id === group.activeTabId)?.viewState?.['drawing:board-a'];
    return typeof value === 'string' ? JSON.parse(value).scale as number : .75;
  });
  await expect.poll(async () => (await views())[1]).toBeGreaterThan(.75);
  expect((await views())[0]).toBe(.75);
  await left.getByRole('button', { name: '卡片布局', exact: true }).click();
  await expect(left.locator('.board-viewport')).toBeVisible();
  await expect(right.getByLabel('白板自由绘图', { exact: true })).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  const before = await views();
  await page.reload();
  await expect(left.locator('.board-viewport')).toBeVisible();
  await expect(right.getByLabel('白板自由绘图', { exact: true })).toBeVisible();
  expect(await views()).toEqual(before);
});

test('同板只保留一个绘图编辑者，关闭后先加载已保存内容再接管且两次绘图均保留', async ({ page }) => {
  await start(page);
  const first = await draw(page);
  const firstIds = first.scene.elements.filter(element => !element.isDeleted && !element.customData?.boardRelation).map(element => element.id);
  const left = pane(page, 1), right = await split(page, left, '下');
  const secondDrawing = right.getByLabel('白板自由绘图', { exact: true });
  await expect(secondDrawing).toHaveAttribute('data-editable', 'false');
  await expect(secondDrawing.getByText(/此白板正在另一窗格编辑/)).toBeVisible();
  await expect(secondDrawing.getByTestId('toolbar-rectangle')).toBeHidden();
  await mkdir('docs/verification/main-integration', { recursive: true });
  await page.screenshot({ path: 'docs/verification/main-integration/drawing-two-panes.png' });
  const preview = secondDrawing.locator('canvas.interactive'), previewBox = (await preview.boundingBox())!;
  await page.mouse.move(previewBox.x + 200, previewBox.y + 120);
  await page.mouse.down(); await page.mouse.move(previewBox.x + 280, previewBox.y + 180, { steps: 8 }); await page.mouse.up();
  expect((await readDrawing(page))!.ref).toEqual(first.ref);
  await paneAction(page, left, '关闭窗格');
  await expect(secondDrawing).toHaveAttribute('data-editable', 'true');
  await expect(secondDrawing.getByTestId('toolbar-rectangle')).toBeVisible();
  const box = (await secondDrawing.locator('canvas.interactive').boundingBox())!;
  await secondDrawing.getByTestId('toolbar-rectangle').locator('..').click();
  await page.mouse.move(box.x + box.width - 220, box.y + box.height - 220);
  await page.mouse.down(); await page.mouse.move(box.x + box.width - 100, box.y + box.height - 140, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await readDrawing(page))?.scene.elements.filter(element => !element.isDeleted).length).toBeGreaterThan(first.scene.elements.filter(element => !element.isDeleted).length);
  const second = (await readDrawing(page))!;
  expect(second.scene.elements.filter(element => !element.isDeleted).map(element => element.id)).toEqual(expect.arrayContaining(firstIds));
  expect(second.scene.elements.some(element => element.type === 'text' && !element.isDeleted && element.text === note)).toBe(true);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  expect((await readDrawing(page))!.ref).toEqual(second.ref);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`绘图与右侧AI、原文三尺寸可用且无页面横溢出 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await start(page), saved = await draw(page);
    await drawing(page).locator('.excalidraw').press('Escape');
    const bounds = (await canvas(page).boundingBox())!;
    await canvas(page).click({ position: { x: bounds.width - 80, y: bounds.height - 100 } });
    await expect(drawing(page).locator('.selected-shape-actions')).toBeHidden();
    await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('结合这条原文，核对图中的适用边界。');
    await expect(canvas(page)).toBeInViewport();
    for (const control of [main(page).getByRole('button', { name: '卡片布局', exact: true }), main(page).getByRole('button', { name: '添加资料', exact: true }), main(page).getByRole('button', { name: '白板版本历史', exact: true })]) await expect(control).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    await expect(page.locator('.project-file-compact')).toContainText('目录文件已更新');
    await mkdir('docs/verification/drawing', { recursive: true });
    await page.screenshot({ path: `docs/verification/drawing/board-${viewport.width}.png` });
    await openResource(page, 'document');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect((await readDrawing(page))!.ref).toEqual(saved.ref);
    if (viewport.width === 1440) await page.screenshot({ path: 'docs/verification/drawing/board-source-1440.png' });
    expect(fixture.unexpected).toEqual([]);
  });
}
