import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WorkspaceData } from '../../src/domain/types';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const nav = (page: Page) => page.locator('.sidebar');
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');

async function data(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const journal = localStorage.getItem('papertrail-recovery-v3');
    if (journal) return JSON.parse(journal);
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

async function start(page: Page) {
  let chatCalls = 0;
  await page.route('**/api/ai/config', route => route.fulfill({
    json: {
      configured: false, model: 'test-capability', provider: '测试能力', images: true, mode: 'demo',
      limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 },
    },
  }));
  await page.route('**/api/ai/chat', route => {
    chatCalls++;
    return route.fulfill({ status: 503, contentType: 'application/x-ndjson', body: '{"type":"error","error":"本测试禁止真实模型调用"}\n' });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '新建研究', exact: true })).toBeVisible();
  await saved(page);
  return () => expect(chatCalls, '显式演示流程不能向真实模型发送聊天请求').toBe(0);
}

async function openPaper(page: Page) {
  const state = await data(page), document = state.documents['paper-a'];
  await main(page).getByRole('button', { name: document.title, exact: true }).click();
  await expect(main(page).getByRole('region', { name: 'PDF 阅读器', exact: true })).toBeVisible();
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
  await expect.poll(async () => (await data(page)).documents[document.id].hash).toMatch(/^[a-f0-9]{64}$/);
  return document;
}

