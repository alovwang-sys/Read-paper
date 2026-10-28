import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import type { ResearchAgentInput } from '../../src/domain/research-agent';

test.use({ storageState: { cookies: [], origins: [] } });
const input = (page: Page) => page.getByRole('textbox', { name: '研究目标', exact: true });
const draft = (page: Page) => page.getByRole('region', { name: '待发送图片', exact: true });
const sentImages = (page: Page) => page.getByRole('region', { name: '这轮的图片附件', exact: true });
const picker = (page: Page) => page.getByLabel('选择图片文件', { exact: true });
const done = { type: 'done', model: 'controlled-image-input', readPages: [] };
const stream = (items: unknown[]) => items.map(item => JSON.stringify(item)).join('\n') + '\n';
async function workspace(page: Page, operation: 'read' | 'empty') {
  return page.evaluate(async operation => {
    const path = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/services/workspace.ts') ?? '/src/services/workspace.ts';
    const { workspace } = await import(path);
    if (operation === 'empty') workspace.updateData((data: { researches: Record<string, { documentIds: string[] }> }) => { data.researches['research-a'].documentIds = []; });
    return workspace.getState().data;
  }, operation);
}
async function start(page: Page, images = true) {
  await page.routeWebSocket('**', () => {});
  await page.route('**/api/ai/research/capabilities', route => route.fulfill({ json: { connections: [{ id: 'codex', research: true, images, detail: '受控图片能力' }] } }));
  await page.goto('/'); await expect(input(page)).toBeVisible(); await workspace(page, 'empty');
}
async function image(page: Page, mimeType = 'image/png', label = 'A') {
  const base64 = await page.evaluate(({ mimeType, label }) => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 80;
    const context = canvas.getContext('2d')!; context.fillStyle = label === 'A' ? '#e2edf4' : '#f4e6d0'; context.fillRect(0, 0, 160, 80);
    context.fillStyle = '#25332d'; context.font = '22px sans-serif'; context.fillText(`Test ${label}`, 12, 48);
    return canvas.toDataURL(mimeType).split(',')[1];
  }, { mimeType, label });
  return { name: `figure-${label}.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1]}`, mimeType, buffer: Buffer.from(base64, 'base64') };
}

test('默认会话有系统听写入口，文字留草稿且不自动发送', async ({ page }) => {
  const mockDictation = () => { Object.defineProperty(window, 'papertrailDesktop', { configurable: true, value: { startDictation: async () => { (window as unknown as { dictationRequests: number }).dictationRequests = ((window as unknown as { dictationRequests: number }).dictationRequests ?? 0) + 1; return true; } } }); };
  let sends = 0;
  await page.route('**/api/ai/research/run', route => { sends++; return route.abort(); });
  await start(page);
  await page.evaluate(mockDictation);
  await input(page).fill('原来的草稿');
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.getByText('识别文字留在草稿，不自动发送。', { exact: true })).toBeVisible();
  await expect(input(page)).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { dictationRequests: number }).dictationRequests)).toBe(1);
  await input(page).fill('原来的草稿，加上模拟系统听写输入。');
  expect(sends).toBe(0);
  await page.getByRole('button', { name: '关闭语音输入说明', exact: true }).click();
  await expect(input(page)).toHaveValue('原来的草稿，加上模拟系统听写输入。');
});

test('原始PNG JPEG WebP上传、预览、冻结发送、去重及刷新恢复', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let sent: ResearchAgentInput | undefined;
  await page.route('**/api/ai/research/run', async route => { sent = route.request().postDataJSON(); await held; await route.fulfill({ contentType: 'application/x-ndjson', body: stream([{ type: 'delta', text: '受控回复：已收到三张图片，尚无PDF原文证据。' }, done]) }); });
  await start(page);
  const files = await Promise.all(['image/png', 'image/jpeg', 'image/webp'].map((mime, index) => image(page, mime, String(index))));
  await picker(page).setInputFiles(files); await expect(draft(page).locator('summary img')).toHaveCount(3);
  for (const img of await draft(page).locator('summary img').all()) expect(await img.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(160);
  await picker(page).setInputFiles(files[0]); await expect(draft(page).locator('summary img')).toHaveCount(3);
  await input(page).fill('比较这三张图片。');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(input(page)).toHaveValue(''); await expect(draft(page)).toHaveCount(0);
  await expect.poll(() => sent?.images?.length).toBe(3);
  for (const [index, item] of sent!.images!.entries()) expect(Buffer.from(item.dataUrl.split(',')[1], 'base64')).toEqual(files[index].buffer);
  expect(sent!.sources).toEqual([]);
  await input(page).fill('下一条尚未发送的问题'); release();
  await expect(page.getByText('受控回复：已收到三张图片，尚无PDF原文证据。', { exact: true })).toBeVisible();
  await expect(input(page)).toHaveValue('下一条尚未发送的问题');
  await expect(sentImages(page).locator('summary img')).toHaveCount(3);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.reload(); await expect(input(page)).toHaveValue('下一条尚未发送的问题');
  await expect(sentImages(page).locator('summary img')).toHaveCount(3);
});

