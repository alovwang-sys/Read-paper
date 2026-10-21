import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const directory = new URL('./', import.meta.url);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const startedAt = new Date().toISOString();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
await page.routeWebSocket('**', () => {});
let input;
page.on('request', request => { if (request.url().endsWith('/api/ai/research/run')) input = request.postDataJSON(); });
const state = () => page.evaluate(async () => { const path = '/src/services/workspace.ts'; return (await import(path)).workspace.getState().data; });
try {
  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('textbox', { name: '研究目标', exact: true }).fill('仅使用本研究中可提取文字的示例 PDF，比较检索证据相关性与无关材料的影响。请自行查目录，至少读取两份有文字 PDF 各一页，再提交一份不超过 500 字的中文草稿，保留至少两处精确原句引用，说明扫描件及无全文资料的缺口。这些是产品验收合成资料，不能当作真实论文结论。');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(async () => {
    const data = await state();
    return Object.values(data.requests).find(request => request.researchRun)?.status;
  }, { timeout: 235000, intervals: [1000] }).not.toBe('generating');
  const data = await state();
  const request = Object.values(data.requests).find(request => request.researchRun);
  const draft = request?.researchRun?.draftId && data.drafts[request.researchRun.draftId];
  const record = { startedAt, finishedAt: new Date().toISOString(), status: request?.status, kind: 'Real browser → PDF.js fixture extraction → real native Codex app-server tools → IndexedDB Draft/Evidence', input, request, draft, evidence: request?.evidenceIds.map(id => data.evidence[id]), pageErrors, limitations: ['PDFs are explicitly self-authored synthetic fixtures, not real academic evidence.', 'No real-user usability or broad research-quality evaluation.'] };
  await writeFile(new URL('browser-live.json', directory), JSON.stringify(record, null, 2) + '\n');
  assert.equal(request?.status, 'done', request?.error || 'No completed request');
  assert.ok(draft && draft.evidenceIds.length >= 2);
  assert.ok(new Set(request.researchRun.readPages.map(page => page.documentId)).size >= 2);
  assert.deepEqual(pageErrors, []);
  await page.getByRole('button', { name: `打开成果：${draft.title}`, exact: true }).click();
  await expect(page.getByRole('textbox', { name: '结论标题', exact: true })).toHaveValue(draft.title);
  await mkdir(new URL('screenshots/', directory), { recursive: true });
  await page.screenshot({ path: new URL('screenshots/live-result-1440.png', directory).pathname });
  await page.reload();
  await expect(page.getByRole('textbox', { name: '结论标题', exact: true })).toHaveValue(draft.title);
  console.log(JSON.stringify({ status: 'passed', model: request.model, citations: draft.evidenceIds.length, readPages: request.researchRun.readPages.length, persistedAfterReload: true }));
} catch (error) {
  await writeFile(new URL('browser-live-failure.json', directory), JSON.stringify({ startedAt, failedAt: new Date().toISOString(), message: error.message, pageErrors }, null, 2) + '\n');
  throw error;
} finally { await context.close(); await browser.close(); }
