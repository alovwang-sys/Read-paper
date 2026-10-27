import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { chat, composer, controlledSeed, installControlledServices, main, openSeedPaper, readData, saved } from '../../docs/verification/continuous-workspace/harness';
import { openResearchNavigation, switchResearch } from './knowledge-helpers';
import type { Conversation } from '../../src/domain/types';

test.use({ storageState: { cookies: [], origins: [] } });
const history = (page: Page) => page.getByRole('region', { name: '研究会话列表', exact: true });
const group = (page: Page, key: string) => history(page).locator(`[data-discussion-group="${key}"]`);
const toggle = (page: Page, key: string) => group(page, key).getByRole('button', { name: /^切换来源讨论：/ });

test('来源各自折叠，搜索临时展开，主动打开、回答、刷新与研究切换保持正确状态', async ({ page }) => {
  test.setTimeout(90000);
  const seed = controlledSeed();
  const add = (id: string, title: string, extra: Partial<Conversation>) => {
    seed.conversations[id] = { id, researchId: 'research-a', contextIds: [], requestIds: [], connectionId: 'codex', title, titleEdited: true, ...extra };
  };
  add('passage-a', '第一篇论文问题', { contextIds: ['evidence-a'], inlineSource: { documentId: 'paper-a', pageIndex: 2, evidenceId: 'evidence-a', operation: 'question' } });
  add('passage-b', '第二篇论文问题', { contextIds: ['evidence-b'], inlineSource: { documentId: 'paper-b', pageIndex: 0, evidenceId: 'evidence-b', operation: 'question' } });
  add('board-discussion-a', '第一块白板问题', { anchor: { kind: 'board', id: 'board-a' } });
  add('board-discussion-a2', '第二块白板问题', { anchor: { kind: 'board', id: 'board-a2' } });
  add('other-research-board', '另一研究白板问题', { researchId: 'research-b', anchor: { kind: 'board', id: 'board-b' } });
  const fixture = await installControlledServices(page, { seed });
  await page.goto('/');
  await expect(main(page).locator('.pdf-text-layer span').first()).toBeVisible({ timeout: 30000 });
  await openSeedPaper(page); await openResearchNavigation(page);
  const outer = history(page).getByText(/^讨论（\d+）$/).locator('..');
  const search = history(page).getByRole('textbox', { name: '搜索会话', exact: true });
  await expect(outer).toHaveJSProperty('open', false);
  await search.fill('第二块白板问题');
  await expect(outer).toHaveJSProperty('open', true);
  await expect(toggle(page, 'board:board-a2')).toHaveAttribute('aria-expanded', 'true');
  await expect(group(page, 'board:board-a2').getByRole('button', { name: '打开讨论：第二块白板问题', exact: true })).toBeVisible();
  await saved(page);
  expect((await readData(page)).sessions['research-a'].discussionGroups?.['board:board-a2']).toBe(false);
  await search.fill('');
  await expect(outer).toHaveJSProperty('open', false);
  await history(page).getByText('讨论（4）', { exact: true }).click();
  await expect(toggle(page, 'document:paper-a')).toHaveAttribute('aria-expanded', 'true');
  for (const key of ['document:paper-b', 'board:board-a', 'board:board-a2']) await expect(toggle(page, key)).toHaveAttribute('aria-expanded', 'false');
  await toggle(page, 'document:paper-b').click();
  await expect(group(page, 'document:paper-b').getByRole('button', { name: '打开讨论：第二篇论文问题', exact: true })).toBeVisible();
  await toggle(page, 'document:paper-b').click();

  await expect(toggle(page, 'board:board-a2')).toHaveAttribute('aria-expanded', 'false');

  await toggle(page, 'board:board-a').click();
  await group(page, 'board:board-a').getByRole('button', { name: '打开讨论：第一块白板问题', exact: true }).click();
  await expect(chat(page).getByRole('button', { name: '选择会话', exact: true })).toContainText('第一块白板问题');
  await toggle(page, 'board:board-a').click();
  await composer(page).fill('新回答不展开手动收起的来源');
  await chat(page).getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(chat(page)).toContainText('受控研究回答 1');
  await expect(toggle(page, 'board:board-a')).toHaveAttribute('aria-expanded', 'false');
  await history(page).getByText('讨论（4）', { exact: true }).click();
  await chat(page).getByRole('button', { name: '选择会话', exact: true }).click();
  await page.getByRole('dialog', { name: '选择会话', exact: true }).getByRole('button', { name: `${seed.boards['board-a'].title} · 第一块白板问题`, exact: true }).click();
  await expect(toggle(page, 'board:board-a')).toHaveAttribute('aria-expanded', 'true');
  await expect(group(page, 'board:board-a').getByRole('button', { name: '打开讨论：第一块白板问题', exact: true })).toBeVisible();
  await toggle(page, 'board:board-a').click(); await saved(page);
  const retained = (await readData(page)).sessions['research-a'].discussionGroups;

  await page.reload(); await openSeedPaper(page); await openResearchNavigation(page);
  await expect(toggle(page, 'board:board-a')).toHaveAttribute('aria-expanded', 'false');
  expect((await readData(page)).sessions['research-a'].discussionGroups).toEqual(retained);
  await switchResearch(page, 'research-b');
  if (!await toggle(page, 'board:board-b').isVisible()) await history(page).getByText('讨论（1）', { exact: true }).click();
  await toggle(page, 'board:board-b').click(); await saved(page);
  expect((await readData(page)).sessions['research-a'].discussionGroups).toEqual(retained);
  await switchResearch(page, 'research-a');
  await expect(toggle(page, 'board:board-a')).toHaveAttribute('aria-expanded', 'false');

  await mkdir('docs/verification/discussion-groups/screenshots', { recursive: true });
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height }); await openResearchNavigation(page);
    await expect(toggle(page, 'board:board-a')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await saved(page); await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `docs/verification/discussion-groups/screenshots/groups-${width}.png` });
  }
  fixture.assertClean();
});
