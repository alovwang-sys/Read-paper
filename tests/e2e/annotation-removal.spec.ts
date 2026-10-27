import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { WorkspaceData } from '../../src/domain/types';
import { mockProjectService } from './project-fixture';
import { openResearchPage, openSource, switchResearch } from './knowledge-helpers';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const menu = (page: Page) => page.getByLabel('原文选区操作', { exact: true });
const state = (page: Page): Promise<WorkspaceData> => page.evaluate(async () => {
  const journal = localStorage.getItem('papertrail-recovery-v3');
  if (journal) return JSON.parse(journal);
  const path = '/src/data/storage.ts';
  return (await import(path)).loadWorkspace();
});
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');

async function start(page: Page) {
  const seed = createSeed();
  seed.researches['research-b'].documentIds.push('paper-a');
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: {
    configured: true, model: 'annotation-fixture', provider: '测试', images: true, mode: 'live',
    limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 },
  } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/agents/run', route => route.fulfill({ status: 503, json: { error: '测试禁止本机模型调用' } }));
  await page.route('**/api/ai/chat', route => route.fulfill({
    contentType: 'application/x-ndjson',
    body: '{"type":"delta","text":"模拟回答：证据仍可追溯。 [1]"}\n{"type":"done","model":"annotation-fixture"}\n',
  }));
  await page.goto('/');
  await saved(page);
  await reader(page);
}

async function reader(page: Page) {
  await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
  await expect(main(page).locator('.pdf-text-layer span').filter({ hasText: 'When does adding a retrieval stage' }).first()).toBeVisible();
}

async function selectText(page: Page, text = 'When does adding a retrieval stage') {
  const span = main(page).locator('.pdf-text-layer span').filter({ hasText: text }).first();
  const quote = await span.evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return node.textContent!.replace(/\s+/g, ' ').trim();
  });
  await expect(menu(page)).toBeVisible();
  if (!await menu(page).getByRole('button', { name: '写成卡片', exact: true }).isVisible()) await menu(page).getByLabel('更多操作', { exact: true }).click();
  return quote;
}

async function capture(page: Page, text?: string, researchId = 'research-a') {
  const quote = await selectText(page, text);
  await page.keyboard.press('h');
  await expect.poll(async () => Object.values((await state(page)).evidence).filter(e => e.quote === quote && e.researchId === researchId).length).toBe(1);
  return Object.values((await state(page)).evidence).find(e => e.quote === quote && e.researchId === researchId)!;
}
const mark = (page: Page, id: string) => main(page).locator(`.pdf-excerpt-highlight[data-evidence-id="${id}"]`);

