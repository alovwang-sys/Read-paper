import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ResearchAgentInput } from '../../src/domain/research-agent';

const root = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin' ? join(root, 'Papertrail.app/Contents/MacOS/Papertrail') : join(root, 'Papertrail.exe'));
const evidence = 'docs/verification/chat-inputs/desktop';
const input = (page: Page) => page.getByRole('textbox', { name: '研究目标', exact: true });
const draft = (page: Page) => page.getByRole('region', { name: '待发送图片', exact: true });
const sentImages = (page: Page) => page.getByRole('region', { name: '这轮的图片附件', exact: true });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function close(application: ElectronApplication) { const exited = application.waitForEvent('close'); void application.evaluate(({ app }) => app.quit()).catch(() => {}); await exited; }

async function image(page: Page, mimeType: string, label: string) {
  const base64 = await page.evaluate(({ mimeType, label }) => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 80;
    const context = canvas.getContext('2d')!;
    context.fillStyle = label === 'next' ? '#f4e6d0' : '#e2edf4'; context.fillRect(0, 0, 160, 80);
    context.fillStyle = '#25332d'; context.font = '22px sans-serif'; context.fillText(`Test ${label}`, 12, 48);
    return canvas.toDataURL(mimeType).split(',')[1];
  }, { mimeType, label });
  return { name: `desktop-${label}.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1]}`, mimeType, buffer: Buffer.from(base64, 'base64') };
}

test('默认桌面图片原字节发送、冻结重试、新图草稿与退出重启恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-chat-inputs-'));
  const home = join(directory, 'isolated-home');
  await mkdir(home);
  const env = { ...process.env, PAPERTRAIL_USER_DATA: join(directory, 'data'), HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'), OPENCODE_CONFIG_DIR: join(home, '.opencode'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '', AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' };
  let application: ElectronApplication | undefined;
  const errors: string[] = [], sent: ResearchAgentInput[] = [];
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    application = await _electron.launch({ executablePath, env, timeout: 60_000 });
    let page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route('**/api/ai/research/capabilities', route => route.fulfill({ json: { connections: [{ id: 'codex', research: true, images: true, detail: '受控桌面图片测试，未调用真实模型' }] } }));
    await page.route('**/api/ai/research/run', async route => {
      sent.push(route.request().postDataJSON());
      const first = sent.length === 1;
      if (first) await held;
      await route.fulfill({ contentType: 'application/x-ndjson', body: (first
        ? [{ type: 'error', error: '受控桌面图片发送失败' }]
        : [{ type: 'delta', text: '桌面按原始三张图片重试完成，没有读取 PDF。' }, { type: 'done', model: 'controlled-desktop-image', readPages: [] }]
      ).map(event => JSON.stringify(event)).join('\n') + '\n' });
    });
    await page.reload();
    await expect(input(page)).toBeVisible();
    await page.getByRole('button', { name: '新建研究', exact: true }).click();
    await expect(input(page)).toHaveValue('');
    await expect(page.getByRole('button', { name: '语音输入', exact: true })).toBeVisible();
    // Real dictation owns microphone and OS permission UI; this test only checks its entry point.
    const files = await Promise.all(['image/png', 'image/jpeg', 'image/webp'].map((mime, index) => image(page, mime, String(index))));
    let chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '添加图片', exact: true }).click();
    await (await chooser).setFiles(files);
    await expect(draft(page).locator('summary img')).toHaveCount(3);
    for (const img of await draft(page).locator('summary img').all()) await expect.poll(() => img.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(160);
    await draft(page).locator('summary').first().click();
    await expect(draft(page).getByRole('img', { name: `预览：${files[0].name}`, exact: true })).toBeVisible();
    await draft(page).locator('summary').first().click();
    await expect(page.getByRole('button', { name: '开始研究', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '开始研究', exact: true }).click();
    await expect(input(page)).toHaveValue(''); await expect(draft(page)).toHaveCount(0);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].prompt).toContain('图片'); expect(sent[0].sources).toEqual([]); expect(sent[0].images).toHaveLength(3);
    for (const [index, item] of sent[0].images!.entries()) expect(Buffer.from(item.dataUrl.split(',')[1], 'base64')).toEqual(files[index].buffer);
    const next = await image(page, 'image/png', 'next');
    chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '添加图片', exact: true }).click();
    await (await chooser).setFiles(next);
    await input(page).fill('下一条问题和图片草稿，请保留到重启后');
    await expect(draft(page).getByRole('img', { name: next.name, exact: true })).toBeVisible();
    release();
    await expect(page.getByText('受控桌面图片发送失败', { exact: true })).toBeVisible();
    await expect(input(page)).toHaveValue('下一条问题和图片草稿，请保留到重启后');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByText('桌面按原始三张图片重试完成，没有读取 PDF。', { exact: true })).toBeVisible();
    expect(sent).toHaveLength(2); expect(sent[1].images).toEqual(sent[0].images); expect(sent[1].prompt).toBe(sent[0].prompt); expect(sent[1].history).toEqual(sent[0].history);
    await expect(input(page)).toHaveValue('下一条问题和图片草稿，请保留到重启后');
    await expect(draft(page).locator('summary img')).toHaveCount(1);
    await expect(sentImages(page).last().locator('summary img')).toHaveCount(3);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/desktop-images-before-restart-1440.png` });
    await close(application); application = undefined;
    application = await _electron.launch({ executablePath, env, timeout: 60_000 });
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(input(page)).toHaveValue('下一条问题和图片草稿，请保留到重启后');
    await expect(page.getByText('桌面按原始三张图片重试完成，没有读取 PDF。', { exact: true })).toBeVisible();
    await expect(draft(page).getByRole('img', { name: next.name, exact: true })).toBeVisible();
    expect(await draft(page).getByRole('img', { name: next.name, exact: true }).evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(160);
    const archived = sentImages(page).last();
    await expect(archived.locator('summary img')).toHaveCount(3);
    for (const item of files) await expect(archived.getByRole('img', { name: item.name, exact: true })).toBeVisible();
    // Desktop CSP permits blob image display but not fetch(blob:); inspect the isolated asset store directly.
    const restored = await page.evaluate(async ids => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('papertrail', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        return await Promise.all(ids.map(async id => {
          const blob = await new Promise<Blob>((resolve, reject) => { const request = database.transaction('assets').objectStore('assets').get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary);
        }));
      } finally { database.close(); }
    }, sent[0].images!.map(item => item.assetId));
    for (const [index, bytes] of restored.entries()) expect(Buffer.from(bytes, 'base64')).toEqual(files[index].buffer);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    await page.screenshot({ path: `${evidence}/desktop-images-after-restart-1440.png` });
    expect(errors).toEqual([]);
    await writeFile(`${evidence}/checks.json`, JSON.stringify({ date: new Date().toISOString(), platform: process.platform, architecture: process.arch, executablePath, isolation: 'Temporary userData and HOME; no user credentials or real model requests', passed: true, realSpeechRecognitionTested: false, researchRequests: sent.length, files: files.map(file => ({ name: file.name, mimeType: file.mimeType, bytes: file.buffer.length, sha256: hash(file.buffer) })), draft: { name: next.name, sha256: hash(next.buffer) }, pageErrors: errors }, null, 2) + '\n');
  } finally {
    release();
    if (application) await close(application);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
