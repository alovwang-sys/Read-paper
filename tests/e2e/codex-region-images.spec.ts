import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { ContextSnapshot, WorkspaceData } from '../../src/domain/types';
import { mockProjectService } from './project-fixture';
import { openSource } from './knowledge-helpers';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const input = (page: Page) => panel(page).getByLabel('向 AI 提问');
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
type Run = { requestId: string; context: ContextSnapshot[]; images?: { evidenceId: string; dataUrl: string }[]; codex: { model?: string } };

async function state(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const recovery = localStorage.getItem('papertrail-recovery-v3');
    if (recovery) return JSON.parse(recovery);
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
  const seed = createSeed(); seed.panelWidth = 440;
  for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'codex';
  await mockProjectService(page, { seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, model: '', images: false, mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [{ id: 'codex', name: 'Codex', state: 'ready', capabilities: { images: true, tools: true, resume: true, permissions: 'read-only' } }] } }));
  await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: { skills: [], plan: true, models: [
    { id: 'vision', name: 'Vision Model', isDefault: true, inputModalities: ['text', 'image'] },
    { id: 'text-only', name: 'Text Model', inputModalities: ['text'] },
  ] } }));
  const runs: Run[] = [];
  await page.route('**/api/ai/agents/run', route => {
    const run = route.request().postDataJSON() as Run; runs.push(run);
    return route.fulfill({ contentType: 'application/x-ndjson', body: [
      { type: 'delta', text: '模拟视觉适配回答：图像已随请求传入，实际含义仍需核查。 [1]' },
      { type: 'done', model: 'vision' },
    ].map(event => JSON.stringify(event)).join('\n') + '\n' });
  });
  await page.route('**/api/ai/chat', () => { throw new Error('Native image requests must not fall back to direct model'); });
  await page.goto('/');
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await expect.poll(async () => (await state(page)).documents['paper-a'].hash).toMatch(/^[a-f0-9]{64}$/);
  return runs;
}

async function addRegion(page: Page) {
  await main(page).getByRole('button', { name: '区域框选', exact: true }).click();
  const layer = main(page).getByLabel('拖动框选当前 PDF 页区域').first();
  await expect(layer).toBeVisible();
  const box = (await layer.boundingBox())!;
  await page.mouse.move(box.x + box.width * .12, box.y + box.height * .08);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .68, box.y + box.height * .25, { steps: 10 });
  await page.mouse.up();
  await expect(main(page).getByAltText('所选区域预览，PDF 第 1 页')).toBeVisible();
  await main(page).getByText('问 AI', { exact: true }).click();
  await main(page).getByRole('button', { name: '加入当前对话', exact: true }).click();
  await expect(panel(page).locator('.ai-material')).toHaveCount(1);
}

test('Codex 区域入口按原生模型能力工作，真实截图字节随冻结上下文发送并保留来源', async ({ page }) => {
  const runs = await start(page);
  await addRegion(page);
  await input(page).fill('解释这张论文区域截图，并说明适用条件。');
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect.poll(() => runs.length).toBe(1);
  await expect(panel(page).locator('.ai-answer')).toContainText('模拟视觉适配回答');
  const run = runs[0];
  expect(run.images).toHaveLength(1);
  expect(run.images![0].evidenceId).toBe(run.context[0].evidenceId);
  expect(run.images![0].dataUrl).toMatch(/^data:image\/png;base64,/);
  const bytes = Buffer.from(run.images![0].dataUrl.split(',')[1], 'base64');
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(run.context[0].region!.hash);
  expect(run.context[0]).toMatchObject({ kind: 'region', documentId: 'paper-a', pageIndex: 0 });
  await expect(input(page)).toHaveValue('');
  await saved(page); await page.reload();
  await expect(panel(page).locator('.ai-answer')).toContainText('模拟视觉适配回答');
  expect((await state(page)).requests[run.requestId].context[0].region).toEqual(run.context[0].region);
  await expect(main(page).locator('.pdf-sheet[data-page-index="0"] canvas')).toBeVisible();
  await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
  await saved(page);
  await mkdir('docs/verification/reader-images', { recursive: true });
  await page.screenshot({ path: 'docs/verification/reader-images/codex-region.png' });
});

test('切换为纯文字型号阻止图片发送，草稿与区域保留，切回图片型号可继续', async ({ page }) => {
  const runs = await start(page); await addRegion(page);
  const question = '保留这条尚未发送的图片问题';
  await input(page).fill(question);
  await panel(page).getByRole('button', { name: '选择 Codex 模型', exact: true }).click();
  await panel(page).getByRole('option', { name: /^Text Model/ }).click();
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
  await expect(panel(page)).toContainText('所选模型未确认支持区域图片');
  await expect(input(page)).toHaveValue(question);
  expect(runs).toHaveLength(0);
  await panel(page).getByRole('button', { name: '选择 Codex 模型', exact: true }).click();
  await panel(page).getByRole('option', { name: /^Vision Model/ }).click();
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeEnabled();
  await expect(panel(page).locator('.ai-material')).toHaveCount(1);
});
