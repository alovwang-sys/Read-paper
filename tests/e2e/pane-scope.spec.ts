import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../../src/data/seed';
import { mockProjectService } from './project-fixture';
import { openResearchPage } from './knowledge-helpers';
import { groups, layout, pane, panel, saved, split, state, waitForPdf } from './workspace-split-helpers';

const paper = 'Adaptive Retrieval: Evidence & Reliability';
const candidate = { kind: 'paper' as const, title: '待收录的来源', url: 'https://example.org/preview', authors: 'Example', year: '2026' };
async function boot(page: Page, seed = createSeed()) {
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/sources/resolve', route => route.fulfill({ json: candidate }));
  await page.route('**/api/sources/pdf', route => route.fulfill({ status: 404, json: { error: '没有全文' } }));
  await page.goto('/'); await expect(pane(page, 1)).toBeVisible(); await saved(page);
}

test('打开论文保留右侧卡片，右侧阅读转入新分屏保留自己的阅读位置', async ({ page }) => {
  const seed = createSeed();
  seed.sessions['research-a'].panel = { ...seed.sessions['research-a'].panel, mode: 'cards', ref: { kind: 'card', id: 'card-a' } };
  await boot(page, seed);
  await openResearchPage(page, '资料');
  await pane(page, 1).getByRole('button', { name: paper, exact: true }).click();
  await waitForPdf(pane(page, 1));
  await expect(panel(page).getByLabel('卡片标题')).toHaveValue('相关性是检索收益的前提');
  const original = groups((await layout(page)).root)[0];
  const originalView = original.activeTabId!;
  await pane(page, 1).getByLabel('PDF 页码', { exact: true }).fill('2');
  await openResearchPage(page, '资料');
  await pane(page, 1).getByRole('button', { name: `${paper} 的更多操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: '在右侧预览', exact: true }).click();
  await waitForPdf(panel(page));
  await panel(page).getByLabel('PDF 页码', { exact: true }).fill('3');
  await panel(page).getByRole('button', { name: '放大 PDF', exact: true }).click();
  await saved(page);
  const referencePosition = (await state(page)).sessions['research-a'].readers['inspector:paper-a'];
  await panel(page).getByRole('button', { name: `${paper} 的更多操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: '在新分屏打开', exact: true }).click();
  await expect(pane(page, 2).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(panel(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  const current = groups((await layout(page)).root);
  expect(current[0].tabs.find(tab => tab.id === originalView)?.reading?.pageIndex).toBe(1);
  expect(current[1].tabs[0].reading?.scale).toBe(referencePosition.scale);
});

test('全局搜索查看不隐式加入研究，返回恢复布局，明确加入才创建关联', async ({ page }) => {
  const seed = createSeed();
  const title = '待选的全局资料';
  seed.documents.global = { id: 'global', title, authors: '', year: '', textStatus: 'pending', readingStatus: 'unread' };
  await boot(page, seed);
  await split(page, pane(page, 1), '右');
  const before = (await layout(page)).root;
  await page.getByRole('button', { name: '全局搜索', exact: true }).click();
  await page.getByLabel('搜索全部资料').fill(title);
  await page.getByRole('dialog', { name: '全局搜索' }).getByRole('button', { name: `${title} 在资料库查看` }).click();
  await expect(page.getByLabel('资料标题', { exact: true })).toHaveValue(title);
  expect((await state(page)).scope).toEqual({ kind: 'library' });
  expect((await state(page)).researches['research-a'].documentIds).not.toContain('global');
  await page.getByRole('button', { name: '返回研究', exact: true }).click();
  expect((await state(page)).scope).toEqual({ kind: 'research', researchId: 'research-a' });
  expect((await layout(page)).root).toEqual(before);
  await page.getByRole('button', { name: '全局搜索', exact: true }).click();
  await page.getByLabel('搜索全部资料').fill(title);
  await page.getByRole('button', { name: `加入当前研究并打开 ${title}`, exact: true }).click();
  expect((await state(page)).researches['research-a'].documentIds).toContain('global');
  await expect(pane(page, 2).getByLabel('资料标题', { exact: true })).toHaveValue(title);
  expect(Object.values((await state(page)).documents).filter(doc => doc.title === title)).toHaveLength(1);
});

test('预览中收录保留原预览和其他窗格，全文不可用仍保存一份资料', async ({ page }) => {
  const seed = createSeed();
  seed.sessions['research-a'].sourcePreview = { candidate };
  await boot(page, seed);
  const left = pane(page, 1); await expect(left.getByRole('heading', { name: candidate.title, exact: true })).toBeVisible();
  const right = await split(page, left, '右');
  const before = groups((await layout(page)).root).map(group => ({ id: group.id, activeTabId: group.activeTabId }));
  await left.getByRole('button', { name: '加入本研究', exact: true }).click();
  await expect(left.getByRole('button', { name: '打开资料', exact: true })).toBeVisible();
  await expect(right.getByRole('button', { name: '打开资料', exact: true })).toBeVisible();
  expect(groups((await layout(page)).root).map(group => ({ id: group.id, activeTabId: group.activeTabId }))).toEqual(before);
  const docs = Object.values((await state(page)).documents).filter(doc => doc.identifiers?.url === candidate.url);
  expect(docs).toHaveLength(1);
  expect((await state(page)).researches['research-a'].documentIds).toContain(docs[0].id);
  expect(docs[0].assetId).toBeUndefined();
});

test('添加资料明确改选另一研究后，收录和打开成功且原研究布局保留', async ({ page }) => {
  await boot(page);
  const before = JSON.parse(JSON.stringify((await layout(page)).root));
  await page.getByRole('button', { name: '添加资料', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加资料', exact: true });
  await dialog.getByLabel('添加资料的目标研究').selectOption('research-b');
  const title = '明确收录到研究 B 的新资料';
  await dialog.getByLabel('标识、链接或资料标题').fill(title);
  await dialog.getByRole('button', { name: /按标题新建/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('资料标题', { exact: true })).toHaveValue(title);
  const data = await state(page), document = Object.values(data.documents).find(doc => doc.title === title)!;
  expect(data.scope).toEqual({ kind: 'research', researchId: 'research-b' });
  expect(data.researches['research-b'].documentIds).toContain(document.id);
  expect(data.researches['research-a'].documentIds).not.toContain(document.id);
  // Leaving the view may checkpoint its previously implicit zero scroll position.
  expect(data.sessions['research-a'].layout!.root).toMatchObject(before);
});
