import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import type { SourceCandidate, WorkspaceData } from '../../src/domain/types';
import { switchResearch } from './knowledge-helpers';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const recommendations = (page: Page) => panel(page).getByRole('region', { name: '回答中的资料' });
const pendingInput = '保留这条未发送的研究问题';
const output = 'docs/verification/source-intake';
const sampleUrl = 'https://research.example.org/collection';
const abstract = '这是从原来源取得的作者摘要，全文暂时不可用时仍然保留。';

async function state(page: Page): Promise<WorkspaceData> {
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

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
}

function source(url = sampleUrl, title = '来源收录验证论文'): SourceCandidate {
  return { url, title, authors: 'Source Test Authors', year: '2026', kind: 'paper', identifiers: { url },
    abstract: { text: abstract, url, retrievedAt: '2026-10-17T08:00:00.000Z' }, metadataSource: url, resolvedAt: '2026-10-17T08:00:00.000Z' };
}

async function uniquePdf(title: string) {
  const pdf = await PDFDocument.load(await readFile('public/samples/adaptive-retrieval.pdf'));
  pdf.setTitle(title);
  return { name: `${title}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save({ useObjectStreams: false })) };
}

async function start(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (message.text().startsWith('Failed to load resource:') && /\/api\/sources\//.test(message.location().url)) return;
    errors.push(message.text());
  });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: true, model: 'source-intake-e2e', provider: '确定性测试接口', images: true, mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/chat', () => { throw new Error('来源收录测试不应调用模型'); });
  await page.goto('/');
  await expect(main(page).getByRole('heading', { name: '检索增强，何时有效？', exact: true })).toBeVisible();
  await saved(page);
  return () => expect(errors, '页面未捕获异常').toEqual([]);
}

async function answerWithLinks(page: Page, entries: { url: string; title: string }[], researchId = 'research-a') {
  const body = `以下是确定性测试提供的研究线索。\n\n${entries.map(entry => `[${entry.title}](${entry.url})`).join('\n\n')}\n\n这些推荐说明不是论文原摘要。`;
  await page.route('**/api/ai/chat', route => route.fulfill({ contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'delta', text: body })}\n${JSON.stringify({ type: 'done', model: 'source-intake-e2e' })}\n` }));
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  const prompt = `为 ${researchId} 寻找可核对的相关来源`;
  await panel(page).getByLabel('向 AI 提问').fill(prompt);
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(recommendations(page)).toBeVisible();
  await expect.poll(async () => Object.values((await state(page)).requests).find(request => request.prompt === prompt)?.status).toBe('done');
  const request = Object.values((await state(page)).requests).find(request => request.prompt === prompt)!;
  await panel(page).getByLabel('向 AI 提问').fill(pendingInput);
  await saved(page);
  return { conversationId: request.conversationId, requestId: request.id };
}

async function documentFor(page: Page, url: string) {
  await expect.poll(async () => Object.values((await state(page)).documents).some(doc => doc.identifiers?.url === url)).toBe(true);
  return Object.values((await state(page)).documents).find(doc => doc.identifiers?.url === url)!;
}