test('区域拖框、演示对话、片段卡片、刷新来源与真实 Markdown 下载', async ({ page }) => {
  test.setTimeout(120000);
  const assertNoLiveCalls = await start(page);
  const document = await openPaper(page);
  await main(page).getByRole('button', { name: '区域框选', exact: true }).click();
  const layer = main(page).getByLabel('拖动框选当前 PDF 页区域');
  await expect(layer).toBeVisible();
  const bounds = (await layer.boundingBox())!;
  const startPoint = { x: bounds.x + bounds.width * 0.12, y: bounds.y + bounds.height * 0.08 };
  const endPoint = { x: bounds.x + bounds.width * 0.68, y: bounds.y + bounds.height * 0.24 };
  await page.mouse.move(startPoint.x, startPoint.y);
  await page.mouse.down();
  await page.mouse.move(endPoint.x, endPoint.y, { steps: 12 });
  await page.mouse.up();
  const selectionActions = page.getByLabel('原文选区操作');
  await selectionActions.getByText('查看所选区域', { exact: true }).click();
  await expect(selectionActions.getByAltText('所选区域预览，PDF 第 1 页')).toBeVisible();
  await expect(main(page).locator('.pdf-region-box')).toBeVisible();
  expect(Object.values((await data(page)).evidence).filter(item => item.kind === 'region')).toHaveLength(0);
  await selectionActions.getByRole('button', { name: '提问', exact: true }).click();
  await page.getByRole('dialog', { name: '原文旁提问' }).getByRole('button', { name: '在右侧继续', exact: true }).click();
  await expect(panel(page).locator('.ai-material')).toHaveCount(1);
  let state = await data(page);
  const evidence = Object.values(state.evidence).find(item => item.kind === 'region')!;
  expect(evidence).toMatchObject({ documentId: document.id, pageIndex: 0, kind: 'region' });
  expect(evidence.region!.rect.x).toBeCloseTo(0.12, 2);
  expect(evidence.region!.rect.y).toBeCloseTo(0.08, 2);
  expect(evidence.region!.rect.width).toBeCloseTo(0.56, 2);
  expect(evidence.region!.rect.height).toBeCloseTo(0.16, 2);
  expect(evidence.region!.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(state.requests)).toHaveLength(0);

  await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
  await panel(page).getByRole('button', { name: '演示模式', exact: true }).click();
  const question = 'E2E 区域阅读：解释所选图像的研究含义，并指出待核查条件。';
  await panel(page).getByLabel('向 AI 提问').fill(question);
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: '按段选择', exact: true })).toBeVisible();
  state = await data(page);
  const request = Object.values(state.requests).find(item => item.purpose === 'chat')!;
  expect(request).toMatchObject({ status: 'done', mode: 'demo', prompt: question });
  expect(request.context[0]).toMatchObject({ evidenceId: evidence.id, kind: 'region', region: evidence.region });
  await panel(page).getByRole('button', { name: '按段选择', exact: true }).click();
  const intent = page.getByRole('dialog');
  await expect(intent.getByRole('heading', { name: '选择值得留下的知识点' })).toBeVisible();
  await intent.getByRole('radio').nth(1).check();
  const selection = await intent.getByRole('radio').nth(1).inputValue();
  expect(selection).toContain('所选区域图片');
  await intent.getByRole('button', { name: '生成卡片草稿', exact: true }).click();
  const editor = panel(page).getByRole('region', { name: 'AI 卡片草稿' });
  await expect(editor.getByLabel('卡片正文')).toBeEnabled();
  const cardTitle = 'E2E 区域来源与讨论一起保存';
  await editor.getByLabel('卡片标题').fill(cardTitle);
  await editor.getByLabel('卡片正文').fill('图像证据需要保留原始区域，并结合论文核查适用条件。 [1]');
  await editor.getByRole('button', { name: '加入卡片', exact: true }).click();
  await expect(editor.getByRole('heading', { name: '卡片已建立', exact: true })).toBeVisible();
  await saved(page);
  state = await data(page);
  const card = Object.values(state.cards).find(item => item.title === cardTitle)!;
  expect(card.evidenceIds).toEqual([evidence.id]);
  expect(card.provenance).toMatchObject({ requestId: request.id, prompt: question, selection, answer: request.body });
  expect(state.requests[request.id].body).toBe(request.body);

  await page.reload();
  await expect(panel(page).getByRole('heading', { name: '卡片已建立', exact: true })).toBeVisible();
  state = await data(page);
  const { contextOnly: _contextOnly, ...savedEvidence } = evidence;
  expect(state.evidence[evidence.id]).toEqual(savedEvidence);
  const asset = await page.evaluate(async assetId => {
    const modulePath = '/src/data/storage.ts';
    const { getAsset, contentHash } = await import(modulePath);
    const blob: Blob | undefined = await getAsset(assetId);
    if (!blob) return null;
    return { size: blob.size, type: blob.type, hash: await contentHash(await blob.arrayBuffer()) };
  }, evidence.region!.assetId);
  expect(asset).toMatchObject({ type: 'image/png', hash: evidence.region!.hash });
  expect(asset!.size).toBeGreaterThan(0);
  await panel(page).getByRole('button', { name: '查看卡片', exact: true }).click();
  await expect(panel(page).getByAltText('保存的 PDF 框选区域')).toBeVisible();
  await panel(page).getByRole('button', { name: '定位原文', exact: true }).click();
  await expect(main(page).getByLabel('来源区域高亮')).toBeVisible();
  expect((await data(page)).sessions['research-a'].anchor?.evidenceId).toBe(evidence.id);

  await nav(page).getByRole('button', { name: '检索增强的适用条件', exact: true }).click();
  await main(page).getByLabel('结论标题').fill('E2E 区域阅读与双来源记录');
  await main(page).getByLabel('结论正文').fill('以下结论保留框选图像和讨论过程。');
  await main(page).getByRole('button', { name: '插入卡片引用', exact: true }).click();
  await main(page).getByRole('button', { name: `插入引用：${cardTitle}`, exact: true }).click();
  await expect(main(page).getByRole('region', { name: '结论相关对话来源' })).toContainText(question);
  const downloadEvent = page.waitForEvent('download');
  await main(page).getByRole('button', { name: '导出 Markdown', exact: true }).click();
  const download = await downloadEvent;
  const output = resolve('docs/verification/ai-reading/e2e-region-note.md');
  await mkdir(resolve('docs/verification/ai-reading'), { recursive: true });
  await download.saveAs(output);
  expect(await download.failure()).toBeNull();
  const markdown = await readFile(output, 'utf8');
  expect(markdown).toContain('# E2E 区域阅读与双来源记录');
  expect(markdown).toContain('区域坐标（页面归一化）');
  expect(markdown).toContain(`x=${evidence.region!.rect.x}, y=${evidence.region!.rect.y}, width=${evidence.region!.rect.width}, height=${evidence.region!.rect.height}`);
  expect(markdown).toContain(evidence.region!.hash);
  expect(markdown).toContain('PDF 第 1 页');
  expect(markdown).toContain('## 相关对话来源');
  expect(markdown).toContain(question);
  expect(markdown).toContain('保留的回答片段：');
  expect(markdown).toContain(selection.split('\n')[0]);
  expect(markdown).toContain(request.id);
  expect(markdown).toContain('未附带原始 PDF');
  expect(markdown).toContain('未附带区域图片');
  assertNoLiveCalls();
});

