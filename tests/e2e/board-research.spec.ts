import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { LiteratureCandidate, WorkspaceData } from '../../src/domain/types';
import { mockProjectService } from './project-fixture';
import { openSource, switchResearch } from './knowledge-helpers';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const localActions = (page: Page) => main(page).locator('.board-local-research');
const candidates = (page: Page) => panel(page).locator('.board-literature-candidate');
const questionTitle = '材料增多在什么条件下会降低可靠性？';

// Vite HMR may give the app a timestamped module URL. Read its loaded singleton,
// rather than importing an uninitialized second workspace during parallel development.
async function data(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map(entry => entry.name)
      .filter(url => /\/src\/services\/workspace\.ts(?:\?|$)/.test(url)).reverse();
    for (const url of [...urls, '/src/services/workspace.ts']) {
      const { workspace } = await import(url);
      if (workspace.getState().loaded) return workspace.getState().data;
    }
    throw new Error('The application workspace has not loaded');
  });
}
async function active(page: Page) {
  const state = await data(page);
  const researchId = state.scope.kind === 'research' ? state.scope.researchId : 'research-a';
  return state.conversations[state.sessions[researchId].activeConversationId!];
}
const literature: LiteratureCandidate[] = [{
  id: 'openalex-W123456', provider: 'openalex', providerId: 'W123456',
  title: 'Lost in the Middle: How Language Models Use Long Contexts',
  authors: ['Nelson F. Liu'], year: 2023, url: 'https://arxiv.org/abs/2307.03172',
  abstract: 'Controlled E2E fixture: relevant information position affects long-context use.', retrievedAt: '2026-10-20T10:00:00.000Z',
}, {
  id: 'openalex-W234567', provider: 'openalex', providerId: 'W234567',
  title: 'Corrective Retrieval Augmented Generation', authors: ['Shi-Qi Yan'], year: 2024,
  url: 'https://arxiv.org/abs/2401.15884', abstract: 'Controlled E2E fixture: assess retrieval quality before using documents.', retrievedAt: '2026-10-20T10:00:00.000Z',
}];

