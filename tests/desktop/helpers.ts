import { expect, type Page } from '@playwright/test';
import { openResearchNavigation } from '../e2e/knowledge-helpers';

// These packaged regressions exercise the classic surface through the same UI a user sees.
export async function useClassicWorkbench(page: Page) {
  await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible();
  if (await page.locator('.app-shell.agent-workbench').count()) {
    await openResearchNavigation(page);
    await page.getByRole('button', { name: '经典工作台', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Agent 工作台', exact: true })).toBeVisible();
    const expandPanel = page.getByRole('button', { name: '展开右侧面板', exact: true });
    if (await expandPanel.isVisible()) await expandPanel.click();
  }
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
}
