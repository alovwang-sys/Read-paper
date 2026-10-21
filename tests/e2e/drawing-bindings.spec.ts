import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { DrawingScene } from '../../src/domain/drawing';
import type { WorkspaceData } from '../../src/domain/types';
import { mockProjectService } from './project-fixture';

const shots = 'docs/verification/drawing-bindings/screenshots';
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const drawing = (page: Page) => main(page).getByLabel('白板自由绘图', { exact: true });
const canvas = (page: Page) => drawing(page).locator('canvas.interactive');
const article = (page: Page, kind: 'card' | 'document') => drawing(page).getByRole('article', { name: `白板资料：${kind === 'card' ? '相关性是检索收益的前提' : 'Adaptive Retrieval: Evidence & Reliability'}`, exact: true });
type Element = DrawingScene['elements'][number];
type Arrow = Extract<Element, { type: 'arrow' }>;

async function data(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => { const path = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/services/workspace.ts') ?? '/src/services/workspace.ts'; return (await import(path)).workspace.getState().data; });
}
async function scene(page: Page): Promise<DrawingScene | undefined> {
  return page.evaluate(async () => {
    const paths = performance.getEntriesByType('resource').map(entry => entry.name);
    const loaded = (path: string) => paths.find(name => new URL(name).pathname === path) ?? path;
    const { workspace } = await import(loaded('/src/services/workspace.ts'));
    const ref = workspace.getState().data.boards['board-a'].drawing;
    if (!ref) return undefined;
    const asset = await (await import(loaded('/src/data/storage.ts'))).getAsset(ref.assetId);
    if (!asset) throw new Error('Saved drawing asset is missing');
    return (await import(loaded('/src/domain/drawing.ts'))).parseDrawingScene(await asset.text());
  });
}
const arrows = async (page: Page) => ((await scene(page))?.elements ?? []).filter((element): element is Arrow => element.type === 'arrow' && !element.isDeleted && !element.customData?.boardRelation);

async function start(page: Page, agentWorkbench = false) {
  await page.routeWebSocket('**', () => {});
  const seed = createSeed();
  seed.agentWorkbench = agentWorkbench;
  seed.sessions['research-a'].active = { kind: 'board', id: 'board-a' };
  seed.sessions['research-a'].openItems = [{ kind: 'board', id: 'board-a' }];
  seed.sessions['research-a'].viewports['drawing:board-a'] = { x: 0, y: 0, scale: .75 };
  seed.sessions['research-a'].panel = { ...seed.sessions['research-a'].panel, open: true, mode: 'ai', aiMode: 'demo' };
  seed.conversations['conversation-research-a'].connectionId = 'demo';
  seed.conversations['conversation-research-a'].contextIds = ['evidence-a'];
  seed.conversations['conversation-research-a'].input = '核对卡片与图形之间的关系。';
  if (agentWorkbench) {
    seed.sessions['research-a'].agentWorkbenchStarted = true;
    seed.sessions['research-a'].panel.open = false;
    seed.sessions['research-a'].panel.aiView = 'history';
    seed.conversations['conversation-research-a'].connectionId = 'codex';
    seed.conversations['conversation-research-a'].contextIds = [];
  }
  delete seed.placements['placement-b']; delete seed.placements['placement-c'];
  seed.placements['placement-a'].x = 250; seed.placements['placement-a'].y = 130;
  seed.placements['drawing-pdf'] = { id: 'drawing-pdf', boardId: 'board-a', resourceRef: { kind: 'document', id: 'paper-a' }, x: 540, y: 130, group: '原文' };
  delete seed.edges['edge-a'];
  await mockProjectService(page, { seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: '连线验收 · 模拟连接', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/research/capabilities', route => route.fulfill({ json: { connections: [{ id: 'codex', research: true, detail: '绘图绑定测试，未调用真实 Agent。' }] } }));
  await page.goto('/');
  await main(page).getByRole('button', { name: '绘图', exact: true }).click();
  await expect(canvas(page)).toBeVisible();
  await expect(article(page, 'card')).toBeVisible();
  await mkdir(shots, { recursive: true });
}
async function tool(page: Page, name: 'selection' | 'rectangle' | 'arrow') {
  await drawing(page).getByTestId(`toolbar-${name}`).locator('..').click();
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 18 }); await page.mouse.up();
}
async function rectangle(page: Page) {
  const box = (await canvas(page).boundingBox())!;
  await tool(page, 'rectangle');
  await drag(page, { x: box.x + box.width * .55, y: box.y + box.height * .63 }, { x: box.x + box.width * .55 + 130, y: box.y + box.height * .63 + 80 });
  await expect.poll(async () => (await scene(page))?.elements.filter(element => element.type === 'rectangle' && !element.isDeleted).length).toBe(1);
  return (await scene(page))!.elements.find(element => element.type === 'rectangle' && !element.isDeleted)!;
}
async function screenPoint(page: Page, element: Element, location: 'center' | 'left' | 'right' | 'top' | 'bottom' = 'center') {
  const current = (await scene(page))!, box = (await canvas(page).boundingBox())!;
  const x = element.x + (location === 'left' ? 2 : location === 'right' ? element.width - 2 : element.width / 2);
  const y = element.y + (location === 'top' ? 2 : location === 'bottom' ? element.height - 2 : element.height / 2);
  return { x: box.x + (x + current.appState.scrollX) * current.appState.zoom.value, y: box.y + (y + current.appState.scrollY) * current.appState.zoom.value };
}
async function drawArrow(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const count = (await arrows(page)).length;
  await tool(page, 'arrow'); await drag(page, from, to);
  await expect.poll(async () => (await arrows(page)).length).toBe(count + 1);
  return (await arrows(page)).at(-1)!;
}
const geometry = (element: Element) => ({ x: element.x, y: element.y, ...(element.type === 'arrow' ? { points: element.points } : {}) });
async function resources(page: Page) {
  const elements = (await scene(page))!.elements;
  return {
    card: elements.find(element => element.customData?.placementId === 'placement-a' && !element.isDeleted)!,
    document: elements.find(element => element.customData?.placementId === 'drawing-pdf' && !element.isDeleted)!,
  };
}
async function moveResource(page: Page, kind: 'card' | 'document') {
  await tool(page, 'selection');
  const box = (await article(page, kind).boundingBox())!;
  await drag(page, { x: box.x + box.width - 5, y: box.y + box.height * .3 }, { x: box.x + box.width - 5 + 42, y: box.y + box.height * .3 + 38 });
}

test('卡片与论文可和手绘矩形双向连线，移动跟随、刷新、删除与撤销保留共享资料', async ({ page }) => {
  await start(page); const shape = await rectangle(page), initialResources = await resources(page);
  const connected: Arrow[] = [];
  for (const resource of [initialResources.card, initialResources.document]) {
    const forward = await drawArrow(page, await screenPoint(page, resource, 'right'), await screenPoint(page, shape, 'left'));
    expect(forward.startBinding?.elementId).toBe(resource.id); expect(forward.endBinding?.elementId).toBe(shape.id); connected.push(forward);
    const reverse = await drawArrow(page, await screenPoint(page, shape, 'right'), await screenPoint(page, resource, 'left'));
    expect(reverse.startBinding?.elementId).toBe(shape.id); expect(reverse.endBinding?.elementId).toBe(resource.id); connected.push(reverse);
  }
  const before = await data(page), firstGeometry = geometry(connected[0]);
  await moveResource(page, 'card');
  await expect.poll(async () => (await data(page)).placements['placement-a'].x).not.toBe(before.placements['placement-a'].x);
  await expect.poll(async () => geometry((await arrows(page))[0])).not.toEqual(firstGeometry);
  const beforeShapeScene = await scene(page);
  const beforeShapeMove = (await arrows(page)).map(geometry);
  await tool(page, 'selection');
  const shapePoint = await screenPoint(page, shape, 'bottom');
  await drag(page, shapePoint, { x: shapePoint.x + 35, y: shapePoint.y + 34 });
  await expect.poll(async () => (await scene(page))!.elements.find(element => element.id === shape.id)!.x).not.toBe(shape.x);
  const saved = await arrows(page);
  await writeFile(`${shots}/movement-observation.json`, JSON.stringify({ beforeShapeScene, afterShapeScene: await scene(page) }, null, 2));
  for (const [index, arrow] of saved.entries()) { expect(geometry(arrow)).not.toEqual(beforeShapeMove[index]); expect(arrow.startBinding?.elementId).toBe(connected[index].startBinding?.elementId); expect(arrow.endBinding?.elementId).toBe(connected[index].endBinding?.elementId); }
  await expect(drawing(page).getByText('绘图已保存', { exact: true })).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.reload(); await expect(canvas(page)).toBeVisible();
  expect((await arrows(page)).map(geometry)).toEqual(saved.map(geometry));
  await tool(page, 'selection');
  const cardBox = (await article(page, 'card').boundingBox())!;
  await page.mouse.click(cardBox.x + 5, cardBox.y + cardBox.height * .6);
  await expect(drawing(page).locator('.drawing-resource-actions')).toContainText('相关性是检索收益的前提');
  await drawing(page).locator('.excalidraw').press('Delete');
  await expect.poll(async () => (await data(page)).placements['placement-a']).toBeUndefined();
  expect((await data(page)).cards['card-a']).toEqual(before.cards['card-a']);
  expect((await data(page)).documents['paper-a']).toEqual(before.documents['paper-a']);
  await drawing(page).locator('.excalidraw').press('ControlOrMeta+z');
  await expect.poll(async () => (await data(page)).placements['placement-a']).toBeDefined();
  const restored = await arrows(page);
  expect(restored.map(arrow => [arrow.startBinding?.elementId, arrow.endBinding?.elementId])).toEqual(saved.map(arrow => [arrow.startBinding?.elementId, arrow.endBinding?.elementId]));
  await page.screenshot({ path: `${shots}/bound-arrows-restored-1440.png` });
});

test('真实画箭头：卡片与手绘矩形的边框及内部均建立绑定', async ({ page }) => {
  await start(page); const shape = await rectangle(page);
  const card = (await scene(page))!.elements.find(element => element.customData?.placementId === 'placement-a')!;
  const report: unknown[] = [];
  for (const location of ['right', 'center'] as const) {
    await tool(page, 'selection');
    const box = (await article(page, 'card').boundingBox())!;
    await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
    const count = (await arrows(page)).length;
    const from = await screenPoint(page, card, location), to = await screenPoint(page, shape, location === 'right' ? 'left' : 'center');
    await tool(page, 'arrow'); await drag(page, from, to);
    await expect(drawing(page).getByText('绘图已保存', { exact: true })).toBeVisible();
    const created = await arrows(page);
    report.push({ location, from, to, previousCount: count, nextCount: created.length, arrow: created.at(-1), scene: await scene(page) });
    await writeFile(`${shots}/binding-observation.json`, JSON.stringify(report, null, 2));
    await page.screenshot({ path: `${shots}/binding-observation-1440-${location}.png` });
  }
  const reverse = await drawArrow(page, await screenPoint(page, shape), await screenPoint(page, card));
  report.push({ location: 'reverse-center', arrow: reverse });
  await writeFile(`${shots}/binding-observation.json`, JSON.stringify(report, null, 2));
  await page.screenshot({ path: `${shots}/binding-observation-1440.png` });
  for (const { arrow, previousCount, nextCount } of report as { arrow: Arrow; previousCount: number; nextCount: number }[]) {
    if (previousCount !== undefined) expect(nextCount).toBe(previousCount + 1);
    if (arrow.id === reverse.id) { expect(arrow.startBinding?.elementId).toBe(shape.id); expect(arrow.endBinding?.elementId).toBe(card.id); continue; }
    expect(arrow.startBinding?.elementId).toBe(card.id);
    expect(arrow.endBinding?.elementId).toBe(shape.id);
  }
  const count = (await arrows(page)).length;
  await drawing(page).locator('.excalidraw').press('ControlOrMeta+z');
  await expect.poll(async () => (await arrows(page)).length).toBe(count - 1);
  expect((await arrows(page)).some(arrow => arrow.id === reverse.id)).toBe(false);
  await drawing(page).locator('.excalidraw').press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await arrows(page)).length).toBe(count);
  await expect.poll(async () => {
    const current = (await scene(page))!.elements;
    const restored = current.find(element => element.id === reverse.id) as Arrow;
    return {
      start: restored.startBinding?.elementId, end: restored.endBinding?.elementId,
      card: current.find(element => element.id === card.id)!.boundElements?.some(item => item.id === reverse.id) ?? false,
      shape: current.find(element => element.id === shape.id)!.boundElements?.some(item => item.id === reverse.id) ?? false,
    };
  }).toEqual({ start: shape.id, end: card.id, card: true, shape: true });
  await writeFile(`${shots}/binding-history-observation.json`, JSON.stringify({ reverseBeforeUndo: reverse, restoredScene: await scene(page) }, null, 2));
  await page.screenshot({ path: `${shots}/binding-history-restored-1440.png` });
});

