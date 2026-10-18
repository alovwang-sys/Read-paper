import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import { mockProjectService } from './project-fixture';
import { openResearchNavigation, switchResearch } from './knowledge-helpers';
import { main, panel, saved, state } from './workspace-split-helpers';

const evidence = 'docs/verification/sidebar-update';
const sidebar = (page: Page) => page.getByRole('complementary', { name: '左侧导航', exact: true });
const handle = (page: Page) => page.getByRole('separator', { name: '调整左侧宽度', exact: true });
const width = (page: Page) => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().width);
const rightHandle = (page: Page) => page.getByRole('separator', { name: '调整右侧宽度', exact: true });
const rightWidth = (page: Page) => panel(page).evaluate(element => element.getBoundingClientRect().width);

async function boot(page: Page, sidebarWidth?: number, withAnswer = false) {
  const seed = createSeed();
  seed.sidebarWidth = sidebarWidth;
  seed.sessions['research-a'].panel.mode = 'ai';
  seed.drafts['draft-a'].title = '研究结论';
  for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'demo';
  if (withAnswer) {
    seed.conversations['conversation-research-a'].requestIds = ['sidebar-example'];
    seed.requests['sidebar-example'] = { id: 'sidebar-example', researchId: 'research-a', conversationId: 'conversation-research-a', prompt: '比较实验结论时，应该先核对哪些条件？', context: [], createdAt: '2026-10-18T12:00:00.000Z', status: 'done', body: '先列出两篇论文共同回答的问题，再比较证据语料、模型版本和评估方式。只有这些条件接近时，结果才适合直接对照。\n\n阅读时可以把“作者报告的结果”和“我们对适用范围的判断”分别记下。后者应保留条件，遇到缺少依据的地方，先留下待核查问题。\n\n这段文字是界面验收用的确定性示例，没有调用模型，也没有引用未提供的原文。', evidenceIds: [], mode: 'demo', connectionId: 'demo' };
  }
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: true, model: 'sidebar-fixture', mode: 'demo' } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/chat', () => { throw new Error('Sidebar tests must not contact a model'); });
  await page.goto('/'); await expect(main(page)).toBeVisible(); await saved(page);
}

async function dragWidth(page: Page, x: number) {
  const bounds = (await handle(page).boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 150);
  await page.mouse.down(); await page.mouse.move(x, bounds.y + 150, { steps: 14 }); await page.mouse.up();
}

async function dragRightWidth(page: Page, target: number) {
  const bounds = (await rightHandle(page).boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 160);
  await page.mouse.down(); await page.mouse.move(page.viewportSize()!.width - target, bounds.y + 160, { steps: 16 }); await page.mouse.up();
}

