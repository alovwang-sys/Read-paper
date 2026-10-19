import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import type { WorkspaceData } from '../../src/domain/types';
import { choosePdf, openResearchPage, switchResearch } from './knowledge-helpers';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const output = 'docs/verification/reading-workspace-bugfixes';
async function state(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const journal = localStorage.getItem('papertrail-recovery-v3');
    if (journal) return JSON.parse(journal);
    const path = '/src/data/storage.ts';
    return (await import(path)).loadWorkspace();
  });
}
async function saved(page: Page) { await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'); }
async function add(page: Page, title: string, target?: string) {
  await page.getByRole('button', { name: '添加资料', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加资料', exact: true });
  if (target) await dialog.getByLabel('添加资料的目标研究').selectOption(target);
  await dialog.getByLabel('标识、链接或资料标题').fill(title);
  await dialog.getByLabel('标识、链接或资料标题').press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(main(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
  await saved(page);
  return Object.values((await state(page)).documents).find(doc => doc.title === title)!;
}
async function removalMenu(page: Page, title: string, label: '移出本研究' | '从资料库删除') {
  await main(page).getByRole('button', { name: `${title} 的更多操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  return page.getByRole('menu', { name: label, exact: true });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.goto('/');
  await expect(main(page).getByRole('heading', { name: '检索增强，何时有效？', exact: true })).toBeVisible();
  await saved(page);
});

test('新资料可从研究移出，其他研究和资料库在刷新后保留', async ({ page }) => {
  const title = '跨研究移出资料 E2E';
  const doc = await add(page, title);
  await main(page).getByLabel('本研究收录备注').fill('研究甲的收录备注');
  await switchResearch(page, 'research-b');
  await add(page, title);
  await main(page).getByLabel('本研究收录备注').fill('研究乙的收录备注');
  await switchResearch(page, 'research-a');
  await openResearchPage(page, '资料');
  let menu = await removalMenu(page, title, '移出本研究');
  await expect(menu).toContainText('本研究的收录备注与发现记录会移除');
  await menu.getByRole('menuitem', { name: '取消', exact: true }).click();
  await page.keyboard.press('Escape');
  expect((await state(page)).researches['research-a'].documentIds).toContain(doc.id);
  menu = await removalMenu(page, title, '移出本研究');
  await menu.getByRole('menuitem', { name: '确认移出', exact: true }).click();
  await expect(main(page).getByRole('button', { name: title, exact: true })).toHaveCount(0);
  await saved(page);
  await page.reload();
  await expect(main(page).getByRole('heading', { name: '资料', exact: true })).toBeVisible();
  const data = await state(page);
  expect(data.documents[doc.id]).toBeDefined();
  expect(data.researches['research-a'].documentIds).not.toContain(doc.id);
  expect(data.researches['research-a'].sourceRecords?.[doc.id]).toBeUndefined();
  expect(data.researches['research-b'].documentIds).toContain(doc.id);
  expect(data.researches['research-b'].sourceRecords?.[doc.id].note).toBe('研究乙的收录备注');
  await openResearchPage(page, '资料库');
  await expect(main(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
});

test('资料库中的独立条目可取消或确认删除，刷新后不恢复', async ({ page }) => {
  const title = '资料库删除资料 E2E';
  const doc = await add(page, title, 'library');
  let menu = await removalMenu(page, title, '从资料库删除');
  await expect(menu).toContainText('将永久删除这条资料');
  await menu.getByRole('menuitem', { name: '取消', exact: true }).click();
  await page.keyboard.press('Escape');
  expect((await state(page)).documents[doc.id]).toBeDefined();
  menu = await removalMenu(page, title, '从资料库删除');
  await menu.getByRole('menuitem', { name: '确认删除', exact: true }).click();
  await saved(page);
  expect((await state(page)).documents[doc.id]).toBeUndefined();
  await page.reload();
  await expect(main(page).getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
  expect((await state(page)).documents[doc.id]).toBeUndefined();
  await expect(main(page).getByText('资源已缺失', { exact: true })).toHaveCount(0);
});

test('导入 PDF 后可移出研究并在资料库删除', async ({ page }) => {
  const title = '导入后删除 PDF E2E';
  const pdf = await PDFDocument.load(await readFile('public/samples/adaptive-retrieval.pdf'));
  pdf.setTitle(title);
  await choosePdf(page, { name: `${title}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save({ useObjectStreams: false })) });
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await saved(page);
  const doc = Object.values((await state(page)).documents).find(doc => doc.title === title)!;
  await openResearchPage(page, '资料');
  const menu = await removalMenu(page, title, '移出本研究');
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/source-removal-1440.png` });
  await menu.getByRole('menuitem', { name: '确认移出', exact: true }).click();
  await openResearchPage(page, '资料库');
  await (await removalMenu(page, title, '从资料库删除')).getByRole('menuitem', { name: '确认删除', exact: true }).click();
  await saved(page);
  expect((await state(page)).documents[doc.id]).toBeUndefined();
  await page.reload();
  await expect(main(page).getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
  expect((await state(page)).documents[doc.id]).toBeUndefined();
});

test('已有研究依赖或引用时拒绝移出和删除，并显示原因', async ({ page }) => {
  const before = await state(page), doc = before.documents['paper-a'];
  await openResearchPage(page, '资料');
  let menu = await removalMenu(page, doc.title, '移出本研究');
  await menu.getByRole('menuitem', { name: '确认移出', exact: true }).click();
  await expect(menu.getByRole('alert')).toBeVisible();
  expect((await state(page)).researches['research-a'].documentIds).toContain(doc.id);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });
  await openResearchPage(page, '资料库');
  menu = await removalMenu(page, doc.title, '从资料库删除');
  await menu.getByRole('menuitem', { name: '确认删除', exact: true }).click();
  await expect(menu.getByRole('alert')).toBeVisible();
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/source-deletion-protected-1280.png` });
  const after = await state(page);
  expect(after.documents[doc.id]).toEqual(before.documents[doc.id]);
  expect(after.evidence).toEqual(before.evidence);
  expect(after.cards).toEqual(before.cards);
});
