import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { WorkspaceData } from '../../src/domain/types';
import { mockProjectService } from './project-fixture';
import { openResearchPage, openSource, switchResearch } from './knowledge-helpers';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const primary = (page: Page) => main(page).getByRole('region', { name: '中央主窗', exact: true });
const secondary = (page: Page) => main(page).getByRole('region', { name: '中央对照窗', exact: true });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');

async function state(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const journal = localStorage.getItem('papertrail-recovery-v3');
    if (journal) return JSON.parse(journal);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { return await new Promise<WorkspaceData>((resolve, reject) => {
      const request = db.transaction('workspace').objectStore('workspace').get('current');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  });
}

async function start(page: Page) {
  const seed = createSeed();
  seed.panelWidth = 340; seed.sessions['research-a'].panel.mode = 'ai';
  seed.researches['research-b'].documentIds = ['paper-a', 'paper-c'];
  seed.researches['research-b'].cardIds = ['card-c'];
  for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'demo';
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: true, model: 'split-fixture', mode: 'demo', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/chat', () => { throw new Error('Split tests must not call a real model'); });
  await page.goto('/');
  await expect(main(page)).toBeVisible();
  await openSource(page, seed.documents['paper-a'].title);
  await expect(primary(page).locator('.pdf-page-loading')).toHaveCount(0);
  await expect(primary(page).locator('canvas').first()).toBeVisible();
  await main(page).getByRole('button', { name: '分屏阅读', exact: true }).click();
  await expect(main(page).getByLabel('选择对照内容')).toBeVisible();
}

async function goTo(pane: Locator, page: number) {
  await pane.getByLabel('PDF 页码', { exact: true }).fill(String(page));
  await expect(pane.locator('.pdf-page-loading')).toHaveCount(0);
  await expect.poll(() => pane.locator(`.pdf-sheet[data-page-index="${page - 1}"]`).evaluate(sheet => {
    const scroll = sheet.closest('.pdf-scroll')!;
    return Math.abs(sheet.getBoundingClientRect().top - scroll.getBoundingClientRect().top - parseFloat(getComputedStyle(scroll).paddingTop));
  })).toBeLessThanOrEqual(2);
}

test('中央可同时阅读两篇论文，独立翻页缩放与阅读状态，右侧 AI 草稿不变', async ({ page }) => {
  await start(page);
  await openResearchPage(page, '研究主页');
  await expect(page.getByRole('button', { name: /^在对照窗打开 / })).toHaveCount(0);
  await openResearchPage(page, '资料');
  await expect(page.getByRole('button', { name: /^在对照窗打开 / })).toHaveCount(0);
  await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
  await expect(page.getByRole('button', { name: '在对照窗打开 Adaptive Retrieval: Evidence & Reliability', exact: true })).toBeVisible();
  const question = '这两篇论文对证据相关性的观点有何不同？';
  await panel(page).getByLabel('向 AI 提问').fill(question);
  await main(page).getByLabel('选择对照内容').selectOption('document:paper-b');
  await goTo(primary(page), 3); await goTo(secondary(page), 2);
  await secondary(page).getByRole('button', { name: '放大 PDF', exact: true }).click();
  await secondary(page).getByRole('button', { name: '略读过', exact: true }).click();
  await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(primary(page).locator('.pdf-zoom')).toContainText('100%');
  await expect(secondary(page).locator('.pdf-zoom')).toContainText('125%');
  const current = await state(page);
  expect(current.documents['paper-b'].readingStatus).toBe('skimmed');
  expect(current.documents['paper-a'].readingStatus).toBe('reading');
  expect(current.sessions['research-a'].active).toEqual({ kind: 'document', id: 'paper-a' });
  expect(current.sessions['research-a'].mainSplit?.ref).toEqual({ kind: 'document', id: 'paper-b' });
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue(question);
  await saved(page); await page.reload();
  await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
  await expect(secondary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(secondary(page).locator('.pdf-zoom')).toContainText('125%');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue(question);
  await main(page).getByRole('button', { name: '关闭阅读器分屏', exact: true }).click();
  await main(page).getByRole('button', { name: '分屏阅读', exact: true }).click();
  await expect(main(page).getByLabel('选择对照内容')).toHaveValue('document:paper-b');
  await expect(secondary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(secondary(page).locator('.pdf-zoom')).toContainText('125%');
  await main(page).getByRole('button', { name: '关闭阅读器分屏', exact: true }).click();
  await page.getByRole('button', { name: '在对照窗打开 Retrieval Baselines & Trade-offs', exact: true }).click();
  await expect(main(page).getByLabel('选择对照内容')).toHaveValue('document:paper-b');
  await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
});

test('论文与卡片、两张卡片共用实体，切换与关闭分屏保留编辑内容', async ({ page }) => {
  await start(page);
  await main(page).getByLabel('选择对照内容').selectOption('card:card-a');
  await expect(primary(page).getByRole('region', { name: 'PDF 阅读器 主区', exact: true })).toBeVisible();
  const note = '对照论文原文：收益以相关证据覆盖为前提。';
  await secondary(page).getByLabel('卡片正文').fill(note);
  await main(page).getByLabel('选择主窗内容').selectOption('card:card-b');
  await primary(page).getByLabel('卡片正文').fill('另一张卡片：无关材料可能放大不确定性。');
  await expect(secondary(page).getByLabel('卡片正文')).toHaveValue(note);
  await main(page).getByLabel('选择主窗内容').selectOption('card:card-a');
  await expect(primary(page).getByLabel('卡片正文')).toHaveValue(note);
  const updated = `${note}\n已在主窗补充适用条件。`;
  await primary(page).getByLabel('卡片正文').fill(updated);
  await expect(secondary(page).getByLabel('卡片正文')).toHaveValue(updated);
  await main(page).getByLabel('选择对照内容').selectOption('card:card-b');
  await main(page).getByRole('button', { name: '关闭阅读器分屏', exact: true }).click();
  await main(page).getByRole('button', { name: '分屏阅读', exact: true }).click();
  await expect(main(page).getByLabel('选择对照内容')).toHaveValue('card:card-b');
  await expect(secondary(page).getByLabel('卡片正文')).toHaveValue('另一张卡片：无关材料可能放大不确定性。');
  await main(page).getByRole('button', { name: '关闭阅读器分屏', exact: true }).click();
  await expect(primary(page).getByLabel('卡片正文')).toHaveValue(updated);
  await saved(page); await page.reload();
  await expect(primary(page).getByLabel('卡片正文')).toHaveValue(updated);
  expect((await state(page)).cards['card-b'].body).toContain('无关材料可能放大不确定性');
});

test('分屏内容与可选资源按研究隔离，返回原研究恢复原对照', async ({ page }) => {
  await start(page);
  await main(page).getByLabel('选择对照内容').selectOption('document:paper-b');
  await goTo(secondary(page), 2);
  await switchResearch(page, 'research-b');
  await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
  await expect(main(page).getByLabel('选择对照内容')).toHaveCount(0);
  await main(page).getByRole('button', { name: '分屏阅读', exact: true }).click();
  const available = await main(page).getByLabel('选择对照内容').locator('option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value));
  expect(available).toContain('document:paper-c'); expect(available).toContain('card:card-c');
  expect(available).not.toContain('document:paper-b'); expect(available).not.toContain('card:card-a');
  await main(page).getByLabel('选择对照内容').selectOption('card:card-c');
  await switchResearch(page, 'research-a');
  await expect(main(page).getByLabel('选择对照内容')).toHaveValue('document:paper-b');
  await expect(secondary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  expect((await state(page)).sessions['research-b'].mainSplit?.ref).toEqual({ kind: 'card', id: 'card-c' });
});

for (const width of [1440, 1280, 1024]) test(`PDF 与知识卡片对照 ${width}px，右侧 AI 保持可用`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
  await start(page);
  await main(page).getByLabel('选择对照内容').selectOption('card:card-a');
  await main(page).getByLabel('阅读器分屏方向').selectOption('horizontal');
  await expect(secondary(page).getByLabel('卡片正文')).toBeVisible();
  await expect(primary(page).locator('.pdf-page-loading')).toHaveCount(0);
  await expect(panel(page).getByLabel('向 AI 提问')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await saved(page); await page.evaluate(() => document.fonts.ready);
  await mkdir('docs/verification/reader-images', { recursive: true });
  await page.screenshot({ path: `docs/verification/reader-images/workspace-pdf-card-${width}.png` });
});
