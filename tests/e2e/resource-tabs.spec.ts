import { openResearchPage, switchResearch } from './knowledge-helpers';
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { groups, layout, pane, paneAction, state } from './workspace-split-helpers';

const paperA = 'Adaptive Retrieval: Evidence & Reliability';
const paperB = 'Retrieval Baselines & Trade-offs';
const research = '资料';
const writing = '检索增强的适用条件';
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const tabs = (page: Page) => page.getByRole('tablist', { name: /^(中央资源标签|窗格 1 标签)$/ });
async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
}
async function setup(page: Page) {
  await page.route('**/api/ai/config', route => route.fulfill({ json: {
    configured: true, model: 'tabs-test', provider: '确定性测试', images: false, mode: 'live',
    limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 },
  } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/chat', route => route.fulfill({
    contentType: 'application/x-ndjson',
    body: JSON.stringify({ type: 'delta', text: '这项结论的适用条件需要对照原文核查。 [1]' }) + '\n' + JSON.stringify({ type: 'done', model: 'tabs-test' }) + '\n',
  }));
  await page.goto('/');
  await expect(main(page)).toBeVisible();
  await openResearchPage(page, '资料');
  await expect(tabs(page).getByRole('tab', { name: research, exact: true })).toBeVisible();
}
async function openPaper(page: Page, title: string) {
  await main(page).getByRole('button', { name: title, exact: true }).click();
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
}