const inline = (page: Page) => page.getByRole('dialog', { name: '原文旁提问', exact: true });
const entry = (page: Page, id: string) => panel(page).locator(`.evidence-entry[data-evidence-id="${id}"]`);
async function clickHighlight(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
async function clickMark(page: Page, id: string) {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await clickHighlight(page, mark(page, id).first());
  await expect(menu(page).getByRole('button', { name: '移除标记', exact: true })).toBeEnabled();
}
async function screenshot(page: Page, name: string) {
  await mkdir('docs/verification/annotation-removal', { recursive: true });
  await page.screenshot({ path: `docs/verification/annotation-removal/${name}.png`, fullPage: true });
}

for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`引用中的文字标记可移除和恢复，刷新与研究隔离 ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await start(page);
    const second = await capture(page, 'This self-authored fixture describes');
    const excerpt = await capture(page);
    await menu(page).getByRole('button', { name: '写成卡片', exact: true }).click();
    await panel(page).getByLabel('卡片标题', { exact: true }).fill('标记移除仍保留观点');
    await panel(page).getByLabel('卡片正文', { exact: true }).fill('保留同一条原文证据，继续核查检索条件。');
    const card = Object.values((await state(page)).cards).find(item => item.title === '标记移除仍保留观点')!;
    await selectText(page);
    await menu(page).getByRole('button', { name: '解释这段', exact: true }).click();
    await expect(inline(page)).toContainText('模拟回答：证据仍可追溯。');
    await expect.poll(async () => Object.values((await state(page)).requests).some(request => request.status === 'generating')).toBe(false);
    const before = await state(page);
    const conversation = Object.values(before.conversations).find(item => item.inlineSource?.evidenceId === excerpt.id)!;
    const request = before.requests[conversation.requestIds[0]];
    expect(request.context.map(item => item.evidenceId)).toContain(excerpt.id);
    await inline(page).getByRole('button', { name: '关闭就地问答并保留内容', exact: true }).click();
    await clickMark(page, excerpt.id);
    await screenshot(page, `remove-menu-${size.width}`);
    await menu(page).getByRole('button', { name: '移除标记', exact: true }).click();
    await expect(mark(page, excerpt.id)).toHaveCount(0);
    await expect(main(page).locator('.pdf-source-highlight')).toHaveCount(0);
    await expect(mark(page, second.id)).not.toHaveCount(0);
    const removed = await state(page);
    expect(removed.evidence[excerpt.id]).toMatchObject({ ...before.evidence[excerpt.id], annotationHidden: true });
    expect(removed.cards[card.id]).toEqual(before.cards[card.id]);
    expect(removed.conversations[conversation.id]).toEqual(before.conversations[conversation.id]);
    expect(removed.requests[request.id]).toEqual(request);
    await expect(entry(page, excerpt.id).getByRole('button', { name: '恢复标记', exact: true })).toBeVisible();
    await screenshot(page, `removed-${size.width}`);
    await saved(page); await page.reload();
    await expect(mark(page, second.id)).not.toHaveCount(0);
    await expect(mark(page, excerpt.id)).toHaveCount(0);
    expect((await state(page)).evidence[excerpt.id].annotationHidden).toBe(true);
    await page.getByRole('button', { name: '上次提问', exact: true }).click();
    await expect(inline(page)).toContainText('模拟回答：证据仍可追溯。');
    await expect.poll(async () => Object.values((await state(page)).requests).some(request => request.status === 'generating')).toBe(false);
    await inline(page).getByRole('button', { name: '[1]', exact: true }).click();
    await expect(main(page).locator('.pdf-source-highlight')).not.toHaveCount(0);
    expect((await state(page)).evidence[excerpt.id].annotationHidden).toBe(true);
    await inline(page).getByRole('button', { name: '关闭就地问答并保留内容', exact: true }).click();
    await entry(page, excerpt.id).getByRole('button', { name: '定位原文', exact: true }).click();
    await expect(main(page).locator('.pdf-source-highlight')).not.toHaveCount(0);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await clickHighlight(page, main(page).locator('.pdf-source-highlight').first());
    await menu(page).getByRole('button', { name: '恢复标记', exact: true }).click();
    await menu(page).getByRole('button', { name: '移除标记', exact: true }).click();
    await expect(main(page).locator('.pdf-source-highlight')).toHaveCount(0);
    // 再选同一段按 H，恢复已有证据而非创建重复来源。
    await capture(page);
    await expect(mark(page, excerpt.id)).not.toHaveCount(0);
    expect((await state(page)).evidence[excerpt.id].annotationHidden).toBeUndefined();
    await entry(page, excerpt.id).getByRole('button', { name: '移除标记', exact: true }).click();
    await expect(mark(page, excerpt.id)).toHaveCount(0);
    await entry(page, excerpt.id).getByRole('button', { name: '恢复标记', exact: true }).click();
    await expect(mark(page, excerpt.id)).not.toHaveCount(0);
    await entry(page, excerpt.id).getByRole('button', { name: '移除标记', exact: true }).click();
    await switchResearch(page, 'research-b'); await reader(page);
    await expect(mark(page, second.id)).toHaveCount(0);
    await expect(mark(page, excerpt.id)).toHaveCount(0);
    const other = await capture(page, undefined, 'research-b');
    expect(other.id).not.toBe(excerpt.id);
    await expect(mark(page, other.id)).not.toHaveCount(0);
    await switchResearch(page, 'research-a');
    await expect(mark(page, second.id)).not.toHaveCount(0);
    await expect(mark(page, excerpt.id)).toHaveCount(0);
    await expect(mark(page, other.id)).toHaveCount(0);
    expect((await state(page)).evidence[other.id].annotationHidden).toBeUndefined();
    await saved(page);
  });
}

test('已保存区域框可直接点开移除，恢复后仍保留图片、卡片与来源定位', async ({ page }) => {
  await start(page);
  await main(page).getByRole('button', { name: '区域框选', exact: true }).click();
  const layer = main(page).getByLabel('拖动框选当前 PDF 页区域', { exact: true });
  const bounds = (await layer.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * .12, bounds.y + bounds.height * .08);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .68, bounds.y + bounds.height * .25, { steps: 10 });
  await page.mouse.up();
  await menu(page).getByLabel('更多操作', { exact: true }).click();
  await menu(page).getByRole('button', { name: '摘录', exact: true }).click();
  await expect.poll(async () => Object.values((await state(page)).evidence).some(item => item.kind === 'region')).toBe(true);
  const region = Object.values((await state(page)).evidence).find(item => item.kind === 'region')!;
  expect(region.region?.assetId).toBeTruthy();
  await menu(page).getByRole('button', { name: '写成卡片', exact: true }).click();
  await panel(page).getByLabel('卡片标题', { exact: true }).fill('区域标记保留图片');
  const before = await state(page);
  const card = Object.values(before.cards).find(item => item.title === '区域标记保留图片')!;
  await menu(page).getByRole('button', { name: '取消原文选区', exact: true }).click();
  const savedRegion = main(page).locator('.pdf-sheet[data-page-index="0"] .pdf-region-activity-marker').last();
  await savedRegion.click();
  await expect(menu(page).getByRole('button', { name: '移除标记', exact: true })).toBeEnabled();
  await screenshot(page, 'region-remove-menu-1440');
  await menu(page).getByRole('button', { name: '移除标记', exact: true }).click();
  await expect(savedRegion).toHaveCount(0);
  const removed = await state(page);
  expect(removed.evidence[region.id]).toMatchObject({ ...before.evidence[region.id], annotationHidden: true });
  expect(removed.cards[card.id]).toEqual(before.cards[card.id]);
  await expect(entry(page, region.id).getByAltText('保存的 PDF 框选区域', { exact: true })).toBeVisible();
  await saved(page); await page.reload();
  await expect(savedRegion).toHaveCount(0);
  await entry(page, region.id).getByRole('button', { name: '定位原文', exact: true }).click();
  await expect(main(page).getByLabel('来源区域高亮', { exact: true })).toBeVisible();
  expect((await state(page)).evidence[region.id].annotationHidden).toBe(true);
  await entry(page, region.id).getByRole('button', { name: '恢复标记', exact: true }).click();
  await expect(savedRegion).toBeVisible();
  await screenshot(page, 'region-restored-1440');
  await saved(page);
});

test('其他研究同段来源的移除操作只影响被点击的证据', async ({ page }) => {
  await start(page);
  const own = await capture(page);
  await switchResearch(page, 'research-b');
  await reader(page);
  const other = await capture(page, undefined, 'research-b');
  expect(other.id).not.toBe(own.id);
  expect(other.quote).toBe(own.quote);
  await switchResearch(page, 'research-a');
  await openResearchPage(page, '摘录');
  await main(page).locator('.other-research-excerpts summary').click();
  const otherEntry = main(page).locator(`.other-research-excerpts .evidence-entry[data-evidence-id="${other.id}"]`);
  await otherEntry.getByRole('button', { name: '定位原文', exact: true }).click();
  const source = main(page).locator(`.pdf-source-highlight[data-evidence-id="${other.id}"]`);
  await expect(source).not.toHaveCount(0);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await clickHighlight(page, source.first());
  await menu(page).getByRole('button', { name: '移除标记', exact: true }).click();
  await expect(source).toHaveCount(0);
  await expect(mark(page, own.id)).not.toHaveCount(0);
  const after = await state(page);
  expect(after.evidence[other.id]).toMatchObject({ ...other, annotationHidden: true });
  expect(after.evidence[own.id]).toEqual(own);
  await switchResearch(page, 'research-b');
  await expect(mark(page, other.id)).toHaveCount(0);
  await saved(page);
});

test('问答打开时从右侧移除标记立即清除高亮，问答与显式引用仍可用', async ({ page }) => {
  await start(page);
  const excerpt = await capture(page);
  await panel(page).getByRole('tab', { name: '摘录', exact: true }).click();
  await selectText(page);
  await menu(page).getByRole('button', { name: '解释这段', exact: true }).click();
  await expect(inline(page)).toContainText('模拟回答：证据仍可追溯。');
    await expect.poll(async () => Object.values((await state(page)).requests).some(request => request.status === 'generating')).toBe(false);
  await expect(main(page).locator('.pdf-source-highlight')).not.toHaveCount(0);
  const before = await state(page);
  const conversation = Object.values(before.conversations).find(item => item.inlineSource?.evidenceId === excerpt.id)!;
  const request = before.requests[conversation.requestIds[0]];
  await entry(page, excerpt.id).getByRole('button', { name: '移除标记', exact: true }).click();
  await expect(mark(page, excerpt.id)).toHaveCount(0);
  await expect(main(page).locator('.pdf-source-highlight')).toHaveCount(0);
  await expect(inline(page)).toContainText('模拟回答：证据仍可追溯。');
    await expect.poll(async () => Object.values((await state(page)).requests).some(request => request.status === 'generating')).toBe(false);
  const removed = await state(page);
  expect(removed.evidence[excerpt.id]).toMatchObject({ ...before.evidence[excerpt.id], annotationHidden: true });
  expect(removed.conversations[conversation.id]).toEqual(conversation);
  expect(removed.requests[request.id]).toEqual(request);
  const tabsBefore = await main(page).locator('.pane-tab-select').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tab-id')));
  const activeTabBefore = await main(page).locator('.pane-tab-select[aria-selected="true"]').getAttribute('data-tab-id');
  await inline(page).getByRole('button', { name: '[1]', exact: true }).click();
  await expect(main(page).locator('.pdf-source-highlight')).not.toHaveCount(0);
  expect((await state(page)).evidence[excerpt.id].annotationHidden).toBe(true);
  expect(await main(page).locator('.pane-tab-select').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tab-id')))).toEqual(tabsBefore);
  await expect(main(page).locator('.pane-tab-select[aria-selected="true"]')).toHaveAttribute('data-tab-id', activeTabBefore!);
  await expect(panel(page).getByRole('tab', { name: '摘录', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(inline(page)).toBeVisible();
  await saved(page);
});
