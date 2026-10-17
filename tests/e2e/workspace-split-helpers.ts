import { expect, type Locator, type Page } from '@playwright/test';
import type { PaneNode, WorkspaceData } from '../../src/domain/types';
import { createSeed } from '../../src/data/seed';
import { mockProjectService } from './project-fixture';
import { openResearchPage, openSource } from './knowledge-helpers';

export const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
export const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
export const panes = (page: Page) => main(page).getByRole('region', { name: /^工作区窗格 \d+$/ });
export const pane = (page: Page, index: number) => main(page).getByRole('region', { name: `工作区窗格 ${index}`, exact: true });
export const paneById = (page: Page, id: string) => main(page).locator(`[data-pane-id="${id}"]`);
export const focusedPane = (page: Page) => main(page).locator('[data-pane-id][data-focused="true"]');
export const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
export const groups = (node: PaneNode): Extract<PaneNode, { kind: 'group' }>[] => node.kind === 'group' ? [node] : [...groups(node.first), ...groups(node.second)];

export async function state(page: Page): Promise<WorkspaceData> {
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

export async function layout(page: Page, researchId?: string) {
  const data = await state(page);
  const key = researchId ?? (data.scope.kind === 'research' ? data.scope.researchId : 'library');
  return data.sessions[key].layout!;
}

export async function start(page: Page, seed = createSeed()) {
  seed.panelWidth = 340;
  seed.sessions['research-a'].panel.mode = 'ai';
  seed.researches['research-b'].documentIds = ['paper-a', 'paper-c'];
  seed.researches['research-b'].cardIds = ['card-c'];
  for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'demo';
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: true, model: 'pane-fixture', mode: 'demo', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/chat', () => { throw new Error('Pane tests must not call a real model'); });
  await page.goto('/');
  await expect(main(page)).toBeVisible();
  await openSource(page, seed.documents['paper-a'].title);
  await waitForPdf(pane(page, 1));
}

export async function waitForPdf(target: Locator) {
  await expect(target.locator('canvas').first()).toBeVisible();
  await expect(target.locator('.pdf-page-loading')).toHaveCount(0);
}

export async function goTo(target: Locator, pageNumber: number) {
  await target.getByLabel('PDF 页码', { exact: true }).fill(String(pageNumber));
  await expect(target.getByLabel('PDF 页码', { exact: true })).toHaveValue(String(pageNumber));
  await expect(target.locator(`.pdf-sheet[data-page-index="${pageNumber - 1}"] canvas`)).toBeVisible();
  await expect(target.locator('.pdf-page-loading')).toHaveCount(0);
  await expectPageTop(target, pageNumber);
}

export async function expectPageTop(target: Locator, pageNumber: number) {
  await expect.poll(() => target.locator(`.pdf-sheet[data-page-index="${pageNumber - 1}"]`).evaluate(sheet => {
    const scroll = sheet.closest('.pdf-scroll')!;
    return Math.abs(sheet.getBoundingClientRect().top - scroll.getBoundingClientRect().top - parseFloat(getComputedStyle(scroll).paddingTop));
  })).toBeLessThanOrEqual(2);
}

export async function paneAction(page: Page, target: Locator, action: string) {
  await target.getByRole('button', { name: /^窗格 \d+ 操作$/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: action, exact: true }).click();
}

export async function split(page: Page, target: Locator, direction: '左' | '右' | '上' | '下' = '右') {
  const previous = new Set(groups((await layout(page)).root).map(group => group.id));
  await paneAction(page, target, `向${direction}分屏`);
  await expect(panes(page)).toHaveCount(previous.size + 1);
  const added = groups((await layout(page)).root).find(group => !previous.has(group.id));
  expect(added).toBeTruthy();
  return paneById(page, added!.id);
}

export async function openCard(page: Page, title: string) {
  await openResearchPage(page, '卡片');
  await main(page).getByRole('button', { name: title, exact: true }).click();
  await panel(page).getByRole('button', { name: /^在主区打开/ }).click();
  await expect(focusedPane(page).getByLabel('卡片标题')).toHaveValue(title);
}

export async function dragView(page: Page, tabId: string, target: Locator, side: 'left' | 'right' | 'up' | 'down' | 'center', copy = false, beforeDrop?: () => Promise<void>) {
  const tab = main(page).getByRole('tab').and(main(page).locator(`[data-tab-id="${tabId}"]`));
  await tab.scrollIntoViewIfNeeded();
  const from = (await tab.boundingBox())!;
  const body = (await target.locator('[data-pane-content]').boundingBox())!;
  const point = {
    x: side === 'left' ? body.x + 8 : side === 'right' ? body.x + body.width - 8 : body.x + body.width / 2,
    y: side === 'up' ? body.y + 8 : side === 'down' ? body.y + body.height - 8 : body.y + body.height / 2,
  };
  if (copy) await page.keyboard.down('Alt');
  try {
    await page.mouse.move(from.x + Math.min(30, from.width / 2), from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + Math.min(30, from.width / 2) + 12, from.y + from.height / 2, { steps: 4 });
    await page.mouse.move(point.x, point.y, { steps: 14 });
    // HTML5 needs dragover on the final PDF child before accepting a native drop.
    await page.mouse.move(point.x, point.y);
    const preview = target.locator(`.pane-drop-preview[data-drop-side="${side}"]`);
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(copy ? '复制' : '移动');
    await beforeDrop?.();
    await expect(preview).toBeVisible();
    await page.mouse.up();
    await expect(preview).toHaveCount(0);
  } finally {
    await page.mouse.up();
    if (copy) await page.keyboard.up('Alt');
  }
}