test('在卡片布局移动后回到绘图，绑定端点跟随同一份摆放数据', async ({ page }) => {
  await start(page); const shape = await rectangle(page), { card } = await resources(page);
  const arrow = await drawArrow(page, await screenPoint(page, card, 'right'), await screenPoint(page, shape, 'left'));
  expect(arrow.startBinding?.elementId).toBe(card.id);
  const before = await data(page);
  await main(page).getByRole('button', { name: '卡片布局', exact: true }).click();
  const item = main(page).locator('[data-placement-id="placement-a"]');
  await expect(item).toBeVisible();
  const box = (await item.boundingBox())!;
  await drag(page, { x: box.x + box.width / 2, y: box.y + 20 }, { x: box.x + box.width / 2 + 60, y: box.y + 70 });
  await expect.poll(async () => (await data(page)).placements['placement-a'].x).not.toBe(before.placements['placement-a'].x);
  await main(page).getByRole('button', { name: '绘图', exact: true }).click();
  await expect(canvas(page)).toBeVisible();
  // Reopening synchronizes placements in memory; a new visible shape commits that scene before inspection.
  const bounds = (await canvas(page).boundingBox())!;
  await tool(page, 'rectangle');
  await drag(page, { x: bounds.x + bounds.width - 110, y: bounds.y + bounds.height - 140 }, { x: bounds.x + bounds.width - 70, y: bounds.y + bounds.height - 105 });
  await expect.poll(async () => (await scene(page))?.elements.filter(element => element.type === 'rectangle' && !element.isDeleted).length).toBe(2);
  await expect.poll(async () => (await resources(page)).card.x).toBe((await data(page)).placements['placement-a'].x);
  const moved = (await arrows(page))[0];
  await writeFile(`${shots}/cross-mode-observation.json`, JSON.stringify({ before: arrow, after: moved, placement: (await data(page)).placements['placement-a'] }, null, 2));
  await page.screenshot({ path: `${shots}/cross-mode-1440.png` });
  expect(moved.startBinding?.elementId).toBe(card.id); expect(moved.endBinding?.elementId).toBe(shape.id);
  expect(geometry(moved)).not.toEqual(geometry(arrow));
});

