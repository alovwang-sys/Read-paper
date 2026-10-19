import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../../src/data/seed';
import type { WorkspaceData } from '../../src/domain/types';
import { openResearchPage, openSource, switchResearch } from './knowledge-helpers';
import { mockProjectService } from './project-fixture';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const paperTitle = 'Adaptive Retrieval: Evidence & Reliability';
const excerptStart = 'When does adding a retrieval stage';

async function state(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const recovery = localStorage.getItem('papertrail-recovery-v3');
    if (recovery) return JSON.parse(recovery);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<WorkspaceData>((resolve, reject) => {
        const request = db.transaction('workspace').objectStore('workspace').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
}
async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
}
async function start(page: Page) {
  const seed = createSeed();
  seed.researches['research-b'].documentIds = ['paper-a'];
  await mockProjectService(page, { bound: false, seed });
  let liveCalls = 0;
  await page.route('**/api/ai/config', route => route.fulfill({ json: {
    configured: false, model: 'excerpt-test', provider: '测试能力', images: true, mode: 'demo',
    limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 },
  } }));
  await page.route('**/api/ai/chat', route => {
    liveCalls++;
    return route.fulfill({ status: 503, contentType: 'application/x-ndjson', body: '{"type":"error","error":"本测试禁止真实模型调用"}\n' });
  });
  await page.goto('/');
  await expect(main(page).getByRole('heading', { name: '检索增强，何时有效？', exact: true })).toBeVisible();
  await saved(page);
  return () => expect(liveCalls, '演示起草不能调用真实模型').toBe(0);
}
async function reader(page: Page) {
  await openSource(page, paperTitle);
  await expect(main(page).getByRole('region', { name: 'PDF 阅读器', exact: true })).toBeVisible();
  await expect(main(page).locator('.pdf-text-layer span').filter({ hasText: excerptStart }).first()).toBeVisible();
}
async function selectExcerpt(page: Page) {
  const span = main(page).locator('.pdf-text-layer span').filter({ hasText: excerptStart }).first();
  const quote = await span.evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return node.textContent!.replace(/\s+/g, ' ').trim();
  });
  await expect(page.getByLabel('原文选区操作')).toBeVisible();
  return quote;
}
async function capture(page: Page) {
  const quote = await selectExcerpt(page);
  await page.keyboard.press('h');
  await expect.poll(async () => Object.values((await state(page)).evidence).filter(item => item.quote === quote && item.researchId === 'research-a').length).toBe(1);
  const evidence = Object.values((await state(page)).evidence).find(item => item.quote === quote && item.researchId === 'research-a')!;
  return evidence;
}

test('H 摘录可撤销，重复选区复用，刷新保留原文高亮', async ({ page }) => {
  await start(page);
  await reader(page);
  let excerpt = await capture(page);
  await expect(main(page).locator('.pdf-excerpt-highlight')).not.toHaveCount(0);
  await panel(page).getByRole('tab', { name: '摘录', exact: true }).click();
  await expect(panel(page)).toContainText(excerpt.quote);
  await main(page).getByRole('button', { name: '撤销', exact: true }).click();
  expect((await state(page)).evidence[excerpt.id]).toBeUndefined();
  await expect(main(page).locator(`.pdf-excerpt-highlight[data-evidence-id="${excerpt.id}"]`)).toHaveCount(0);

  excerpt = await capture(page);
  await page.keyboard.press('h');
  expect(Object.values((await state(page)).evidence).filter(item => item.quote === excerpt.quote && item.researchId === 'research-a')).toHaveLength(1);
  await saved(page);
  await page.reload();
  await expect(main(page).locator('.pdf-excerpt-highlight')).not.toHaveCount(0);
  expect((await state(page)).evidence[excerpt.id]).toMatchObject({ quote: excerpt.quote, researchId: 'research-a' });
  await main(page).locator(`.pdf-excerpt-highlight[data-evidence-id="${excerpt.id}"]`).first().click();
  await expect(page.getByLabel('原文选区操作').getByRole('button', { name: '移除标记', exact: true })).toBeEnabled();
});

test('摘录按研究隔离，可展开其他研究来源，标为不需要后可恢复', async ({ page }) => {
  await start(page);
  await reader(page);
  const excerpt = await capture(page);
  await openResearchPage(page, '摘录');
  const entry = main(page).getByRole('checkbox', { name: `选择摘录：${excerpt.quote}`, exact: true });
  await expect(entry).toBeVisible();
  await main(page).getByLabel(`摘录随手记：${excerpt.id}`).fill('这段与当前研究问题直接相关。');
  await entry.check();
  await main(page).getByRole('button', { name: '不需要', exact: true }).click();
  await expect(entry).toHaveCount(0);
  await main(page).getByRole('checkbox', { name: '显示标为不需要的摘录', exact: true }).check();
  await main(page).getByRole('button', { name: '恢复摘录', exact: true }).click();
  await expect(entry).toBeVisible();
  expect((await state(page)).evidence[excerpt.id]).toMatchObject({ dismissed: false, note: '这段与当前研究问题直接相关。' });

  await switchResearch(page, 'research-b');
  await openResearchPage(page, '摘录');
  await expect(main(page).getByRole('checkbox', { name: `选择摘录：${excerpt.quote}`, exact: true })).toHaveCount(0);
  await expect(main(page).locator('.other-research-excerpts blockquote').filter({ hasText: excerpt.quote })).toBeHidden();
  await main(page).locator('.other-research-excerpts summary').click();
  await expect(main(page).locator('.other-research-excerpts blockquote').filter({ hasText: excerpt.quote })).toBeVisible();
  await expect(main(page).locator('.other-research-excerpts')).toContainText('检索增强，何时有效？');
  await saved(page);
  await page.reload();
  await expect(main(page).getByRole('checkbox', { name: `选择摘录：${excerpt.quote}`, exact: true })).toHaveCount(0);
  await switchResearch(page, 'research-a');
  await expect(main(page).getByRole('checkbox', { name: `选择摘录：${excerpt.quote}`, exact: true })).toBeVisible();
});