async function bodyFits(page: Page) {
  await expect.poll(() => page.locator('.main-column').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(319.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect.poll(async () => Number(await rightHandle(page).getAttribute('aria-valuenow'))).toBeCloseTo(await rightWidth(page), 0);
}

test('可点击的白板与文稿快捷项有一致图标，分组标题仍为文字', async ({ page }) => {
  await boot(page);
  for (const name of ['研究主页', '资料', '摘录', '卡片', '白板', '证据与论证', '文稿', '研究结论', '资料库', '设置']) {
    await expect(sidebar(page).getByRole('button', { name, exact: true }).locator('svg')).toHaveCount(1);
  }
  await expect(sidebar(page).locator('.sidebar-section-label')).toHaveText(['阅读', '思考与写作']);
  await expect(sidebar(page).locator('.sidebar-section-label svg')).toHaveCount(0);
  await sidebar(page).getByRole('button', { name: '证据与论证', exact: true }).click();
  await expect(main(page).getByRole('tab', { name: '证据与论证', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(main(page).locator('.board-viewport')).toBeVisible();
  await sidebar(page).getByRole('button', { name: '研究结论', exact: true }).click();
  await main(page).getByLabel('结论正文', { exact: true }).fill('左栏调整不应丢失这段研究结论。');
  await panel(page).getByLabel('向 AI 提问').fill('保留未发送的问题');
  await dragWidth(page, 500);
  await expect.poll(() => width(page)).toBe(500);
  await switchResearch(page, 'research-b'); await switchResearch(page, 'research-a');
  await expect(main(page).getByLabel('结论正文', { exact: true })).toHaveValue('左栏调整不应丢失这段研究结论。');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('保留未发送的问题');
  await expect.poll(() => width(page)).toBe(500); await saved(page);
  await mkdir(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/sidebar-writing-1440.png` });
  await page.reload();
  await expect(main(page).getByLabel('结论正文', { exact: true })).toHaveValue('左栏调整不应丢失这段研究结论。');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('保留未发送的问题');
});

test('左栏真实拖宽、键盘、刷新与收起展开保留偏好，双击还原', async ({ page }) => {
  await boot(page);
  await expect.poll(() => width(page)).toBe(240);
  await dragWidth(page, 500); await expect.poll(() => width(page)).toBe(500);
  await handle(page).focus(); await page.keyboard.press('ArrowRight'); await expect.poll(() => width(page)).toBe(510);
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '510');
  await expect(handle(page)).toHaveAttribute('aria-valuemin', '200');
  await page.keyboard.press('Shift+ArrowLeft'); await expect.poll(() => width(page)).toBe(470);
  await saved(page); await page.reload(); await expect.poll(() => width(page)).toBe(470);
  expect((await state(page)).sidebarWidth).toBe(470);
  await sidebar(page).getByRole('button', { name: '收起左栏', exact: true }).click(); await expect(sidebar(page)).toBeHidden();
  await page.getByRole('button', { name: '展开左栏', exact: true }).click(); await expect.poll(() => width(page)).toBe(470);
  await handle(page).dblclick(); await expect.poll(() => width(page)).toBe(240);
  await handle(page).focus(); await page.keyboard.press('Home'); await expect.poll(() => width(page)).toBe(200);
  await page.keyboard.press('ArrowLeft'); await expect.poll(() => width(page)).toBe(200);
  await saved(page);
});

test('左栏随窗口和右侧 AI 保留正文空间，不沿用旧的固定上限', async ({ page }) => {
  await boot(page);
  await mkdir(evidence, { recursive: true });
  for (const [viewportWidth, viewportHeight] of [[1440, 900], [1280, 800]]) {
    await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
    await handle(page).focus(); await page.keyboard.press('End');
    await expect.poll(() => width(page)).toBeGreaterThan(240);
    await expect.poll(async () => Number(await handle(page).getAttribute('aria-valuenow'))).toBeCloseTo(await width(page), 0);
    const sizes = await page.evaluate(() => ({ sidebar: document.querySelector('.sidebar')!.getBoundingClientRect().width, body: document.querySelector('.main-column')!.getBoundingClientRect().width, right: document.querySelector('.inspector')!.getBoundingClientRect().width, total: document.documentElement.scrollWidth }));
    expect(sizes.body).toBeGreaterThanOrEqual(319.5); expect(sizes.right).toBeGreaterThanOrEqual(420);
    expect(sizes.sidebar + sizes.body + sizes.right).toBeLessThanOrEqual(viewportWidth + 1); expect(sizes.total).toBeLessThanOrEqual(viewportWidth);
    await saved(page); await page.screenshot({ path: `${evidence}/sidebar-ai-${viewportWidth}.png` });
    await page.getByRole('button', { name: '关闭右侧面板', exact: true }).click();
    await dragWidth(page, viewportWidth - 325); await expect.poll(() => width(page)).toBeGreaterThan(viewportWidth - 350);
    await page.getByRole('button', { name: '展开右侧面板', exact: true }).click();
    await expect(panel(page)).toBeVisible();
    await expect.poll(() => page.locator('.main-column').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(319.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewportWidth);
  }
});

test('大宽度偏好在 1024 导航抽屉仍适配，抽屉不显示拖宽控件', async ({ page }) => {
  await boot(page, 1200); await page.setViewportSize({ width: 1024, height: 800 });
  await page.getByRole('button', { name: '关闭右侧面板', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeHidden(); await expect(handle(page)).toHaveCount(0);
  const navigation = await openResearchNavigation(page);
  await expect(navigation).toHaveAttribute('role', 'dialog');
  await expect.poll(() => width(page)).toBeLessThanOrEqual(984);
  await expect(navigation.getByRole('button', { name: '证据与论证', exact: true }).locator('svg')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  await mkdir(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/sidebar-drawer-1024.png` });
  await navigation.getByRole('button', { name: '研究结论', exact: true }).click();
  await expect(navigation).toBeHidden(); await expect(main(page).getByLabel('结论正文', { exact: true })).toBeVisible();
  await saved(page); await page.reload(); await expect(page.locator('.sidebar')).toBeHidden();
  expect((await state(page)).sidebarWidth).toBe(1200);
});

test('右栏三尺寸真实拖宽越过旧上限，并以实际可用空间作为边界', async ({ page }) => {
  await boot(page, undefined, true);
  await sidebar(page).getByRole('button', { name: '研究结论', exact: true }).click();
  await main(page).getByLabel('结论正文', { exact: true }).fill('证据与论证\n\n先核对材料的相关性，再判断检索是否改善回答；可靠性结论应保留来源和适用条件。');
  await panel(page).getByLabel('向 AI 提问').fill('请比较两篇论文的实验条件：\n1. 证据语料是否与问题相关？\n2. 对照组是否使用相同模型？\n3. 哪些结论仍需要返回原文核查？');
  await mkdir(evidence, { recursive: true });
  for (const [viewportWidth, viewportHeight, desiredWidth] of [[1440, 900, 800], [1280, 800, 700], [1024, 800, 650]]) {
    await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
    await dragRightWidth(page, desiredWidth);
    await expect.poll(() => rightWidth(page)).toBe(desiredWidth); await bodyFits(page); await saved(page);
    await page.screenshot({ path: `${evidence}/right-panel-${viewportWidth}.png` });
    await rightHandle(page).focus(); await page.keyboard.press('End'); await bodyFits(page);
    const maximum = Number(await rightHandle(page).getAttribute('aria-valuemax'));
    await expect.poll(() => rightWidth(page)).toBeCloseTo(maximum, 0);
    expect(maximum).toBeGreaterThan(viewportWidth === 1024 ? viewportWidth * .42 : 520);
    await dragRightWidth(page, 200); await expect.poll(() => rightWidth(page)).toBe(420); await bodyFits(page);
    await dragRightWidth(page, desiredWidth);
  }
});

test('右栏宽度键盘调整、重置、切模式与刷新保留正文和 AI 草稿', async ({ page }) => {
  await boot(page);
  await sidebar(page).getByRole('button', { name: '研究结论', exact: true }).click();
  await main(page).getByLabel('结论正文', { exact: true }).fill('右栏调整后仍保留的结论。');
  await panel(page).getByLabel('向 AI 提问').fill('切换模式、研究和刷新后保留的未发送问题。');
  await dragRightWidth(page, 720); await expect.poll(() => rightWidth(page)).toBe(720);
  await rightHandle(page).focus(); await page.keyboard.press('ArrowLeft'); await expect.poll(() => rightWidth(page)).toBe(730);
  await page.keyboard.press('Shift+ArrowRight'); await expect.poll(() => rightWidth(page)).toBe(690);
  await expect(rightHandle(page)).toHaveAttribute('aria-valuemin', '420'); await saved(page);
  await page.reload(); await expect.poll(() => rightWidth(page)).toBe(690);
  expect((await state(page)).panelWidth).toBe(690);
  await panel(page).getByRole('tab', { name: '卡片', exact: true }).click(); await expect.poll(() => rightWidth(page)).toBe(690);
  await expect(rightHandle(page)).toHaveAttribute('aria-valuemin', '320');
  await rightHandle(page).dblclick(); await expect.poll(() => rightWidth(page)).toBe(360);
  await rightHandle(page).focus(); await page.keyboard.press('Home'); await expect.poll(() => rightWidth(page)).toBe(320);
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click(); await expect.poll(() => rightWidth(page)).toBe(420);
  await rightHandle(page).dblclick(); await expect.poll(() => rightWidth(page)).toBe(420);
  await dragRightWidth(page, 800); await expect.poll(() => rightWidth(page)).toBe(800);
  await switchResearch(page, 'research-b'); await switchResearch(page, 'research-a');
  await expect.poll(() => rightWidth(page)).toBe(800);
  await expect(main(page).getByLabel('结论正文', { exact: true })).toHaveValue('右栏调整后仍保留的结论。');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('切换模式、研究和刷新后保留的未发送问题。');
  await saved(page); await page.reload(); await expect.poll(() => rightWidth(page)).toBe(800);
  await expect(main(page).getByLabel('结论正文', { exact: true })).toHaveValue('右栏调整后仍保留的结论。');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('切换模式、研究和刷新后保留的未发送问题。');
});

test('宽右栏随窗口缩小保留正文空间，收起左栏后可以继续拖宽', async ({ page }) => {
  await boot(page);
  await dragRightWidth(page, 800); await expect.poll(() => rightWidth(page)).toBe(800);
  for (const [viewportWidth, viewportHeight] of [[1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width: viewportWidth, height: viewportHeight }); await bodyFits(page);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  const before = await rightWidth(page);
  await sidebar(page).getByRole('button', { name: '收起左栏', exact: true }).click();
  await expect(sidebar(page)).toBeHidden();
  await dragRightWidth(page, 900); await expect.poll(() => rightWidth(page)).toBe(900); await bodyFits(page);
  expect(await rightWidth(page)).toBeGreaterThan(before);
  await page.getByRole('button', { name: '展开左栏', exact: true }).click(); await bodyFits(page);
  await saved(page);
});