test('连线白板与 AI 输入、右侧原文在三个尺寸可达且无横向溢出', async ({ page }) => {
  await start(page); const shape = await rectangle(page), { card } = await resources(page);
  const arrow = await drawArrow(page, await screenPoint(page, card, 'right'), await screenPoint(page, shape, 'left'));
  expect(arrow.startBinding?.elementId).toBe(card.id); expect(arrow.endBinding?.elementId).toBe(shape.id);
  await drawing(page).locator('.excalidraw').press('Escape');
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('核对卡片与图形之间的关系。');
    await expect(panel(page).getByLabel('向 AI 提问')).toBeInViewport({ ratio: 1 });
    await expect(canvas(page)).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `${shots}/bound-board-ai-${width}.png` });
    await tool(page, 'selection');
    const paper = (await article(page, 'document').boundingBox())!;
    await page.mouse.click(paper.x + 5, paper.y + paper.height * .6);
    await drawing(page).getByRole('button', { name: '右侧打开', exact: true }).click();
    await expect(panel(page).getByLabel('PDF 阅读器 参考面板', { exact: true }).locator('canvas').first()).toBeVisible();
    await expect(canvas(page)).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `${shots}/bound-board-source-${width}.png` });
  }
});

test('Agent 工作台中绘图绑定与右侧原文共存，三个尺寸保留唯一研究输入和发送入口', async ({ page }) => {
  await start(page, true);
  const input = page.getByRole('textbox', { name: '研究目标', exact: true });
  const prompt = '核对卡片与图形之间的关系，保留这段尚未发送的研究目标。';
  await expect(input).toHaveCount(1); await input.fill(prompt);
  const shape = await rectangle(page), { card } = await resources(page);
  const arrow = await drawArrow(page, await screenPoint(page, card), await screenPoint(page, shape));
  expect(arrow.startBinding?.elementId).toBe(card.id); expect(arrow.endBinding?.elementId).toBe(shape.id);
  await expect(input).toHaveValue(prompt);
  await tool(page, 'selection');
  const paper = (await article(page, 'document').boundingBox())!;
  await page.mouse.click(paper.x + 5, paper.y + paper.height * .6);
  await drawing(page).getByRole('button', { name: '右侧打开', exact: true }).click();
  const original = panel(page).getByLabel('PDF 阅读器 参考面板', { exact: true }).locator('canvas').first();
  await expect(original).toBeVisible();
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await drawing(page).locator('.excalidraw').press('Shift+1');
    if (width < 1440) {
      await drawing(page).locator('.excalidraw').press('ControlOrMeta+-');
      await drawing(page).locator('.excalidraw').press('ControlOrMeta+-');
    }
    await expect(canvas(page)).toBeInViewport();
    await expect(article(page, 'card')).toBeInViewport({ ratio: .99 });
    await expect(article(page, 'document')).toBeInViewport({ ratio: .99 });
    await expect(original).toBeVisible();
    await expect(input).toHaveCount(1); await expect(input).toHaveValue(prompt);
    await expect(input).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: '开始研究', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '开始研究', exact: true })).toBeInViewport({ ratio: 1 });
    expect((await data(page)).agentWorkbench).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `${shots}/agent-board-source-${width}.png` });
  }
});