test('多选摘录可建人工卡片和显式演示草稿，确认入库幂等且来源可恢复', async ({ page }) => {
  const noLiveCalls = await start(page);
  await reader(page);
  const excerpt = await capture(page);
  await openResearchPage(page, '摘录');
  const checkbox = main(page).getByRole('checkbox', { name: `选择摘录：${excerpt.quote}`, exact: true });
  await checkbox.check();
  const secondExcerpt = (await state(page)).evidence['evidence-c'];
  await main(page).getByRole('checkbox', { name: `选择摘录：${secondExcerpt.quote}`, exact: true }).check();
  const selectedIds = [excerpt.id, secondExcerpt.id];
  await main(page).getByRole('button', { name: '写成一张卡片', exact: true }).click();
  await panel(page).getByLabel('卡片标题', { exact: true }).fill('E2E 手工摘录观点');
  await panel(page).getByLabel('卡片正文', { exact: true }).fill('保留原文，同时写下自己的理解。');
  let data = await state(page);
  const manual = Object.values(data.cards).find(card => card.title === 'E2E 手工摘录观点')!;
  expect(manual.evidenceIds).toEqual(selectedIds);
  expect(data.researches['research-a'].cardIds).toContain(manual.id);

  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
  await panel(page).getByRole('button', { name: '演示模式', exact: true }).click();
  await main(page).getByRole('button', { name: 'AI 起草', exact: true }).click();
  const editor = panel(page).getByRole('region', { name: 'AI 卡片草稿', exact: true });
  await expect(editor.getByLabel('卡片正文', { exact: true })).toBeEnabled();
  data = await state(page);
  const draft = Object.values(data.cardDrafts).find(item => item.source.origin === 'excerpts')!;
  expect(draft.source).toMatchObject({ origin: 'excerpts', answer: '', answerEvidenceIds: [] });
  expect(draft.source.context.map(item => item.evidenceId)).toEqual(selectedIds);
  const request = data.requests[draft.source.generationRequestIds[0]];
  expect(request).toMatchObject({ mode: 'demo', purpose: 'card', history: [], status: 'done' });
  expect(request.context.map(item => item.evidenceId)).toEqual(selectedIds);
  expect(data.conversations[draft.conversationId].contextIds).not.toContain(excerpt.id);
  await editor.getByLabel('卡片标题', { exact: true }).fill('E2E 显式摘录草稿');
  await editor.getByRole('button', { name: '加入卡片', exact: true }).evaluate(button => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(editor.getByRole('heading', { name: '卡片已建立', exact: true })).toBeVisible();
  const committedId = (await state(page)).cardDrafts[draft.id].cardId!;
  data = await state(page);
  expect(Object.values(data.cards).filter(card => card.title === 'E2E 显式摘录草稿')).toHaveLength(1);
  expect(data.cards[committedId]).toMatchObject({ needsReview: true, evidenceIds: [excerpt.id], provenance: { origin: 'excerpts' } });
  await saved(page);
  await page.reload();
  await expect(panel(page).getByRole('heading', { name: '卡片已建立', exact: true })).toBeVisible();
  await panel(page).getByRole('button').filter({ hasText: '所选摘录' }).click();
  await expect(panel(page).getByRole('region', { name: '摘录起草来源' })).toContainText(excerpt.quote);
  noLiveCalls();
});

test('略读与读完保留阅读位置，读完提示只出现一次', async ({ page }) => {
  await start(page);
  await reader(page);
  await main(page).getByLabel('PDF 页码', { exact: true }).fill('2');
  await expect(main(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await main(page).getByRole('button', { name: '略读过', exact: true }).click();
  await expect(main(page).getByRole('button', { name: '略读过', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await main(page).getByRole('button', { name: '读完', exact: true }).click();
  await expect(main(page).getByRole('button', { name: '写一张要点卡片', exact: true })).toBeVisible();
  await main(page).getByRole('button', { name: '不用', exact: true }).click();
  await saved(page);
  await page.reload();
  await expect(main(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
  await expect(main(page).getByRole('button', { name: '读完', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(main(page).getByRole('button', { name: '写一张要点卡片', exact: true })).toHaveCount(0);
  await main(page).getByRole('button', { name: '略读过', exact: true }).click();
  await main(page).getByRole('button', { name: '读完', exact: true }).click();
  await expect(main(page).getByRole('button', { name: '写一张要点卡片', exact: true })).toHaveCount(0);
  expect((await state(page)).documents['paper-a']).toMatchObject({ readingStatus: 'read', finishPromptShown: true });
  await openResearchPage(page, '研究主页');
  await expect(main(page).getByRole('button').filter({ hasText: `读完 · ${paperTitle}` })).toBeVisible();
});
