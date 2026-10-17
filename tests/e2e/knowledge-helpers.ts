import { expect, type Page } from '@playwright/test';

export async function openResearchNavigation(page: Page) {
  const sidebar = page.locator('.sidebar');
  if (!await sidebar.isVisible()) await page.getByRole('button', { name: '展开左栏', exact: true }).click();
  return sidebar;
}

export async function openResearchPage(page: Page, name: string) {
  const sidebar = await openResearchNavigation(page);
  await sidebar.getByRole('button', { name, exact: true }).first().click();
}

export async function openSource(page: Page, title: string | RegExp) {
  await openResearchPage(page, '资料');
  await page.getByRole('main', { name: '主工作区' }).getByRole('button', { name: title, exact: typeof title === 'string' }).first().click();
}

export async function choosePdf(page: Page, file: Parameters<ReturnType<Page['getByLabel']>['setInputFiles']>[0]) {
  await page.getByRole('button', { name: '添加资料', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加资料', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles(file);
}

export async function switchResearch(page: Page, researchId: string) {
  await openResearchNavigation(page);
  await page.getByLabel('切换研究', { exact: true }).selectOption(researchId);
}
