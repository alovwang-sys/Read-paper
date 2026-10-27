import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { controlledSeed, installControlledServices, main, primaryId, readData, saved } from '../../docs/verification/continuous-workspace/harness';
import { openResearchNavigation, openResearchPage, switchResearch } from './knowledge-helpers';

test.use({ storageState: { cookies: [], origins: [] } });
const dialog = (page: Page) => page.getByRole('dialog', { name: '重命名白板', exact: true });
const input = (page: Page) => dialog(page).getByRole('textbox', { name: '白板名称', exact: true });
const titleButton = (page: Page, title = '证据与论证') => main(page).getByRole('button', { name: `重命名白板：${title}`, exact: true });
async function start(page: Page) {
  page.setDefaultTimeout(10000);
  const seed = controlledSeed();
  seed.sessions['research-a'].active = { kind: 'board', id: 'board-a' };
  seed.sessions['research-a'].openItems = [{ kind: 'board', id: 'board-a' }];
  Object.assign(seed.conversations[primaryId], { title: seed.boards['board-a'].title, anchor: { kind: 'board', id: 'board-a' }, input: '保留的讨论草稿' });
  const fixture = await installControlledServices(page, { seed });
  await page.goto('/'); await expect(titleButton(page)).toBeVisible(); await saved(page);
  return fixture;
}
async function openBoards(page: Page) {
  const sidebar = await openResearchNavigation(page);
  const button = sidebar.getByRole('button', { name: '白板', exact: true });
  if (!await button.isVisible()) await sidebar.getByText('浏览研究内容', { exact: true }).click();
  await openResearchPage(page, '白板');
}
async function screenshot(page: Page, name: string) {
  await mkdir('docs/verification/board-title-and-list/screenshots', { recursive: true });
  await saved(page); await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `docs/verification/board-title-and-list/screenshots/${name}.png` });
}

test('白板名称支持取消、空名、中文组合输入与Enter，标题同步且刷新和研究切换保留', async ({ page }) => {
  const fixture = await start(page), before = await readData(page);
  await titleButton(page).click(); await expect(input(page)).toBeFocused();
  await input(page).fill('继续编辑的标题'); await input(page).press('Escape');
  await expect(dialog(page)).toHaveCount(0); await expect(titleButton(page)).toBeFocused();
  expect((await readData(page)).boards['board-a'].title).toBe('证据与论证');
  await saved(page); await page.reload(); await titleButton(page).click();
  await expect(input(page)).toHaveValue('继续编辑的标题');
  await input(page).fill('   '); await input(page).press('Enter');
  await expect(dialog(page).getByRole('button', { name: '保存名称', exact: true })).toBeDisabled();
  const renamed = '人工命名：来源与论证';
  await input(page).fill(renamed); await input(page).dispatchEvent('compositionstart');
  await input(page).press('Enter'); await input(page).press('Escape');
  await expect(dialog(page)).toBeVisible();
  expect((await readData(page)).boards['board-a'].title).toBe('证据与论证');
  await input(page).dispatchEvent('compositionend'); await input(page).press('Enter');
  await expect(dialog(page)).toHaveCount(0); await saved(page);
  await expect(titleButton(page, renamed)).toBeVisible();
  await expect(main(page).getByRole('tab', { name: renamed, exact: true })).toBeVisible();
  const sidebar = await openResearchNavigation(page);
  await expect(sidebar.getByRole('button', { name: renamed, exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: `打开讨论：${renamed}`, exact: true })).toBeVisible();
  const after = await readData(page);
  expect(after.boards['board-a']).toEqual({ ...before.boards['board-a'], title: renamed });
  expect(after.boards['board-b']).toEqual(before.boards['board-b']);
  expect(after.placements).toEqual(before.placements); expect(after.edges).toEqual(before.edges);
  expect(after.conversations).toEqual(before.conversations); expect(after.requests).toEqual(before.requests);
  expect(after.sessions['research-b']).toEqual(before.sessions['research-b']);
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(titleButton(page, renamed)).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await screenshot(page, `renamed-board-${width}`);
  }
  await switchResearch(page, 'research-b'); await switchResearch(page, 'research-a');
  await expect(titleButton(page, renamed)).toBeVisible();
  await saved(page); await page.reload(); await expect(titleButton(page, renamed)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 }); await openBoards(page);
  await expect(main(page).locator('.resource-list-row').getByRole('button', { name: renamed, exact: true })).toBeVisible();
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
});