test('干净新会话、历史搜索重命名、归档恢复及刷新持久化', async ({ page }) => {
  const assertNoLiveCalls = await start(page);
  await openPaper(page);
  await panel(page).getByRole('tab', { name: '摘录', exact: true }).click();
  await panel(page).locator('[data-evidence-id="evidence-a"]').getByRole('button', { name: '加入 AI', exact: true }).click();
  await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
  await panel(page).getByRole('button', { name: '演示模式', exact: true }).click();
  const question = 'E2E 历史检索：证据应如何留存？';
  await panel(page).getByLabel('向 AI 提问').fill(question);
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: '整理为卡片', exact: true })).toBeVisible();
  let state = await data(page);
  const request = Object.values(state.requests).find(item => item.purpose === 'chat')!;
  const oldId = request.conversationId;
  await panel(page).getByRole('button', { name: '新建干净对话', exact: true }).click();
  await expect(panel(page).locator('.ai-material')).toHaveCount(0);
  await expect(panel(page).locator('.ai-turn')).toHaveCount(0);
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('');
  state = await data(page);
  const cleanId = state.sessions['research-a'].activeConversationId!;
  expect(cleanId).not.toBe(oldId);
  expect(state.conversations[cleanId]).toMatchObject({ contextIds: [], requestIds: [], input: '' });
  expect(state.conversations[oldId].contextIds).toEqual(['evidence-a']);
  expect(state.requests[request.id].body).toBe(request.body);

  await panel(page).getByRole('button', { name: '查看会话历史', exact: true }).click();
  await panel(page).getByLabel('搜索会话').fill(question);
  await expect(panel(page).locator('.ai-history-item')).toHaveCount(1);
  await panel(page).getByRole('button', { name: /^重命名会话：/ }).click();
  const title = 'E2E 保留的论文阅读讨论';
  const rename = page.getByRole('dialog', { name: '重命名会话', exact: true });
  await rename.getByLabel('会话名称', { exact: true }).fill(title);
  await rename.getByRole('button', { name: '保存名称', exact: true }).click();
  await panel(page).getByLabel('搜索会话').fill(title);
  await expect(panel(page).locator('.ai-history-item')).toHaveCount(1);
  await panel(page).getByRole('button', { name: '归档', exact: true }).click();
  await expect(panel(page).locator('.ai-history-item')).toHaveCount(0);
  await panel(page).getByRole('button', { name: '已归档', exact: true }).click();
  await expect(panel(page).locator('.ai-history-item')).toHaveCount(1);
  await saved(page);
  await page.reload();
  await expect(panel(page).getByLabel('搜索会话')).toBeVisible();
  expect((await data(page)).conversations[oldId]).toMatchObject({ title, archived: true });
  await panel(page).getByRole('button', { name: '已归档', exact: true }).click();
  await panel(page).getByLabel('搜索会话').fill(title);
  await panel(page).getByRole('button', { name: '恢复', exact: true }).click();
  await expect(panel(page).locator('.ai-history-item')).toHaveCount(0);
  await panel(page).getByRole('button', { name: '最近对话', exact: true }).click();
  await panel(page).locator('.ai-history-open').filter({ hasText: title }).click();
  await expect(panel(page).locator('.ai-turn')).toHaveCount(1);
  await expect(panel(page).locator('.ai-material')).toHaveCount(1);
  await saved(page);
  await page.reload();
  await expect(panel(page).locator('.ai-answer')).toContainText('未调用真实模型');
  state = await data(page);
  expect(state.sessions['research-a'].activeConversationId).toBe(oldId);
  expect(state.conversations[oldId]).toMatchObject({ title, archived: false, contextIds: ['evidence-a'] });
  expect(state.conversations[cleanId]).toMatchObject({ contextIds: [], requestIds: [] });
  expect(state.requests[request.id].body).toBe(request.body);
  assertNoLiveCalls();
});
