import { expect, type Page } from '@playwright/test';
import { openResearchNavigation } from '../e2e/knowledge-helpers';

// These packaged regressions exercise the classic surface through the same UI a user sees.
export async function useClassicWorkbench(page: Page) {
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByRole('button', { name: /^(经典工作台|Agent 工作台)$/ })).toBeVisible();
  if (await page.getByRole('button', { name: '经典工作台', exact: true }).isVisible()) {
    await openResearchNavigation(page);
    await page.getByRole('button', { name: '经典工作台', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Agent 工作台', exact: true })).toBeVisible();
  await expect(page.locator('.app-shell.agent-workbench')).toHaveCount(0);
  await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible();
  const panel = page.getByRole('complementary', { name: '参考面板', exact: true });
  if (!await panel.isVisible()) await page.getByRole('button', { name: '展开右侧面板', exact: true }).click();
  await expect(panel.getByRole('tab', { name: 'AI', exact: true })).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
}