test('资源标签复用打开项，支持固定、排序、键盘管理、刷新及研究隔离', async ({ page }) => {
  await setup(page);
  await openPaper(page, paperA);
  await openResearchPage(page, '资料');
  await openPaper(page, paperB);
  await openResearchPage(page, '资料');
  await openResearchPage(page, '检索增强的适用条件');
  await main(page).getByLabel('结论正文').fill('切换、关闭和刷新后保留的结论内容。');
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await panel(page).getByLabel('向 AI 提问').fill('切换资源时保留的未发送问题');
  await tabs(page).getByRole('button', { name: `关闭标签 ${paperB}`, exact: true }).click();
  await expect(tabs(page).getByRole('tab')).toHaveCount(4);
  for (const label of ['研究主页', research]) {
    await expect(tabs(page).getByRole('tab', { name: label, exact: true })).toHaveCount(1);
    await tabs(page).getByRole('button', { name: `关闭标签 ${label}`, exact: true }).click();
  }
  await expect(tabs(page).getByRole('tab')).toHaveCount(2);
  await expect(tabs(page).getByRole('button', { name: `关闭标签 ${research}`, exact: true })).toHaveCount(0);
  const tabA = tabs(page).getByRole('tab', { name: paperA, exact: true });
  await tabA.click();
  await paneAction(page, pane(page, 1), '固定当前标签');
  await tabA.focus(); await tabA.press('Alt+ArrowRight');
  await expect.poll(async () => groups((await layout(page)).root)[0].tabs.map(tab => tab.ref.id)).toEqual(['draft-a', 'paper-a']);
  await tabA.press('Alt+ArrowLeft');
  await expect.poll(async () => groups((await layout(page)).root)[0].tabs.map(tab => tab.ref.id)).toEqual(['paper-a', 'draft-a']);
  await tabA.focus(); await tabA.press('Home');
  await expect(tabA).toHaveAttribute('aria-selected', 'true');
  await tabA.press('End');
  await expect(tabs(page).getByRole('tab', { name: writing, exact: true })).toHaveAttribute('aria-selected', 'true');
  await tabs(page).getByRole('tab', { name: writing, exact: true }).press('Escape');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('切换资源时保留的未发送问题');
  await saved(page); await page.reload();
  await expect(main(page).getByLabel('结论正文')).toHaveValue('切换、关闭和刷新后保留的结论内容。');
  await expect(tabs(page).getByRole('tab')).toHaveText([paperA, writing]);
  expect((await state(page)).sessions['research-a'].pinnedIds).toContain('paper-a');
  await switchResearch(page, 'research-b');
  await expect(tabs(page).getByRole('tab')).toHaveText(['研究主页']);
  if (!(await page.getByRole('button', { name: '切换研究', exact: true }).isVisible())) await page.getByRole('button', { name: '展开左栏', exact: true }).click();
  await switchResearch(page, 'research-a');
  await expect(tabs(page).getByRole('tab')).toHaveText([paperA, writing]);
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('切换资源时保留的未发送问题');
  await tabs(page).getByRole('tab', { name: writing, exact: true }).focus();
  await tabs(page).getByRole('tab', { name: writing, exact: true }).press('End');
  await expect(tabs(page).getByRole('tab', { name: writing, exact: true })).toHaveAttribute('aria-selected', 'true');
  await tabs(page).getByRole('tab', { name: writing, exact: true }).press('ArrowLeft');
  await expect(tabA).toHaveAttribute('aria-selected', 'true');
  await tabA.press('Delete');
  await expect(tabA).toHaveCount(0);
  expect((await state(page)).documents['paper-a']).toBeTruthy();
  await tabs(page).getByRole('tab', { name: writing, exact: true }).click();
  await expect(main(page).getByLabel('结论正文')).toHaveValue('切换、关闭和刷新后保留的结论内容。');
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`引用另开并复用专用视图，保留普通阅读位置、对话和分页 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport); await setup(page);
    await openPaper(page, paperA);
    const ordinaryView = groups((await layout(page)).root)[0].tabs.find(tab => tab.ref.id === 'paper-a')!;
    await panel(page).getByRole('tab', { name: '摘录', exact: true }).click();
    await panel(page).locator('[data-evidence-id="evidence-a"]').getByRole('button', { name: '加入 AI', exact: true }).click();
    await openResearchPage(page, '资料');
    await openPaper(page, paperB);
    await main(page).getByLabel('PDF 页码').fill('2'); await main(page).getByLabel('PDF 页码').press('Enter');
    await panel(page).getByLabel('向 AI 提问').fill('请解释所选证据');
    await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
    const citation = panel(page).getByRole('button', { name: /^引用 1：/ });
    await expect(citation).toBeVisible();
    await panel(page).getByLabel('向 AI 提问').fill('同屏核查后继续完善的问题');
    let citationViewId: string | undefined;
    for (let index = 0; index < 2; index++) {
      await citation.click();
      await expect(main(page).getByLabel('PDF 页码')).toHaveValue('3');
      const current = groups((await layout(page)).root)[0];
      const views = current.tabs.filter(tab => tab.ref.id === 'paper-a');
      expect(views).toHaveLength(2);
      expect(views.find(tab => tab.id === ordinaryView.id)?.reading?.pageIndex ?? 0).toBe(0);
      const citationView = views.find(tab => tab.id !== ordinaryView.id)!;
      citationViewId ??= citationView.id;
      expect(citationView.id).toBe(citationViewId);
      expect(current.activeTabId).toBe(citationViewId);
      await expect(tabs(page).getByRole('tab').and(tabs(page).locator(`[data-tab-id="${citationViewId}"]`))).toHaveAttribute('aria-selected', 'true');
      await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('同屏核查后继续完善的问题');
    }
    await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
    const bounds = (await main(page).locator('canvas').first().boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual((await panel(page).boundingBox())!.x + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await saved(page);
    await mkdir('docs/verification/pane-navigation', { recursive: true });
    await page.screenshot({ path: `docs/verification/pane-navigation/resource-tabs-${viewport.width}.png` });
    await tabs(page).getByRole('tab', { name: paperB, exact: true }).click();
    await expect(main(page).getByLabel('PDF 页码')).toHaveValue('2');
    await saved(page); await page.reload();
    await expect(main(page).getByLabel('PDF 页码')).toHaveValue('2');
    await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('同屏核查后继续完善的问题');
  });
}
