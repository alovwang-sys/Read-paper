import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import { mockProjectService } from './project-fixture';
import { openResearchNavigation, switchResearch } from './knowledge-helpers';
import { saved, state } from './workspace-split-helpers';

const evidence = 'docs/verification/desktop-navigation/screenshots';
const trigger = (page: Page) => page.getByRole('button', { name: '切换研究', exact: true, includeHidden: true });
const popup = (page: Page) => page.getByRole('dialog', { name: '切换研究', exact: true });
const item = (page: Page, id: string) => popup(page).locator(`button[data-research-id="${id}"]`);

async function boot(page: Page, options: { classic?: boolean; duplicate?: boolean; empty?: boolean } = {}) {
  const seed = createSeed();
  seed.agentWorkbench = !options.classic;
  seed.researches['research-a'].title = options.empty ? '' : '检索增强，何时有效？';
  seed.researches['research-b'].title = options.duplicate ? seed.researches['research-a'].title : '对照研究：长文档证据与可靠性';
  for (const [index, board] of Object.values(seed.boards).entries()) board.title = index === 0 ? '导航回归匹配图' : `导航回归条件图 ${index}`;
  for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'demo';
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, mode: 'demo', model: 'navigation-test', images: false } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/research/capabilities', route => route.fulfill({ json: { connections: [] } }));
  await page.route('**/api/ai/research/run', () => { throw new Error('Navigation tests must not contact a model'); });
  await page.goto('/');
  await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible(); await saved(page);
  return seed;
}

for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
  test(`研究切换弹层可筛选、键盘选择，Esc逐层关闭 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await boot(page);
    const sidebar = await openResearchNavigation(page);
    await trigger(page).click();
    await expect(popup(page).getByRole('textbox', { name: '查找研究' })).toBeFocused();
    await expect(item(page, 'research-a')).toHaveAttribute('aria-current', 'true');
    await expect(popup(page).locator('select')).toHaveCount(0);
    await expect(popup(page).getByRole('button', { name: '全局资料浏览' })).toHaveCount(0);
    const bounds = (await popup(page).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
    await mkdir(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/switcher-${width}.png` });
    await popup(page).getByLabel('查找研究').fill('不存在的研究');
    await expect(popup(page).getByRole('status')).toHaveText('没有找到匹配的研究');
    await page.keyboard.press('Escape');
    await expect(popup(page)).toHaveCount(0); await expect(trigger(page)).toBeFocused(); await expect(sidebar).toBeVisible();
    await trigger(page).click();
    await popup(page).getByLabel('查找研究').fill('对照研究');
    await expect(popup(page).locator('button[data-research-id]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown'); await expect(item(page, 'research-b')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(popup(page)).toHaveCount(0); await expect(trigger(page)).toHaveAttribute('data-research-id', 'research-b');
    if (width === 1024) await expect(sidebar).toBeHidden();
    await switchResearch(page, 'research-a');
    await saved(page); await page.reload(); await openResearchNavigation(page);
    await expect(trigger(page)).toContainText('检索增强，何时有效？');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test('当前研究不重复切换，Tab与点击外部正常退出，重名项有辅助说明', async ({ page }) => {
  await boot(page, { duplicate: true });
  const before = await state(page);
  await trigger(page).click();
  await expect(popup(page).locator('button[data-research-id] small')).toHaveCount(2);
  await item(page, 'research-a').click();
  await expect(popup(page)).toHaveCount(0); expect((await state(page)).scope).toEqual(before.scope);
  await trigger(page).click(); await page.keyboard.press('Tab');
  await expect(popup(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^项目设置 ·/ })).toBeFocused();
  await trigger(page).click(); await page.getByRole('main', { name: '主工作区' }).click({ position: { x: 20, y: 50 } });
  await expect(popup(page)).toHaveCount(0); await expect(trigger(page)).not.toBeFocused();
});

test('再次点击研究名称可收起弹层并还原触发器焦点', async ({ page }) => {
  await boot(page);
  await trigger(page).click(); await expect(popup(page)).toBeVisible();
  await trigger(page).click(); await expect(popup(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
});

test('点击弹层说明后仍可用Esc关闭弹层，窄屏不误关导航', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 }); await boot(page);
  const sidebar = await openResearchNavigation(page);
  for (const target of ['.research-switcher-caption', '.research-switcher-hint']) {
    await trigger(page).click(); await popup(page).locator(target).click();
    await page.keyboard.press('Escape');
    await expect(popup(page)).toHaveCount(0); await expect(sidebar).toBeVisible(); await expect(trigger(page)).toBeFocused();
  }
});

test('切换研究和资料库保留各自草稿，旧空名称仍有可见入口', async ({ page }) => {
  await boot(page, { empty: true });
  await expect(trigger(page)).toHaveText('未命名研究');
  const composer = page.getByRole('textbox', { name: '研究目标', exact: true });
  await composer.fill('研究 A 尚未发送的问题');
  await switchResearch(page, 'research-b'); await composer.fill('研究 B 草稿');
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await expect(trigger(page)).toHaveText('全局资料库');
  await switchResearch(page, 'research-a'); await expect(composer).toHaveValue('研究 A 尚未发送的问题');
  await switchResearch(page, 'research-b'); await expect(composer).toHaveValue('研究 B 草稿');
});

test('新建保持一键开始，默认名称唯一，编辑可取消且不会保存空名', async ({ page }) => {
  await boot(page);
  const name = page.getByRole('textbox', { name: '研究名称', exact: true });
  await name.fill(''); await name.press('Enter'); await expect(name).toHaveValue('检索增强，何时有效？');
  await name.fill('尚未确认的名称'); await name.press('Escape'); await expect(name).toHaveValue('检索增强，何时有效？');
  await name.fill('  更新后的研究名称  '); await name.press('Enter'); await expect(name).toHaveValue('更新后的研究名称');
  await saved(page); await page.reload(); await expect(name).toHaveValue('更新后的研究名称');
  for (const expected of ['新研究', '新研究 2']) {
    await page.getByRole('button', { name: '新建研究', exact: true }).click();
    await expect(name).toHaveValue(expected); await expect(name).toBeFocused();
    await expect(page.getByRole('dialog', { name: '新建研究' })).toHaveCount(0);
  }
  const names = Object.values((await state(page)).researches).map(item => item.title);
  expect(names.filter(title => title.startsWith('新研究'))).toEqual(['新研究', '新研究 2']);
  await saved(page);
});

test('经典工作台同用研究切换器，全局搜索每份资源只出现一次', async ({ page }) => {
  const errors: string[] = []; page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const seed = await boot(page, { classic: true });
  await switchResearch(page, 'research-b'); await switchResearch(page, 'research-a');
  await page.getByRole('button', { name: '全局搜索', exact: true }).click();
  const search = page.getByRole('dialog', { name: '全局搜索' });
  const query = search.getByRole('textbox', { name: '搜索全部资料' });
  await query.fill('导航回归'); await expect(search.locator('.search-result-open')).toHaveCount(Object.keys(seed.boards).length);
  await query.fill('导航回归匹配图'); await expect(search.locator('.search-result-open')).toHaveCount(1);
  await expect(search).not.toContainText('导航回归条件图');
  await query.fill('导航回归'); await expect(search.locator('.search-result-open')).toHaveCount(Object.keys(seed.boards).length);
  expect(errors.filter(message => /same key|unique.*key/i.test(message))).toEqual([]);
});
