import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import { openResearchNavigation, openResearchPage } from './knowledge-helpers';
import { mockProjectService } from './project-fixture';

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`白板和文稿子项层级清晰，父子入口与窄屏抽屉可用 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const seed = createSeed();
    seed.boards['board-a2'].title = '条件与限制：跨论文比较实验设置和适用范围';
    await page.route('**/api/ai/**', route => route.fulfill({ status: 501, json: { error: '导航验收不调用助手' } }));
    await mockProjectService(page, { seed, bound: false });
    await page.goto('/');
    await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible();
    const sidebar = await openResearchNavigation(page);
    for (const [parent, title] of [['白板', '证据与论证'], ['文稿', '检索增强的适用条件']]) {
      const parentItem = sidebar.getByRole('button', { name: parent, exact: true });
      const child = sidebar.getByRole('button', { name: title, exact: true });
      const parentIcon = (await parentItem.locator('svg').boundingBox())!;
      const childIcon = (await child.locator('svg').boundingBox())!;
      const childText = (await child.locator('span').boundingBox())!;
      expect(childIcon.x).toBeGreaterThanOrEqual(parentIcon.x + 20);
      expect(childText.x).toBeGreaterThan(childIcon.x + childIcon.width);
      await parentItem.click();
      await expect(page.getByRole('main', { name: '主工作区' }).getByRole('heading', { name: parent, exact: true })).toBeVisible();
      await openResearchPage(page, title);
      const reopened = await openResearchNavigation(page);
      await expect(reopened.getByRole('button', { name: title, exact: true })).toHaveClass(/active/);
    }
    const longItem = sidebar.getByRole('button', { name: seed.boards['board-a2'].title, exact: true });
    await expect(longItem).toHaveAttribute('title', seed.boards['board-a2'].title);
    const overflow = await longItem.locator('span').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, ellipsis: getComputedStyle(element).textOverflow }));
    expect(overflow.content).toBeGreaterThan(overflow.width);
    expect(overflow.ellipsis).toBe('ellipsis');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    await mkdir('docs/verification/navigation', { recursive: true });
    await page.screenshot({ path: `docs/verification/navigation/sidebar-${viewport.width}.png` });
    if (viewport.width === 1024) {
      await page.getByRole('button', { name: '关闭导航抽屉', exact: true }).click();
      await expect(sidebar).toBeHidden();
    }
    await page.reload();
    await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible();
    await expect((await openResearchNavigation(page)).getByRole('button', { name: '检索增强的适用条件', exact: true })).toHaveClass(/active/);
  });
}