async function screenshot(page: Page, name: string, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await saved(page);
  await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth), '没有页面横向溢出').toBeLessThanOrEqual(width);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/${name}-${width}.png` });
}

test('显式 AI 来源可在中央预览而不收录，三尺寸保留回答与输入', async ({ page }) => {
  const noErrors = await start(page);
  const candidate = source();
  await page.route('**/api/sources/resolve', route => route.fulfill({ json: candidate }));
  await answerWithLinks(page, [candidate]);
  const before = await state(page);
  await recommendations(page).getByRole('button', { name: '查看文献', exact: true }).click();
  await expect(main(page).getByRole('heading', { name: candidate.title, exact: true })).toBeVisible();
  await expect(main(page).getByRole('heading', { name: '作者摘要', exact: true })).toBeVisible();
  await expect(main(page)).toContainText(abstract);
  expect(Object.keys((await state(page)).documents)).toEqual(Object.keys(before.documents));
  expect((await state(page)).researches['research-a'].documentIds).toEqual(before.researches['research-a'].documentIds);
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue(pendingInput);
    await expect(panel(page).locator('.ai-answer')).toContainText('这些推荐说明不是论文原摘要');
    await screenshot(page, 'source-preview', width, height);
    const content = (await main(page).boundingBox())!, reference = (await panel(page).boundingBox())!;
    expect(content.x + content.width).toBeLessThanOrEqual(reference.x + 1);
  }
  await page.getByRole('button', { name: '主区返回', exact: true }).click();
  await expect(main(page).getByRole('heading', { name: '检索增强，何时有效？', exact: true })).toBeVisible();
  expect((await state(page)).sessions['research-a'].sourcePreview).toBeUndefined();
  noErrors();
});

test('连续推荐列表收录局部说明，旧版整段快照刷新后也不展示成聊天记录', async ({ page }) => {
  const noErrors = await start(page);
  const candidates = [source('https://research.example.org/first-local', '局部推荐第一篇'), source('https://research.example.org/second-local', '局部推荐第二篇')];
  const prompt = '这是原始研究问题，不应直接复制到文献正文。';
  const body = `先讨论研究整体背景，不属于任何一篇论文。\n1. [${candidates[0].title}](${candidates[0].url})：用于分析检索效果。\n2. [${candidates[1].title}](${candidates[1].url})：用于比较长期记忆。\n最后给出综合建议，不属于文献说明。`;
  await page.route('**/api/sources/resolve', route => route.fulfill({ json: candidates.find(candidate => candidate.url === route.request().postDataJSON().url) }));
  await page.route('**/api/ai/chat', route => route.fulfill({ contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'delta', text: body })}\n${JSON.stringify({ type: 'done', model: 'source-intake-e2e' })}\n` }));
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await panel(page).getByLabel('向 AI 提问').fill(prompt);
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  const item = recommendations(page).locator('article').filter({ hasText: candidates[0].title });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: '查看文献', exact: true }).click();
  await expect(main(page).locator('.source-preview-recommendation')).toHaveText('局部推荐第一篇：用于分析检索效果。');
  await expect(main(page).locator('.source-preview-discovery > p.muted')).toHaveCount(0);
  await item.getByRole('button', { name: '加入本研究', exact: true }).click();
  const doc = await documentFor(page, candidates[0].url);
  await expect.poll(async () => (await state(page)).documents[doc.id].acquisition?.status).toBe('unavailable');
  await item.getByRole('button', { name: '打开', exact: true }).click();
  const discovery = main(page).locator('.source-discovery');
  await expect(discovery).toContainText('局部推荐第一篇：用于分析检索效果。');
  await expect(discovery).not.toContainText('局部推荐第二篇');
  await expect(discovery.locator(':scope > p')).not.toContainText(prompt);
  await expect(main(page)).not.toContainText('先讨论研究整体背景');
  await panel(page).getByLabel('向 AI 提问').fill(pendingInput);
  await saved(page);
  const data = await state(page), request = Object.values(data.requests).find(value => value.prompt === prompt)!;
  expect(data.researches['research-a'].sourceRecords?.[doc.id].discoveries[0].recommendation).toBe('局部推荐第一篇：用于分析检索效果。');
  data.researches['research-a'].sourceRecords![doc.id].discoveries[0].recommendation = body;
  await page.evaluate(value => localStorage.setItem('papertrail-recovery-v3', JSON.stringify(value)), data);
  await page.reload();
  await expect(discovery).toContainText('局部推荐第一篇：用于分析检索效果。');
  await expect(discovery).not.toContainText('局部推荐第二篇');
  await expect(discovery.locator(':scope > p')).not.toContainText(prompt);
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue(pendingInput);
  await discovery.getByRole('button', { name: '回看原问答', exact: true }).click();
  await expect(panel(page).locator('.ai-source-view')).toContainText('最后给出综合建议');
  await expect(panel(page).locator('.ai-source-view .ai-user-message')).toHaveText(prompt);
  expect((await state(page)).requests[request.id].body).toBe(body);
  await saved(page);
  await mkdir('docs/verification/reading-workspace-bugfixes', { recursive: true });
  await page.screenshot({ path: 'docs/verification/reading-workspace-bugfixes/source-local-description-1440.png' });
  noErrors();
});

