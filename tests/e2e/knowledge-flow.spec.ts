import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import type { WorkspaceData } from '../../src/domain/types';
import { paneGroups } from '../../src/services/panes';
import { choosePdf, openResearchNavigation, openResearchPage, switchResearch } from './knowledge-helpers';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
test.beforeEach(async ({ page }) => {
  await page.route('**/api/sources/**', route => route.fulfill({ status: 503, json: { error: '本地标识回归使用固定样例，未联网获取全文。' } }));
});
async function state(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => { const journal = localStorage.getItem('papertrail-recovery-v3'); if (journal) return JSON.parse(journal); const path = '/src/data/storage.ts'; return (await import(path)).loadWorkspace(); });
}
async function saved(page: Page) { await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'); }
async function start(page: Page) { await mkdir('docs/verification/knowledge-flow', { recursive: true }); await page.goto('/'); await expect(main(page).getByRole('heading', { name: '检索增强，何时有效？', exact: true })).toBeVisible(); await saved(page); }
async function add(page: Page, text: string, target?: string) {
  await page.getByRole('button', { name: '添加资料', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加资料', exact: true });
  if (target) await dialog.getByLabel('添加资料的目标研究').selectOption(target);
  await dialog.getByLabel('标识、链接或资料标题').fill(text);
  await dialog.getByLabel('标识、链接或资料标题').press('Enter');
  await expect(dialog).toHaveCount(0);
  await saved(page);
}
async function uniquePdf(title: string) {
  const pdf = await PDFDocument.load(await readFile('public/samples/adaptive-retrieval.pdf'));
  pdf.setTitle(title);
  return { name: `${title}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save({ useObjectStreams: false })) };
}
async function placeSource(page: Page, title: string) {
  await openResearchPage(page, '证据与论证');
  await main(page).getByRole('button', { name: '添加资料', exact: true }).click();
  await main(page).getByRole('button', { name: 'PDF 论文', exact: true }).click();
  await main(page).getByRole('button', { name: `添加到白板：${title}`, exact: true }).click();
  await main(page).getByRole('tablist', { name: '窗格 1 标签', exact: true }).getByRole('tab', { name: title, exact: true }).click();
}

test('本地标识去重、标题建条目、资料库复用和添加框键盘返回', async ({ page }) => {
  await start(page);
  await openResearchPage(page, '资料');
  await page.keyboard.press('a');
  await expect(page.getByRole('dialog', { name: '添加资料' })).toBeVisible();
  await page.getByLabel('标识、链接或资料标题').fill('arXiv:2401.01234v2');
  await page.screenshot({ path: 'docs/verification/knowledge-flow/add-source-1440.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await add(page, 'arXiv:2401.01234v2');
  const first = Object.values((await state(page)).documents).find(doc => doc.identifiers?.arxiv === '2401.01234')!;
  expect(first.assetId).toBeUndefined();
  await page.screenshot({ path: 'docs/verification/knowledge-flow/no-fulltext-1440.png' });
  await add(page, 'https://arxiv.org/abs/2401.01234v5');
  expect(Object.values((await state(page)).documents).filter(doc => doc.identifiers?.arxiv === '2401.01234')).toHaveLength(1);
  await add(page, 'https://doi.org/10.1234/AbC');
  await add(page, 'DOI:10.1234/abc');
  expect(Object.values((await state(page)).documents).filter(doc => doc.identifiers?.doi === '10.1234/abc')).toHaveLength(1);
  await add(page, 'https://example.org/paper#section');
  expect(Object.values((await state(page)).documents).some(doc => doc.identifiers?.url === 'https://example.org/paper')).toBe(true);
  await add(page, '知识链路 E2E 资料');
  const document = Object.values((await state(page)).documents).find(doc => doc.title === '知识链路 E2E 资料')!;
  await switchResearch(page, 'research-b');
  await add(page, '知识链路 E2E 资料');
  const current = await state(page);
  expect(current.researches['research-a'].documentIds).toContain(document.id);
  expect(current.researches['research-b'].documentIds).toContain(document.id);
  expect(Object.values(current.documents).filter(doc => doc.title === document.title)).toHaveLength(1);
  await openResearchPage(page, '资料库');
  await add(page, '仅存资料库 E2E');
  const libraryOnly = Object.values((await state(page)).documents).find(doc => doc.title === '仅存资料库 E2E')!;
  expect(Object.values((await state(page)).researches).every(research => !research.documentIds.includes(libraryOnly.id))).toBe(true);
});

test('补 PDF 保留资料身份、研究关联和白板摆放，刷新后可阅读', async ({ page }) => {
  await start(page);
  await add(page, '就地补全文 E2E');
  let data = await state(page);
  const document = Object.values(data.documents).find(doc => doc.title === '就地补全文 E2E')!;
  await placeSource(page, document.title);
  const placement = Object.values((await state(page)).placements).find(item => item.resourceRef.id === document.id)!;
  await main(page).getByLabel('为资料选择 PDF').setInputFiles(await uniquePdf('就地补全文 E2E'));
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await saved(page);
  data = await state(page);
  expect(data.documents[document.id]).toMatchObject({ id: document.id, title: document.title, pageCount: 3 });
  expect(data.researches['research-a'].documentIds).toContain(document.id);
  expect(data.placements[placement.id].resourceRef.id).toBe(document.id);
  expect(data.documents[document.id].hash).toMatch(/^[a-f0-9]{64}$/);
  await page.reload();
  await expect(main(page).locator('canvas').first()).toBeVisible();
  expect((await state(page)).placements[placement.id].resourceRef.id).toBe(document.id);
});

test('补全文冲突先预览，取消不变，确认后原子转移关联与打开项', async ({ page }) => {
  await start(page);
  await add(page, 'DOI:10.1234/merge');
  const stub = Object.values((await state(page)).documents).find(doc => doc.identifiers?.doi === '10.1234/merge')!;
  await placeSource(page, stub.title);
  const placement = Object.values((await state(page)).placements).find(item => item.resourceRef.id === stub.id)!;
  await main(page).getByLabel('为资料选择 PDF').setInputFiles('public/samples/adaptive-retrieval.pdf');
  const preview = main(page).getByRole('region', { name: '合并资料确认' });
  await expect(preview).toContainText('白板摆放：1 处');
  await expect(preview).toContainText('10.1234/merge');
  await preview.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/verification/knowledge-flow/merge-preview-1440.png' });
  const previewScrollTop = await preview.evaluate(element => element.closest('.workspace-pane-body')?.scrollTop ?? 0);
  // Let the preview's intentional scroll persist before comparing the cancel operation.
  await expect.poll(async () => paneGroups((await state(page)).sessions['research-a'].layout!.root)
    .flatMap(group => group.tabs).find(tab => tab.ref.id === stub.id)?.viewState?.scrollTop ?? 0).toBe(previewScrollTop);
  const beforeCancel = await state(page);
  await preview.getByRole('button', { name: '取消', exact: true }).click();
  expect(await state(page)).toEqual(beforeCancel);
  await main(page).getByLabel('为资料选择 PDF').setInputFiles('public/samples/adaptive-retrieval.pdf');
  await preview.getByRole('button', { name: '合并为一条', exact: true }).click();
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await saved(page);
  const merged = await state(page);
  expect(merged.documents[stub.id]).toBeUndefined();
  expect(merged.documents['paper-a'].identifiers?.doi).toBe('10.1234/merge');
  expect(merged.placements[placement.id].resourceRef.id).toBe('paper-a');
  expect(merged.researches['research-a'].documentIds).not.toContain(stub.id);
  expect(merged.researches['research-a'].documentIds.filter(id => id === 'paper-a')).toHaveLength(1);
  expect(merged.sessions['research-a'].openItems.some(ref => ref.id === stub.id)).toBe(false);
  await page.reload();
  await expect(main(page).locator('canvas').first()).toBeVisible();
});

test('多 PDF 导入保留有效文件，重复计数和失败原因可见', async ({ page }) => {
  await start(page);
  const first = await uniquePdf('批量甲 E2E'), second = await uniquePdf('批量乙 E2E');
  await choosePdf(page, [first, { name: 'duplicate.pdf', mimeType: first.mimeType, buffer: first.buffer }, { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not pdf') }, second]);
  const dialog = page.getByRole('dialog', { name: '添加资料', exact: true });
  // The failure list appears after the whole batch has finished parsing and saving.
  await expect(dialog.getByRole('alert')).toContainText('broken.pdf', { timeout: 30_000 });
  await expect(dialog.getByRole('alert')).toContainText('不是 PDF');
  await expect(page.getByText('导入完成：新建 2 条，复用 1 条，失败 1 个。', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'docs/verification/knowledge-flow/batch-import-error-1440.png' });
  const data = await state(page);
  expect(Object.values(data.documents).filter(doc => doc.filename?.startsWith('批量'))).toHaveLength(2);
  await dialog.getByRole('button', { name: '关闭添加资料' }).click();
  await saved(page);
  await page.reload();
  expect(Object.values((await state(page)).documents).filter(doc => doc.filename?.startsWith('批量'))).toHaveLength(2);
});

test('窗口拖放显示当前目标，并归入该研究', async ({ page }) => {
  await start(page);
  const file = await uniquePdf('窗口拖入 E2E');
  const transfer = await page.evaluateHandle(({ bytes, name }) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }));
    return data;
  }, { bytes: Array.from(file.buffer), name: file.name });
  await page.locator('body').dispatchEvent('dragenter', { dataTransfer: transfer });
  await expect(page.getByRole('status')).toContainText('松开即加入「检索增强，何时有效？」');
  await page.locator('body').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await expect(page.locator('.source-window-drop')).toHaveCount(0);
  await saved(page);
  const data = await state(page);
  const document = Object.values(data.documents).find(doc => doc.filename === file.name)!;
  expect(data.researches['research-a'].documentIds).toContain(document.id);
  await transfer.dispose();
});

test('资料状态分组与三种尺寸导航无横向溢出', async ({ page }) => {
  await start(page);
  await mkdir('docs/verification/knowledge-flow', { recursive: true });
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await openResearchPage(page, '资料');
    await expect(main(page).getByRole('heading', { name: '读过', exact: true })).toBeVisible();
    await expect(main(page).getByLabel('Scanned Research Note 的阅读状态')).toHaveValue('skimmed');
    await expect(main(page)).not.toContainText('undefined 页');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await saved(page);
    await page.screenshot({ path: `docs/verification/knowledge-flow/sources-${width}.png` });
    if (width === 1024) {
      const sidebar = await openResearchNavigation(page);
      await expect(sidebar).toBeVisible();
      await page.getByRole('button', { name: '关闭导航抽屉', exact: true }).click();
      await expect(sidebar).toBeHidden();
      await page.getByRole('button', { name: '展开左栏', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(sidebar).toBeVisible();
    }
  }
});