test('纯图片可发送，失败恢复原图；重试冻结原图并保留新图片草稿', async ({ page }) => {
  const sent: ResearchAgentInput[] = [];
  await page.route('**/api/ai/research/run', route => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/x-ndjson', body: stream(sent.length === 1 ? [{ type: 'error', error: '受控图片发送失败' }] : [{ type: 'delta', text: '按原图重试完成。' }, done]) });
  });
  await start(page);
  const first = await image(page); await picker(page).setInputFiles(first);
  await expect(page.getByRole('button', { name: '开始研究', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(page.getByText('受控图片发送失败', { exact: true })).toBeVisible();
  await expect(input(page)).toHaveValue(''); await expect(draft(page).locator('summary img')).toHaveCount(1);
  expect(sent[0].prompt).toContain('图片');
  await page.getByRole('button', { name: `移除图片：${first.name}` }).click();
  const next = await image(page, 'image/png', 'B'); await picker(page).setInputFiles(next); await input(page).fill('这是新问题和新图，请保留');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('按原图重试完成。', { exact: true })).toBeVisible();
  expect(sent[1].images).toEqual(sent[0].images);
  await expect(input(page)).toHaveValue('这是新问题和新图，请保留');
  await expect(draft(page).getByRole('img', { name: next.name, exact: true })).toBeVisible();
});

test('粘贴与拖入图片、拒绝不支持格式和超限，不覆盖原草稿', async ({ page }) => {
  await start(page); await input(page).fill('保留这段文字');
  const pasted = await image(page);
  await input(page).evaluate((element, file) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(file.base64), char => char.charCodeAt(0))], file.name, { type: file.mimeType }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, { name: pasted.name, mimeType: pasted.mimeType, base64: pasted.buffer.toString('base64') });
  await expect(draft(page).locator('summary img')).toHaveCount(1);
  const dropped = await image(page, 'image/jpeg', 'B');
  await page.locator('.research-agent-composer').evaluate((element, file) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(file.base64), char => char.charCodeAt(0))], file.name, { type: file.mimeType }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { name: dropped.name, mimeType: dropped.mimeType, base64: dropped.buffer.toString('base64') });
  await expect(draft(page).locator('summary img')).toHaveCount(2);
  await picker(page).setInputFiles({ name: 'unsupported.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(page.getByRole('alert')).toContainText('图片'); await expect(draft(page).locator('summary img')).toHaveCount(2);
  await picker(page).setInputFiles(Array.from({ length: 5 }, (_, index) => ({ ...pasted, name: `overflow-${index}.png` })));
  await expect(page.getByRole('alert')).toContainText('4 张');
  await expect(input(page)).toHaveValue('保留这段文字'); await expect(draft(page).locator('summary img')).toHaveCount(2);
});

test('能力不支持时保留图片、切会话与刷新隔离，三尺寸入口可达', async ({ page }) => {
  let sends = 0; await page.route('**/api/ai/research/run', route => { sends++; return route.abort(); });
  await start(page, false);
  await picker(page).setInputFiles(await image(page)); await input(page).fill('图片草稿留在这个会话');
  await expect(page.getByText('当前连接未确认支持图片，附件已保留；请改用支持图片的 Codex 模型。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始研究', exact: true })).toBeDisabled();
  await mkdir('docs/verification/chat-inputs/screenshots', { recursive: true });
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(page.getByRole('button', { name: '语音输入', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: '添加图片', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `docs/verification/chat-inputs/screenshots/images-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(draft(page)).toHaveCount(0); await expect(input(page)).toHaveValue('');
  const items = page.getByRole('button', { name: /^打开会话：/ });
  await items.last().click();
  await expect(draft(page).locator('summary img')).toHaveCount(1); await expect(input(page)).toHaveValue('图片草稿留在这个会话');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.reload(); await expect(draft(page).locator('summary img')).toHaveCount(1);
  await expect(input(page)).toHaveValue('图片草稿留在这个会话'); expect(sends).toBe(0);
});


test('图片拖入由聊天接收，PDF拖入保留原资料导入路径', async ({ page }) => {
  await start(page); await input(page).fill('原有问题保留');
  const picture = await image(page);
  await page.locator('.research-agent-composer').evaluate((element, file) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(file.base64), char => char.charCodeAt(0))], file.name, { type: file.mimeType }));
    element.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { name: picture.name, mimeType: picture.mimeType, base64: picture.buffer.toString('base64') });
  await expect(page.locator('.source-window-drop')).toHaveCount(0);
  const pdf = await PDFDocument.create(); pdf.addPage([200, 200]); pdf.setTitle('Chat composer PDF drop');
  const buffer = Buffer.from(await pdf.save());
  await page.locator('.research-agent-composer').evaluate((element, base64) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], 'composer-drop.pdf', { type: 'application/pdf' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, buffer.toString('base64'));
  await expect(page.getByRole('region', { name: 'PDF 阅读器', exact: true })).toContainText('composer-drop.pdf');
  await expect(page.getByRole('dialog', { name: '添加资料', exact: true })).toHaveCount(0);
  await expect.poll(async () => { const data = await workspace(page, 'read'); return data.researches['research-a'].documentIds.some((id: string) => data.documents[id]?.title === 'Chat composer PDF drop'); }).toBe(true);
  await expect(input(page)).toHaveValue('原有问题保留');
  await expect(draft(page)).toHaveCount(0);
});
