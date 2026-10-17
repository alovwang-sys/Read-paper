import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { openResearchPage, switchResearch } from './knowledge-helpers';
import type { WorkspaceData } from '../../src/domain/types';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
async function data(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => { const recovery = localStorage.getItem('papertrail-recovery-v3'); if (recovery) return JSON.parse(recovery); const path = '/src/data/storage.ts'; return (await import(path)).loadWorkspace(); });
}

test('从结论找依据、人工核对和补引用，出处链保留并定位原文，跨研究及刷新恢复', async ({ page }) => {
  await page.goto('/');
  await main(page).getByRole('button', { name: '找依据', exact: true }).click();
  await expect(panel(page).getByRole('heading', { name: '为「检索的边界仍需补充实验」找依据' })).toBeVisible();
  const candidate = panel(page).locator('.excerpt-candidate').filter({ hasText: 'Retrieval improves factual accuracy' });
  await candidate.getByRole('button', { name: '作为依据', exact: true }).click();
  await expect(candidate.getByRole('button', { name: '已作为依据', exact: true })).toBeDisabled();
  await panel(page).getByRole('button', { name: '完成', exact: true }).click();
  await expect(panel(page).getByLabel('待核查', { exact: true })).toBeChecked();
  await panel(page).getByLabel('待核查', { exact: true }).uncheck();
  await openResearchPage(page, '研究主页');
  await expect(main(page).getByRole('button', { name: '找依据', exact: true })).toHaveCount(0);
  await main(page).getByRole('button', { name: '补引用', exact: true }).click();
  await expect(main(page).getByRole('region', { name: '补引用', exact: true })).toBeVisible();
  const bodyBefore = await main(page).getByLabel('结论正文').inputValue();
  await main(page).getByLabel('结论正文').click();
  await main(page).getByLabel('结论正文').press('End');
  await main(page).getByRole('button', { name: '在光标处补引用', exact: true }).click();
  expect(await main(page).getByLabel('结论正文').inputValue()).toBe(`${bodyBefore}[1]`);
  await main(page).getByRole('button', { name: '预览引用', exact: true }).click();
  await main(page).getByRole('button', { name: '[1]', exact: true }).click();
  await expect(panel(page).getByRole('region', { name: '出处链' })).toBeVisible();
  await expect(panel(page).getByText('检索的边界仍需补充实验', { exact: true })).toBeVisible();
  await panel(page).getByRole('button', { name: '在主区打开原文 ↗', exact: true }).click();
  await expect(main(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(main(page).locator('.pdf-source-highlight').first()).toBeVisible();
  await expect(panel(page).getByRole('region', { name: '出处链' })).toBeVisible();
  await mkdir('docs/verification/knowledge-flow', { recursive: true });
  await page.screenshot({ path: 'docs/verification/knowledge-flow/trace-source-1440.png' });
  await saved(page);
  await switchResearch(page, 'research-b');
  await expect(panel(page).getByRole('region', { name: '出处链' })).toHaveCount(0);
  await switchResearch(page, 'research-a');
  await expect(main(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(panel(page).getByRole('region', { name: '出处链' })).toBeVisible();
  await saved(page); await page.reload();
  await expect(main(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(panel(page).getByRole('region', { name: '出处链' })).toBeVisible();
  await openResearchPage(page, '研究主页');
  await expect(main(page).getByText('文稿里的每处引用都能回到原文。')).toBeVisible();
});

test('无效正文引用可提示修复，不写入损坏的出处链状态；页面返回同步中央首标签', async ({ page }) => {
  await page.goto('/');
  await openResearchPage(page, '资料'); await openResearchPage(page, '摘录');
  await page.getByRole('button', { name: '主区返回', exact: true }).click();
  await expect(page.getByRole('tablist', { name: '中央资源标签' }).getByRole('tab', { name: '资料', exact: true })).toHaveAttribute('aria-selected', 'true');
  await openResearchPage(page, '检索增强的适用条件');
  await main(page).getByLabel('结论正文').fill('需要修复的引用 [99]。');
  await main(page).getByRole('button', { name: '预览引用' }).click();
  await main(page).getByRole('button', { name: '[99]', exact: true }).click();
  await expect(main(page).getByRole('alert')).toContainText('没有对应的原文证据');
  expect((await data(page)).sessions['research-a'].panel.citation).toBeUndefined();
});

test('三种宽度覆盖主PDF＋卡片、白板＋右原文、文稿＋AI，并验证1024抽屉焦点', async ({ page }) => {
  await mkdir('docs/verification/knowledge-flow', { recursive: true });
  await page.goto('/');
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await openResearchPage(page, '卡片');
    await main(page).getByRole('button', { name: '相关性是检索收益的前提', exact: true }).click();
    await openResearchPage(page, '资料');
    await main(page).getByRole('button', { name: 'Adaptive Retrieval: Evidence & Reliability', exact: true }).click();
    await expect(main(page).locator('canvas').first()).toBeVisible();
    await panel(page).getByRole('tab', { name: '卡片', exact: true }).click();
    await expect(panel(page).getByLabel('卡片标题')).toHaveValue('相关性是检索收益的前提');
    await page.screenshot({ path: `docs/verification/knowledge-flow/pdf-card-${width}.png` });
    await openResearchPage(page, '证据与论证');
    await main(page).getByRole('button', { name: '查看卡片原文：相关性是检索收益的前提', exact: true }).click();
    await expect(panel(page).getByLabel('PDF 页码')).toHaveValue('3');
    await expect(panel(page).locator('canvas').first()).toBeVisible();
    await page.screenshot({ path: `docs/verification/knowledge-flow/board-source-${width}.png` });
    await openResearchPage(page, '检索增强的适用条件');
    await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await expect(panel(page).getByLabel('向 AI 提问')).toBeVisible();
    await page.screenshot({ path: `docs/verification/knowledge-flow/draft-ai-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const boxes = await page.evaluate(() => { const a = document.querySelector('.main-column')!.getBoundingClientRect(); const b = document.querySelector('.inspector')!.getBoundingClientRect(); return { right: a.right, left: b.left }; });
    expect(boxes.right).toBeLessThanOrEqual(boxes.left + 1);
    if (width === 1024) {
      const trigger = page.getByRole('button', { name: '展开左栏', exact: true });
      await trigger.click();
      await expect(page.getByRole('dialog', { name: '左侧导航' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
    }
  }
});

test('阅读器直接补依据，保存失败后切面板、切研究和刷新仍可恢复且不重复', async ({ page }) => {
  await page.goto('/');
  await main(page).getByRole('button', { name: '找依据', exact: true }).click();
  await panel(page).getByRole('button', { name: '去资料里找', exact: true }).click();
  await main(page).getByRole('button', { name: 'Adaptive Retrieval: Evidence & Reliability', exact: true }).click();
  const span = main(page).locator('.pdf-text-layer span').filter({ hasText: 'When does adding a retrieval stage' }).first();
  await expect(span).toBeVisible();
  const quote = await span.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return node.textContent!.replace(/\s+/g, ' ').trim();
  });
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'workspace') throw new DOMException('knowledge-flow test quota', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await main(page).getByRole('button', { name: '作为「检索的边界仍需补充实验」的依据', exact: true }).click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'error');
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await panel(page).getByRole('tab', { name: '卡片', exact: true }).click();
  await expect(panel(page).getByRole('region', { name: '找依据' })).toBeVisible();
  await switchResearch(page, 'research-b'); await switchResearch(page, 'research-a');
  await page.reload(); await saved(page);
  await expect(panel(page).getByRole('region', { name: '找依据' })).toBeVisible();
  const restored = await data(page);
  const matching = Object.values(restored.evidence).filter(e => e.quote === quote && e.researchId === 'research-a');
  expect(matching).toHaveLength(1);
  expect(restored.cards['card-unverified']).toMatchObject({ needsReview: true, evidenceIds: [matching[0].id] });
  await expect(panel(page).locator('.excerpt-candidate').filter({ hasText: quote }).getByRole('button', { name: '已作为依据', exact: true })).toBeDisabled();
  await mkdir('docs/verification/knowledge-flow', { recursive: true });
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await page.screenshot({ path: 'docs/verification/knowledge-flow/find-evidence-1440.png' });
});