test('列表主体留白可打开白板，菜单独立，Enter/空格和拖拽后点击正常', async ({ page }) => {
  const fixture = await start(page);
  const rows = main(page).locator('.resource-list-row');
  await openBoards(page);
  const row = rows.filter({ has: page.getByRole('button', { name: '条件与限制', exact: true }) });
  const open = row.getByRole('button', { name: '条件与限制', exact: true });
  const box = (await open.boundingBox())!, parentBox = (await row.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(parentBox.height - 2);
  await open.click({ position: { x: box.width - 5, y: box.height - 5 } });
  await expect(titleButton(page, '条件与限制')).toBeVisible();
  for (const key of ['Enter', 'Space']) {
    await openBoards(page); await open.focus(); await open.press(key);
    await expect(titleButton(page, '条件与限制')).toBeVisible();
  }
  await openBoards(page);
  await row.getByRole('button', { name: '条件与限制 的更多操作', exact: true }).click();
  await expect(main(page).getByRole('heading', { name: '白板', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await input(page).fill('从列表改名的白板'); await input(page).press('Enter');
  await expect(dialog(page)).toHaveCount(0); await saved(page);
  const renamedRow = rows.filter({ has: page.getByRole('button', { name: '从列表改名的白板', exact: true }) });
  await expect(renamedRow).toBeVisible();
  await screenshot(page, 'board-list-main-click-area');
  const dragBox = (await renamedRow.getByRole('button', { name: '从列表改名的白板', exact: true }).boundingBox())!;
  await page.mouse.move(dragBox.x + 25, dragBox.y + dragBox.height / 2); await page.mouse.down();
  await page.mouse.move(dragBox.x + 50, dragBox.y + dragBox.height / 2 + 10, { steps: 6 });
  await page.mouse.move(800, 25, { steps: 10 }); await page.mouse.up();
  await expect(main(page).getByRole('heading', { name: '白板', exact: true })).toBeVisible();
  const payload = await page.evaluateHandle(() => new DataTransfer());
  await renamedRow.dispatchEvent('dragstart', { dataTransfer: payload });
  expect(await payload.evaluate(transfer => transfer.types)).toContain('application/x-papertrail-resource');
  await renamedRow.dispatchEvent('dragend', { dataTransfer: payload });
  await renamedRow.getByRole('button', { name: '从列表改名的白板', exact: true }).dispatchEvent('click', { detail: 1 });
  await expect(main(page).getByRole('heading', { name: '白板', exact: true })).toBeVisible();
  await renamedRow.getByRole('button', { name: '从列表改名的白板', exact: true }).click();
  await expect(titleButton(page, '从列表改名的白板')).toBeVisible();
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
});

test('名称保存故障保留输入和草稿，恢复存储后可重试', async ({ page }) => {
  const fixture = await start(page);
  await titleButton(page).click(); await input(page).fill('保存故障后仍保留的白板名称'); await saved(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as typeof window & { restoreBoardStore?: () => void }).restoreBoardStore = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'workspace') throw new DOMException('受控名称保存故障', 'QuotaExceededError');
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  });
  await input(page).press('Enter');
  await expect(dialog(page).getByRole('alert')).toContainText('受控名称保存故障');
  await expect(input(page)).toHaveValue('保存故障后仍保留的白板名称');
  expect((await readData(page)).sessions['research-a'].boardTitleDrafts?.['board-a']).toBe('保存故障后仍保留的白板名称');
  await page.evaluate(() => (window as typeof window & { restoreBoardStore?: () => void }).restoreBoardStore?.());
  await dialog(page).getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0); await saved(page); await page.reload();
  await expect(titleButton(page, '保存故障后仍保留的白板名称')).toBeVisible();
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
});