test('直接加入在后台取得有效 PDF，保持主区并在刷新后本地阅读', async ({ page }) => {
  const noErrors = await start(page);
  const pdf = await uniquePdf('后台收录的独立全文');
  const candidate = { ...source(), pdfUrl: 'https://research.example.org/fulltext.pdf' };
  await page.route('**/api/sources/resolve', route => route.fulfill({ json: candidate }));
  await page.route('**/api/sources/pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdf.buffer }));
  const ids = await answerWithLinks(page, [candidate]);
  const active = (await state(page)).sessions['research-a'].active;
  await recommendations(page).getByRole('button', { name: '加入本研究', exact: true }).click();
  await expect(recommendations(page)).toContainText('已在本研究');
  const doc = await documentFor(page, candidate.url);
  await expect.poll(async () => (await state(page)).documents[doc.id].pageCount).toBe(3);
  let data = await state(page);
  expect(data.sessions['research-a'].active).toEqual(active);
  expect(data.sessions['research-a'].sourcePreview).toBeUndefined();
  expect(data.documents[doc.id].abstract?.text).toBe(abstract);
  expect(data.researches['research-a'].sourceRecords?.[doc.id].discoveries[0]).toMatchObject({ kind: 'ai', requestId: ids.requestId, conversationId: ids.conversationId });
  expect(data.conversations[ids.conversationId].contextIds).toEqual([]);
  await recommendations(page).getByRole('button', { name: '打开', exact: true }).click();
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue(pendingInput);
  await saved(page);
  await page.reload();
  await expect(main(page).locator('canvas').first()).toBeVisible();
  data = await state(page);
  expect(data.documents[doc.id].hash).toMatch(/^[a-f0-9]{64}$/);
  await screenshot(page, 'source-readable', 1280, 800);
  noErrors();
});

test('404 和 HTML 全文失败保留资料及原摘要，之后在原 ID 补齐 PDF', async ({ page }) => {
  const noErrors = await start(page);
  const candidates = [source('https://research.example.org/missing', '全文 404 的论文'), source('https://research.example.org/login', '返回登录页的论文')];
  await page.route('**/api/sources/resolve', route => {
    const url = route.request().postDataJSON().url;
    return route.fulfill({ json: { ...candidates.find(candidate => candidate.url === url)!, pdfUrl: `${url}.pdf` } });
  });
  await page.route('**/api/sources/pdf', route => route.request().postDataJSON().url.includes('missing')
    ? route.fulfill({ status: 404, json: { error: '原网站没有提供这份 PDF，可稍后补充全文。' } })
    : route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Sign in to read</h1>' }));
  await answerWithLinks(page, candidates);
  for (const candidate of candidates) {
    const item = recommendations(page).locator('article').filter({ hasText: candidate.title });
    await item.getByRole('button', { name: '加入本研究', exact: true }).click();
    const doc = await documentFor(page, candidate.url);
    await expect.poll(async () => (await state(page)).documents[doc.id].acquisition?.status).toBe('error');
    const data = await state(page);
    expect(data.documents[doc.id].assetId).toBeUndefined();
    expect(data.documents[doc.id].abstract?.text).toBe(abstract);
    expect(data.researches['research-a'].documentIds).toContain(doc.id);
  }
  const target = await documentFor(page, candidates[1].url);
  await recommendations(page).locator('article').filter({ hasText: candidates[1].title }).getByRole('button', { name: '打开', exact: true }).click();
  await expect(main(page)).toContainText('已收录 · 暂无全文');
  await expect(main(page)).toContainText(abstract);
  await screenshot(page, 'source-no-fulltext', 1440, 900);
  await main(page).getByRole('heading', { name: '作者摘要', exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, 'source-abstract-retained', 1440, 900);
  await main(page).getByLabel('为资料选择 PDF').setInputFiles(await uniquePdf('手动补齐原条目'));
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await saved(page);
  await page.reload();
  await expect(main(page).locator('canvas').first()).toBeVisible();
  const data = await state(page);
  expect(data.sessions['research-a'].active).toEqual({ kind: 'document', id: target.id });
  expect(data.documents[target.id].abstract?.text).toBe(abstract);
  expect(data.researches['research-a'].sourceRecords?.[target.id].discoveries).toHaveLength(1);
  await screenshot(page, 'source-supplemented', 1024, 800);
  noErrors();
});

test('元数据失败也可收下链接，跨研究复用同一实体并隔离备注及发现记录', async ({ page }) => {
  const noErrors = await start(page);
  const candidate = source('https://research.example.org/link-only', '只能收下链接的资料');
  await page.route('**/api/sources/resolve', route => route.fulfill({ status: 503, json: { error: '暂时无法读取来源信息' } }));
  const idsA = await answerWithLinks(page, [candidate]);
  await recommendations(page).getByRole('button', { name: '查看文献', exact: true }).click();
  await expect(main(page)).toContainText('暂时无法读取来源信息');
  await main(page).getByRole('button', { name: '加入本研究', exact: true }).click();
  const doc = await documentFor(page, candidate.url);
  await expect(main(page)).toContainText('已收录 · 来源预览');
  await main(page).getByRole('button', { name: '打开资料', exact: true }).click();
  await expect(main(page).getByLabel('本研究收录备注')).toBeVisible();
  await main(page).getByLabel('本研究收录备注').fill('研究 A：比较检索方法');
  await expect.poll(async () => (await state(page)).documents[doc.id].acquisition?.status).toBe('error');
  expect((await state(page)).documents[doc.id].abstract).toBeUndefined();
  await switchResearch(page, 'research-b');
  const idsB = await answerWithLinks(page, [candidate], 'research-b');
  await recommendations(page).getByRole('button', { name: '加入本研究', exact: true }).click();
  await recommendations(page).getByRole('button', { name: '打开', exact: true }).click();
  await expect(main(page).getByLabel('本研究收录备注')).toHaveValue('');
  await main(page).getByLabel('本研究收录备注').fill('研究 B：观察长文来源');
  await saved(page);
  await page.reload();
  await expect(main(page).getByLabel('本研究收录备注')).toHaveValue('研究 B：观察长文来源');
  await switchResearch(page, 'research-a');
  await expect(main(page).getByLabel('本研究收录备注')).toHaveValue('研究 A：比较检索方法');
  const data = await state(page);
  expect(Object.values(data.documents).filter(document => document.identifiers?.url === candidate.url)).toHaveLength(1);
  expect(data.researches['research-a'].sourceRecords?.[doc.id].discoveries.map(item => item.requestId)).toEqual([idsA.requestId]);
  expect(data.researches['research-b'].sourceRecords?.[doc.id].discoveries.map(item => item.requestId)).toEqual([idsB.requestId]);
  noErrors();
});

test('刷新获取中的资料显示已中断，记录仍在且可重试', async ({ page }) => {
  const noErrors = await start(page);
  const candidate = source('https://research.example.org/interrupted', '等待获取的论文');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route('**/api/sources/resolve', async route => {
    calls++;
    if (calls === 1) await gate;
    try { await route.fulfill({ json: candidate }); } catch { /* Reload cancels the earlier browser request. */ }
  });
  await answerWithLinks(page, [candidate]);
  await recommendations(page).getByRole('button', { name: '加入本研究', exact: true }).click();
  const doc = await documentFor(page, candidate.url);
  await expect.poll(() => calls).toBe(1);
  await expect.poll(async () => (await state(page)).documents[doc.id].acquisition?.status).toBe('fetching');
  await recommendations(page).getByRole('button', { name: '打开', exact: true }).click();
  await saved(page);
  await page.reload();
  release();
  await expect(main(page)).toContainText('上次获取已中断');
  await main(page).getByRole('button', { name: '重试获取全文', exact: true }).click();
  await expect.poll(async () => (await state(page)).documents[doc.id].abstract?.text).toBe(abstract);
  await expect.poll(async () => (await state(page)).documents[doc.id].acquisition?.status).toBe('unavailable');
  expect((await state(page)).researches['research-a'].documentIds).toContain(doc.id);
  noErrors();
});

test('迟到元数据保留手改字段，迟到全文不覆盖手动补充的 PDF', async ({ page }) => {
  const noErrors = await start(page);
  const candidates = [source('https://research.example.org/edited', '可手改信息的论文'), source('https://research.example.org/manual', '可手动补齐的论文')];
  let releaseMetadata!: () => void, releasePdf!: () => void;
  const metadataGate = new Promise<void>(resolve => { releaseMetadata = resolve; });
  const pdfGate = new Promise<void>(resolve => { releasePdf = resolve; });
  const automatic = await uniquePdf('自动获取的延迟全文');
  let pdfCalls = 0;
  await page.route('**/api/sources/resolve', async route => {
    const url = route.request().postDataJSON().url;
    if (url.endsWith('/edited')) await metadataGate;
    const candidate = candidates.find(item => item.url === url)!;
    await route.fulfill({ json: { ...candidate, title: '迟到的自动标题', pdfUrl: `${url}.pdf` } });
  });
  await page.route('**/api/sources/pdf', async route => {
    pdfCalls++;
    if (route.request().postDataJSON().url.includes('/manual')) await pdfGate;
    await route.fulfill({ contentType: 'application/pdf', body: automatic.buffer });
  });
  await answerWithLinks(page, candidates);
  const edited = recommendations(page).locator('article').filter({ hasText: candidates[0].title });
  await edited.getByRole('button', { name: '加入本研究', exact: true }).click();
  const first = await documentFor(page, candidates[0].url);
  await edited.getByRole('button', { name: '打开', exact: true }).click();
  await main(page).getByLabel('资料标题').fill('用户核对后的标题');
  await main(page).getByLabel('资料作者').fill('用户核对后的作者');
  releaseMetadata();
  await expect.poll(async () => (await state(page)).documents[first.id].pageCount).toBe(3);
  expect((await state(page)).documents[first.id]).toMatchObject({ title: '用户核对后的标题', authors: '用户核对后的作者', year: '2026' });
  const manual = recommendations(page).locator('article').filter({ hasText: candidates[1].title });
  await manual.getByRole('button', { name: '加入本研究', exact: true }).click();
  const second = await documentFor(page, candidates[1].url);
  await expect.poll(() => pdfCalls).toBe(2);
  await recommendations(page).locator('article').last().getByRole('button', { name: '打开', exact: true }).click();
  const file = await uniquePdf('用户手动补充的独立全文');
  await main(page).getByLabel('为资料选择 PDF').setInputFiles(file);
  await expect(main(page).locator('canvas').first()).toBeVisible();
  const manualHash = (await state(page)).documents[second.id].hash;
  const completed = page.waitForResponse(response => response.url().endsWith('/api/sources/pdf'));
  releasePdf();
  await (await completed).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await saved(page);
  expect((await state(page)).documents[second.id]).toMatchObject({ hash: manualHash, filename: file.name });
  await page.reload();
  await expect(main(page).locator('canvas').first()).toBeVisible();
  expect((await state(page)).documents[second.id]).toMatchObject({ hash: manualHash, filename: file.name });
  noErrors();
});