async function start(page: Page, seed = createSeed()) {
  seed.sessions['research-a'].active = { kind: 'board', id: 'board-a' };
  seed.sessions['research-a'].openItems = [{ kind: 'board', id: 'board-a' }];
  seed.sessions['research-a'].panel = { ...seed.sessions['research-a'].panel, open: true, mode: 'ai', aiMode: 'demo' };
  seed.conversations['conversation-research-a'].connectionId = 'demo';
  seed.conversations['conversation-research-a'].contextIds = [];
  await mockProjectService(page, { seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: 'board-research-fixture', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  let releaseSlow = () => {};
  const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
  const queries: string[] = [];
  await page.route('**/api/ai/literature/search', async route => {
    const query = String(route.request().postDataJSON().query);
    queries.push(query);
    if (query === 'slow-A') await slow;
    await route.fulfill(query === 'fixture-error'
      ? { status: 503, json: { code: 'upstream_error', error: '受控服务失败，请重试。' } }
      : { json: { candidates: query === 'fixture-empty' ? [] : literature } });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(main(page).getByRole('button', { name: '写问题', exact: true })).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  return { releaseSlow, queries, errors };
}
async function writeQuestion(page: Page, title: string, body = '区分相关性、材料数量和信息位置，逐步寻找可核查的原文。') {
  await main(page).getByRole('button', { name: '写问题', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '写一个研究问题', exact: true });
  await dialog.getByLabel('研究问题标题').fill(title);
  await dialog.getByLabel('研究问题描述').fill(body);
  await dialog.getByRole('button', { name: '添加到白板', exact: true }).click();
  await expect(dialog).toBeHidden();
  const state = await data(page), card = Object.values(state.cards).find(item => item.title === title)!;
  const placement = Object.values(state.placements).find(item => item.boardId === 'board-a' && item.resourceRef.id === card.id)!;
  expect(card.evidenceIds).toEqual([]);
  return { card, placement };
}
async function askPlacement(page: Page, placementId: string) {
  await main(page).locator(`[data-placement-id="${placementId}"]`).click();
  await localActions(page).getByRole('button', { name: '问 Agent', exact: true }).click();
  await expect(panel(page).locator('.br-origin')).toBeVisible();
  return active(page);
}
async function send(page: Page, prompt: string) {
  await panel(page).getByLabel('向 AI 提问', { exact: true }).fill(prompt);
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect.poll(async () => {
    const state = await data(page), conversation = await active(page);
    return conversation.requestIds.map(id => state.requests[id]).find(item => item.prompt === prompt)?.status;
  }).toBe('done');
  const state = await data(page), conversation = await active(page);
  return conversation.requestIds.map(id => state.requests[id]).find(item => item.prompt === prompt)!;
}
async function search(page: Page, query: string) {
  if (!await panel(page).getByRole('region', { name: '白板问题找文献' }).isVisible()) await panel(page).getByRole('button', { name: '找文献', exact: true }).click();
  await panel(page).getByLabel('检索词', { exact: true }).fill(query);
  await panel(page).getByRole('button', { name: '检索', exact: true }).click();
}

test('写问题草稿恢复，显式问答与文献收录独立，放回后继续同一问题并保存AI卡', async ({ page }) => {
  const check = await start(page);
  await main(page).getByRole('button', { name: '写问题', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '写一个研究问题', exact: true });
  await expect(dialog.getByLabel('研究问题标题')).toHaveAttribute('maxlength', '160');
  await expect(dialog.getByLabel('研究问题描述')).toHaveAttribute('maxlength', '20000');
  await dialog.getByLabel('研究问题描述').fill('x'.repeat(20001));
  expect((await dialog.getByLabel('研究问题描述').inputValue()).length).toBe(20000);
  expect((await data(page)).sessions['research-a'].boardQuestionDrafts?.['board-a'].body.length).toBe(20000);
  await dialog.getByLabel('研究问题标题').fill(questionTitle);
  await dialog.getByLabel('研究问题描述').fill('我自己的问题描述，刷新后应保留。');
  await dialog.getByRole('button', { name: '稍后继续', exact: true }).click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.reload();
  await main(page).getByRole('button', { name: '写问题', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '写一个研究问题', exact: true });
  await expect(dialog.getByLabel('研究问题标题')).toHaveValue(questionTitle);
  await expect(dialog.getByLabel('研究问题描述')).toHaveValue('我自己的问题描述，刷新后应保留。');
  await dialog.getByRole('button', { name: '添加到白板', exact: true }).click();
  let state = await data(page);
  const rootCard = Object.values(state.cards).find(item => item.title === questionTitle)!;
  const root = Object.values(state.placements).find(item => item.resourceRef.id === rootCard.id)!;
  const conversation = await askPlacement(page, root.id);
  expect(conversation.contextIds).toEqual([]);
  await panel(page).getByRole('button', { name: /^材料 \d+ ▾$/ }).click();
  await expect(page.getByRole('dialog', { name: '核对下一轮材料' })).toContainText(questionTitle);
  await mkdir('docs/whiteboard-research/verification/implementation', { recursive: true });
  await page.screenshot({ path: 'docs/whiteboard-research/verification/implementation/board-research-materials.png' });
  await page.getByRole('dialog', { name: '核对下一轮材料' }).getByRole('button', { name: '完成', exact: true }).click();
  const first = await send(page, '请先拆解这个问题，不要修改白板。');
  expect(first.materials?.some(item => item.kind === 'card_note' && item.resourceRef?.id === rootCard.id)).toBe(true);
  expect(first.context).toEqual([]);
  await send(page, '沿着上一轮，列出应该检查的条件。');
  await panel(page).getByRole('button', { name: /^历史 \d+ 轮 ▾$/ }).click();
  const history = page.getByRole('dialog', { name: '下一轮带哪些历史' });
  await history.getByLabel('白板讨论历史范围').selectOption('none');
  await history.getByRole('button', { name: '完成', exact: true }).click();
  const withoutHistory = await send(page, '只使用当前材料重新表述问题。');
  expect(withoutHistory.history).toEqual([]);
  await search(page, 'long context reliability');
  await expect(candidates(page)).toHaveCount(2);
  await page.screenshot({ path: 'docs/whiteboard-research/verification/implementation/board-research-literature.png' });
  const countBefore = Object.keys((await data(page)).documents).length;
  await candidates(page).first().getByRole('button', { name: '加入讨论', exact: true }).click();
  expect(Object.keys((await data(page)).documents)).toHaveLength(countBefore);
  await candidates(page).first().getByRole('button', { name: '加入资料库', exact: true }).click();
  state = await data(page);
  expect(Object.keys(state.documents)).toHaveLength(countBefore + 1);
  expect(Object.values(state.placements).filter(item => item.resourceRef.kind === 'document' && item.researchConversationId === conversation.id)).toHaveLength(0);
  await candidates(page).first().getByRole('button', { name: '放回问题旁', exact: true }).click();
  await expect(candidates(page).first().getByRole('button', { name: '已放到白板', exact: true })).toBeDisabled();
  state = await data(page);
  const paper = Object.values(state.placements).find(item => item.resourceRef.kind === 'document' && item.researchConversationId === conversation.id)!;
  expect(Object.values(state.edges).find(edge => edge.toPlacementId === paper.id)?.label).toBe('相关文献 · 待核查');
  await expect(main(page).locator(`[data-placement-id="${paper.id}"]`)).toContainText('全文未导入');
  await panel(page).getByRole('button', { name: '返回讨论', exact: true }).click();
  const paperConversation = await askPlacement(page, paper.id);
  expect(paperConversation.id).toBe(conversation.id);
  expect(paperConversation.boardResearch?.origin.rootPlacementId).toBe(root.id);
  await expect(panel(page).locator('.br-origin')).toContainText(questionTitle);
  await page.screenshot({ path: 'docs/whiteboard-research/verification/implementation/board-research-paper-focus.png' });
  const paperRequest = await send(page, '这篇论文提供了什么阅读线索？说明当前只读过摘要。');
  expect(paperRequest.materials?.some(item => item.kind === 'abstract')).toBe(true);
  expect(paperRequest.context).toEqual([]);
  await panel(page).getByRole('button', { name: '整理为卡片', exact: true }).last().click();
  await page.getByRole('button', { name: '生成卡片草稿', exact: true }).click();
  const draft = panel(page).getByRole('region', { name: 'AI 卡片草稿' });
  await expect(draft.getByLabel('卡片标题')).toBeEnabled();
  await draft.getByLabel('卡片标题').fill('长上下文需要核查信息位置');
  await draft.getByLabel('卡片正文').fill('这是摘要与对话形成的理解，需要进一步阅读原文核查。');
  await draft.getByRole('button', { name: '加入卡片', exact: true }).click();
  await draft.getByRole('button', { name: '放回问题旁', exact: true }).click();
  state = await data(page);
  const aiCard = Object.values(state.cards).find(item => item.title === '长上下文需要核查信息位置')!;
  expect(aiCard.provenance?.materials?.some(item => item.kind === 'abstract')).toBe(true);
  const aiPlacements = Object.values(state.placements).filter(item => item.resourceRef.id === aiCard.id && item.researchConversationId === conversation.id);
  expect(aiPlacements).toHaveLength(1);
  const bounds = await Promise.all([root.id, paper.id, aiPlacements[0].id].map(id => main(page).locator(`[data-placement-id="${id}"]`).boundingBox()));
  for (let first = 0; first < bounds.length; first++) for (let second = first + 1; second < bounds.length; second++) {
    const a = bounds[first]!, b = bounds[second]!;
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, '原问题、论文与新卡片的实际预览不能互相遮挡').toBe(true);
  }
  await draft.getByRole('button', { name: '继续对话', exact: true }).click();
  await panel(page).getByRole('button', { name: '回到原问题', exact: true }).click();
  await expect.poll(async () => (await data(page)).sessions['research-a'].anchor).toBeUndefined();
  await expect(main(page).locator(`[data-placement-id="${root.id}"]`)).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  if (await page.getByRole('button', { name: '关闭提示', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  for (const [width, height, shrink] of [[1440, 900, 2], [1280, 800, 1], [1024, 800, 1]]) {
    await page.setViewportSize({ width, height });
    for (let count = 0; count < shrink; count++) await main(page).getByRole('button', { name: '缩小白板', exact: true }).click();
    await panel(page).getByRole('button', { name: '回到原问题', exact: true }).click();
    await expect.poll(async () => (await data(page)).sessions['research-a'].anchor).toBeUndefined();
    const rootBeforePan = (await main(page).locator(`[data-placement-id="${root.id}"]`).boundingBox())!;
    await main(page).locator('.board-viewport').hover();
    await page.mouse.wheel(0, 115);
    await expect.poll(async () => (await main(page).locator(`[data-placement-id="${root.id}"]`).boundingBox())!.y).toBeLessThan(rootBeforePan.y - 100);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(panel(page).locator('.br-origin')).toContainText(questionTitle);
    await page.screenshot({ path: `docs/whiteboard-research/verification/implementation/board-research-${width}.png` });
  }
  expect(check.errors).toEqual([]);
});

test('分区多选核对和两种白板模式使用相同入口，绘图文字确认后变共享问题且原字保留', async ({ page }) => {
  const check = await start(page);
  await main(page).getByRole('button', { name: '选择分区：支持', exact: true }).click();
  await expect(localActions(page).getByRole('button', { name: '问 Agent', exact: true })).toBeVisible();
  await main(page).locator('[data-placement-id="placement-b"]').click({ modifiers: ['Shift'] });
  await localActions(page).getByRole('button', { name: /问 Agent/ }).click();
  const selection = page.getByRole('dialog', { name: '核对这次讨论的选中项' });
  await expect(selection).toContainText('原问题起点：');
  await expect(selection.getByRole('checkbox')).toHaveCount(2);
  await selection.getByRole('button', { name: '确认并问 Agent', exact: true }).click();
  expect((await active(page)).contextIds).toEqual([]);
  await main(page).getByRole('button', { name: '绘图', exact: true }).click();
  const drawing = main(page).getByLabel('白板自由绘图', { exact: true });
  const canvas = drawing.locator('canvas.interactive');
  await expect(canvas).toBeVisible();
  const resource = drawing.getByRole('article', { name: '白板资料：相关性是检索收益的前提', exact: true });
  const rect = (await resource.boundingBox())!;
  await page.mouse.click(rect.x + 40, rect.y + 35);
  await expect(drawing.locator('.drawing-local-research').getByRole('button', { name: '问 Agent', exact: true })).toBeVisible();
  await drawing.locator('.drawing-local-research').getByRole('button', { name: '问 Agent', exact: true }).click();
  await expect(panel(page).locator('.br-origin')).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await drawing.getByTestId('toolbar-text').locator('..').click();
  await canvas.click({ position: { x: 320, y: Math.min(430, box.height - 100) } });
  const text = '哪些材料属于反例？';
  await page.keyboard.insertText(text);
  await page.keyboard.press('Escape');
  await drawing.getByRole('button', { name: '文字作为问题', exact: true }).click();
  let question = page.getByRole('dialog', { name: '把所选文字作为问题' });
  await expect(question.getByLabel('研究问题描述')).toHaveValue(text);
  await expect(question).toContainText('保留原文字');
  await mkdir('docs/whiteboard-research/verification/implementation', { recursive: true });
  await page.screenshot({ path: 'docs/whiteboard-research/verification/implementation/board-research-drawing.png' });
  const adoptedOrigin = (await data(page)).sessions['research-a'].boardQuestionDrafts?.['board-a'].drawingOrigin;
  expect(adoptedOrigin?.text).toBe(text);
  await question.getByRole('button', { name: '稍后继续', exact: true }).click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.reload();
  await expect(canvas).toBeVisible();
  await main(page).getByRole('button', { name: '写问题', exact: true }).click();
  question = page.getByRole('dialog', { name: '写一个研究问题', exact: true });
  await expect(question.getByLabel('研究问题描述')).toHaveValue(text);
  await expect(question).toContainText('此草稿保留此前绘图文字来源');
  await question.getByLabel('研究问题标题').fill(text);
  expect((await data(page)).sessions['research-a'].boardQuestionDrafts?.['board-a'].drawingOrigin).toEqual(adoptedOrigin);
  await question.getByRole('button', { name: '添加并问 Agent', exact: true }).click();
  const state = await data(page), card = Object.values(state.cards).find(item => item.title === text)!;
  expect(card.drawingOrigin?.text).toBe(text);
  expect(card.drawingOrigin?.elementIds).toHaveLength(1);
  expect(card.drawingOrigin?.elementIds).toEqual(adoptedOrigin?.elementIds);
  expect((await active(page)).boardResearch?.origin.rootRef?.id).toBe(card.id);
  await expect.poll(async () => (await data(page)).boards['board-a'].drawing?.hash).toBeTruthy();
  const sourcePresent = await page.evaluate(async ({ assetId, text: expected }) => {
    const urls = performance.getEntriesByType('resource').map(entry => entry.name).filter(url => /\/src\/data\/storage\.ts(?:\?|$)/.test(url));
    const { getAsset } = await import(urls[0] || '/src/data/storage.ts');
    const blob = await getAsset(assetId);
    return blob && JSON.parse(await blob.text()).elements.some((element: { type: string; text?: string; isDeleted?: boolean }) => element.type === 'text' && !element.isDeleted && element.text === expected);
  }, { assetId: (await data(page)).boards['board-a'].drawing!.assetId, text });
  expect(sourcePresent).toBe(true);
  expect(check.errors).toEqual([]);
});

test('慢检索归原问题，切换研究不串结果，空结果和错误保留原查询可重试', async ({ page }) => {
  const check = await start(page);
  const root = await writeQuestion(page, 'A：检索噪声是否影响可靠性？');
  const origin = await askPlacement(page, root.placement.id);
  await search(page, 'slow-A');
  await expect(panel(page).getByRole('button', { name: '停止检索', exact: true })).toBeVisible();
  await switchResearch(page, 'research-b');
  check.releaseSlow();
  await expect.poll(async () => (await data(page)).conversations[origin.id].literatureSearches?.at(-1)?.status).toBe('done');
  expect((await data(page)).scope).toEqual({ kind: 'research', researchId: 'research-b' });
  await switchResearch(page, 'research-a');
  await expect(candidates(page)).toHaveCount(2);
  expect((await active(page)).id).toBe(origin.id);
  await expect(panel(page).getByLabel('检索词', { exact: true })).toHaveValue('slow-A');
  await search(page, 'fixture-empty');
  await expect(panel(page).getByRole('heading', { name: '没有找到文献', exact: true })).toBeVisible();
  await search(page, 'fixture-error');
  await expect(panel(page)).toContainText('受控服务失败');
  await expect(panel(page).getByLabel('检索词', { exact: true })).toHaveValue('fixture-error');
  await panel(page).getByRole('button', { name: '用原查询重试', exact: true }).click();
  await expect.poll(() => check.queries.filter(query => query === 'fixture-error').length).toBe(2);
  expect(check.errors).toEqual([]);
});

test('BV08 从检索题录补同一条目的 PDF，原文摘录沿原问题讨论并收卡保留页码', async ({ page }) => {
  const seed = createSeed();
  // This isolated project starts without bundled PDF identities, so attaching the
  // exact self-authored sample exercises in-place attachment rather than merging.
  seed.documents = {}; seed.evidence = {}; seed.cards = {}; seed.placements = {}; seed.edges = {}; seed.drafts = {};
  for (const research of Object.values(seed.researches)) { research.documentIds = []; research.cardIds = []; }
  const check = await start(page, seed);
  const fixture: LiteratureCandidate = {
    id: 'openalex-W345678', provider: 'openalex', providerId: 'W345678',
    title: 'Adaptive Retrieval: Evidence & Reliability · 自制验收资料',
    authors: ['Papertrail 示例研究组'], year: 2026,
    url: 'https://example.org/fixtures/adaptive-retrieval',
    abstract: 'Self-authored E2E fixture, not a real scholarly search result. Full text will be attached explicitly.',
    retrievedAt: '2026-10-20T10:00:00.000Z',
  };
  await page.route('**/api/ai/literature/search', route => route.fulfill({ json: { candidates: [fixture] } }));
  const root = await writeQuestion(page, 'BV08：从检索结果追到原文证据');
  const conversation = await askPlacement(page, root.placement.id);
  await search(page, 'self-authored adaptive retrieval fixture');
  await expect(candidates(page)).toHaveCount(1);
  await candidates(page).first().getByRole('button', { name: '加入资料库', exact: true }).click();
  await candidates(page).first().getByRole('button', { name: '放回问题旁', exact: true }).click();
  let state = await data(page);
  const document = Object.values(state.documents).find(item => item.title === fixture.title)!;
  const paper = Object.values(state.placements).find(item => item.resourceRef.kind === 'document' && item.resourceRef.id === document.id)!;
  const linkedIds = state.researches['research-a'].documentIds;
  expect(document.assetId).toBeUndefined();
  expect(paper.researchConversationId).toBe(conversation.id);
  await panel(page).getByRole('button', { name: '返回讨论', exact: true }).click();
  await openSource(page, fixture.title);
  await expect(main(page).getByLabel('为资料选择 PDF')).toBeAttached();
  await main(page).getByLabel('为资料选择 PDF').setInputFiles('public/samples/adaptive-retrieval.pdf');
  await expect(main(page).getByRole('region', { name: 'PDF 阅读器 主区' })).toBeVisible();
  await expect(main(page).locator('canvas').first()).toBeVisible();
  const span = main(page).locator('.pdf-text-layer span').filter({ hasText: 'When does adding a retrieval stage' }).first();
  await expect(span).toBeVisible();
  await expect.poll(async () => (await data(page)).documents[document.id].hash).toMatch(/^[a-f0-9]{64}$/);
  state = await data(page);
  expect(state.documents[document.id]).toMatchObject({ id: document.id, title: fixture.title, pageCount: 3 });
  expect(state.researches['research-a'].documentIds).toEqual(linkedIds);
  expect(state.placements[paper.id]).toEqual(paper);
  const quote = await span.evaluate(node => {
    const range = window.document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return node.textContent!.replace(/\s+/g, ' ').trim();
  });
  await expect(main(page).getByLabel('原文选区操作')).toBeVisible();
  await main(page).getByText('问 AI', { exact: true }).click();
  await main(page).getByRole('button', { name: '加入当前对话', exact: true }).click();
  await expect.poll(async () => (await active(page)).contextIds.length).toBe(1);
  state = await data(page);
  const evidence = Object.values(state.evidence).find(item => item.documentId === document.id && item.quote === quote)!;
  expect(evidence).toMatchObject({ researchId: 'research-a', documentId: document.id, pageIndex: 0, quote });
  expect((await active(page)).id).toBe(conversation.id);
  await panel(page).getByRole('button', { name: '回到原问题', exact: true }).click();
  await expect(main(page).locator(`[data-placement-id="${root.placement.id}"]`)).toBeInViewport();
  const request = await send(page, '只依据刚选中的自制资料原文说明这个小问题，并保留引用。');
  expect(request.conversationId).toBe(conversation.id);
  expect(request.boardResearch?.rootPlacementId).toBe(root.placement.id);
  expect(request.context).toEqual([expect.objectContaining({ evidenceId: evidence.id, documentId: document.id, documentHash: state.documents[document.id].hash, pageIndex: 0, quote })]);
  expect(request.evidenceIds).toEqual([evidence.id]);
  expect(request.validationError).toBeUndefined();
  expect(request.body).toContain('PDF 第 1 页');
  expect(request.body).toContain('[1]');
  expect(request.body).not.toContain('[2]');
  await panel(page).getByRole('button', { name: '整理为卡片', exact: true }).last().click();
  await page.getByRole('button', { name: '生成卡片草稿', exact: true }).click();
  const draft = panel(page).getByRole('region', { name: 'AI 卡片草稿' });
  await expect(draft.getByLabel('卡片标题')).toBeEnabled();
  const cardTitle = 'BV08：保留 PDF 原文与原问题的理解';
  await draft.getByLabel('卡片标题').fill(cardTitle);
  await draft.getByLabel('卡片正文').fill(`自制验收资料的原文：${quote} [1]`);
  await draft.getByRole('button', { name: '加入卡片', exact: true }).click();
  state = await data(page);
  const card = Object.values(state.cards).find(item => item.title === cardTitle)!;
  expect(card.evidenceIds).toEqual([evidence.id]);
  expect(card.provenance).toMatchObject({ researchId: 'research-a', conversationId: conversation.id, requestId: request.id });
  expect(card.provenance?.context).toEqual([expect.objectContaining({ evidenceId: evidence.id, documentId: document.id, pageIndex: 0, documentHash: state.documents[document.id].hash })]);
  await draft.getByRole('button', { name: '查看卡片', exact: true }).click();
  await expect(panel(page)).toContainText('PDF 第 1 页');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  if (await page.getByRole('button', { name: '关闭提示', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await mkdir('docs/whiteboard-research/verification/implementation', { recursive: true });
  await page.screenshot({ path: 'docs/whiteboard-research/verification/implementation/board-research-pdf.png' });
  expect(check.errors).toEqual([]);
});
