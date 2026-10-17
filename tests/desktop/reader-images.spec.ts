import { expect, test, _electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createSeed } from '../../src/data/seed';
import type { ContextSnapshot, WorkspaceData } from '../../src/domain/types';
import { fixtureSessionRef, mockProjectService } from '../e2e/project-fixture';
import { openSource } from '../e2e/knowledge-helpers';

const packageRoot = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin'
  ? join(packageRoot, 'Papertrail.app/Contents/MacOS/Papertrail') : join(packageRoot, 'Papertrail.exe'));
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const primary = (page: Page) => main(page).getByRole('region', { name: 'PDF 阅读器 主区', exact: true });
const secondary = (page: Page) => main(page).getByRole('region', { name: 'PDF 阅读器 对照位置', exact: true });
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

async function launch(userData: string, home: string) {
  const application = await _electron.launch({ executablePath, env: {
    ...process.env, PAPERTRAIL_USER_DATA: userData, HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
    OPENCODE_CONFIG_DIR: join(home, '.opencode'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '',
    AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
  }, timeout: 60_000 });
  try {
    const page = await application.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 });
    await expect(main(page)).toBeVisible(); await saved(page);
    return { application, page };
  } catch (error) { const exited = application.waitForEvent('close'); application.process().kill(); await exited; throw error; }
}
async function close(application: ElectronApplication) {
  const exited = application.waitForEvent('close');
  void application.evaluate(({ app }) => app.quit()).catch(() => {}); await exited;
}

async function goTo(pane: Locator, number: number) {
  await pane.getByLabel('PDF 页码', { exact: true }).fill(String(number));
  await expect(pane.locator(`.pdf-sheet[data-page-index="${number - 1}"] canvas`)).toBeVisible();
  await expect(pane.locator('.pdf-page-loading')).toHaveCount(0);
  await expect(pane.getByLabel('PDF 页码', { exact: true })).toHaveValue(String(number));
}

// PDF rendering, cropping, IndexedDB and shutdown are real; only the native service uses fixtures.
test('打包桌面：连续阅读、独立双窗和Codex区域图片在正常退出重启后保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-desktop-reader-images-'));
  const userData = join(directory, 'app-data'), home = join(directory, 'isolated-home');
  await Promise.all([mkdir(userData), mkdir(home)]);
  let application: ElectronApplication | undefined;
  const runs: Run[] = [], pageErrors: string[] = [];
  let directModelCalls = 0;
  const draft = '双位置阅读后尚未发送的下一条图片问题。';
  async function fixtures(page: Page, seed?: ReturnType<typeof createSeed>) {
    page.on('pageerror', error => pageErrors.push(error.message));
    await mockProjectService(page, seed ? { seed } : {});
    await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: '', mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
    await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [{ id: 'codex', name: 'Codex', state: 'ready', capabilities: { images: true, tools: true, resume: true, permissions: 'read-only' } }] } }));
    await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: { skills: [], plan: true, accessModes: ['read-only'], models: [
      { id: 'vision', name: 'Vision Model', isDefault: true, inputModalities: ['text', 'image'] },
      { id: 'text-only', name: 'Text Model', inputModalities: ['text'] },
    ] } }));
    await page.route('**/api/ai/chat', route => { directModelCalls++; return route.fulfill({ status: 500, body: 'Unexpected direct model call' }); });
    await page.route('**/api/ai/agents/run', route => {
      runs.push(route.request().postDataJSON() as Run);
      const nativeSessionId = 'desktop-reader-vision';
      return route.fulfill({ contentType: 'application/x-ndjson', body: [
        { type: 'session', nativeSessionId, nativeSessionRef: fixtureSessionRef(nativeSessionId) },
        { type: 'delta', text: '桌面模拟视觉回答：已接收区域截图，含义仍需核查。 [1]' },
        { type: 'done', model: 'vision', nativeSessionId, nativeSessionRef: fixtureSessionRef(nativeSessionId) },
      ].map(event => JSON.stringify(event)).join('\n') + '\n' });
    });
  }
  try {
    const seed = createSeed(); seed.panelWidth = 440; seed.sessions['research-a'].panel.mode = 'ai';
    for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'codex';
    for (const document of Object.values(seed.documents)) if (document.sampleUrl)
      document.hash = createHash('sha256').update(await readFile(`public${document.sampleUrl}`)).digest('hex');
    let session = await launch(userData, home); application = session.application; let page = session.page;
    expect(page.url()).toBe('papertrail://app/'); await fixtures(page, seed); await page.reload();
    await openSource(page, seed.documents['paper-a'].title);
    await expect(primary(page).locator('.pdf-text-layer').first()).not.toBeEmpty();
    await expect(primary(page).locator('.pdf-page-loading')).toHaveCount(0);

    const scroller = primary(page).locator('.pdf-scroll');
    const pageStep = await primary(page).locator('.pdf-sheet[data-page-index="0"]').evaluate(sheet => sheet.getBoundingClientRect().height + 24);
    await scroller.hover(); await page.mouse.wheel(0, pageStep + 10);
    await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
    await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(pageStep);
    const beforeSplit = await scroller.evaluate(node => node.scrollTop);
    await main(page).getByRole('button', { name: '分屏阅读', exact: true }).click();
    await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
    await expect.poll(() => scroller.evaluate((node, savedTop) => Math.abs(node.scrollTop - savedTop), beforeSplit)).toBeLessThanOrEqual(2);
    await goTo(primary(page), 2); await goTo(secondary(page), 3);
    await secondary(page).getByRole('button', { name: '放大 PDF', exact: true }).click();
    await expect(secondary(page).locator('.pdf-zoom')).toContainText('125%');
    await expect(primary(page).locator('.pdf-zoom')).toContainText('100%');
    await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');

    await panel(page).getByRole('button', { name: '选择 Codex 模型', exact: true }).click();
    await panel(page).getByRole('option', { name: /^Vision Model/ }).click();
    await primary(page).getByRole('button', { name: '区域框选', exact: true }).click();
    const layer = primary(page).locator('.pdf-sheet[data-page-index="1"] .pdf-region-layer');
    await expect(layer).toBeVisible(); const box = (await layer.boundingBox())!;
    await page.mouse.move(box.x + box.width * .12, box.y + box.height * .06); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .68, box.y + box.height * .20, { steps: 10 }); await page.mouse.up();
    await expect(primary(page).getByAltText('所选区域预览，PDF 第 2 页')).toBeVisible();
    await primary(page).getByText('问 AI', { exact: true }).click();
    await primary(page).getByRole('button', { name: '加入当前对话', exact: true }).click();
    await expect(panel(page).locator('.ai-material')).toHaveCount(1);
    await input(page).fill('解释第二页这张区域截图，并核查它的条件。');
    await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(panel(page).locator('.ai-answer')).toContainText('桌面模拟视觉回答');
    expect(runs).toHaveLength(1); const run = runs[0];
    expect(run.codex.model).toBe('vision'); expect(run.images).toHaveLength(1);
    expect(run.images![0].evidenceId).toBe(run.context[0].evidenceId);
    expect(run.images![0].dataUrl).toMatch(/^data:image\/png;base64,/);
    const bytes = Buffer.from(run.images![0].dataUrl.split(',')[1], 'base64');
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const imageHash = createHash('sha256').update(bytes).digest('hex');
    expect(imageHash).toBe(run.context[0].region!.hash);
    expect(run.context[0]).toMatchObject({ kind: 'region', documentId: 'paper-a', pageIndex: 1 });
    await expect(input(page)).toHaveValue(''); await input(page).fill(draft);
    await primary(page).getByRole('button', { name: '文字选择', exact: true }).click();
    await expect.poll(async () => (await state(page)).sessions['research-a'].readers['main:paper-a']).toMatchObject({ pageIndex: 1, scale: 1 });
    await expect.poll(async () => (await state(page)).sessions['research-a'].readers['main-secondary:paper-a']).toMatchObject({ pageIndex: 2, scale: 1.25 });
    await saved(page); const before = await state(page);
    await close(application); application = undefined;

    session = await launch(userData, home); application = session.application; page = session.page;
    await fixtures(page);
    await page.evaluate(() => sessionStorage.setItem('papertrail-project-fixture-ready', 'true'));
    await page.reload();
    await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
    await expect(secondary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
    await expect(primary(page).locator('.pdf-zoom')).toContainText('100%');
    await expect(secondary(page).locator('.pdf-zoom')).toContainText('125%');
    await expect(panel(page).locator('.ai-answer')).toContainText('桌面模拟视觉回答');
    await expect(input(page)).toHaveValue(draft);
    await expect(primary(page).locator('.pdf-page-loading')).toHaveCount(0);
    await expect(secondary(page).locator('.pdf-page-loading')).toHaveCount(0);
    const restored = await state(page);
    expect(restored.sessions['research-a'].mainSplit).toEqual(before.sessions['research-a'].mainSplit);
    for (const key of ['main:paper-a', 'main-secondary:paper-a'])
      expect(restored.sessions['research-a'].readers[key]).toEqual(before.sessions['research-a'].readers[key]);
    expect(restored.requests[run.requestId].context[0].region).toEqual(run.context[0].region);
    expect(restored.conversations['conversation-research-a'].codex?.model).toBe('vision');
    const retainedImage = await page.evaluate(async assetId => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('papertrail', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        const blob = await new Promise<Blob>((resolve, reject) => {
          const request = db.transaction('assets').objectStore('assets').get(assetId);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return { type: blob.type, size: blob.size, hash: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('') };
      } finally { db.close(); }
    }, run.context[0].region!.assetId);
    expect(retainedImage).toEqual({ type: 'image/png', size: bytes.length, hash: imageHash });
    expect(runs).toHaveLength(1); expect(directModelCalls).toBe(0); expect(pageErrors).toEqual([]);
    await saved(page); await mkdir('docs/verification/reader-images', { recursive: true });
    await page.screenshot({ path: 'docs/verification/reader-images/desktop-reader-images.png' });
    await writeFile('docs/verification/reader-images/desktop-reader-images.json', JSON.stringify({
      executablePath, protocol: 'papertrail://app/', mockNativeRequests: runs.length, actualModelCalls: 0, recordingStarted: false,
      continuousScrollReachedPage: 2, readersAfterRestart: restored.sessions['research-a'].readers,
      model: run.codex.model, evidencePageIndex: run.context[0].pageIndex, imageBytes: bytes.length, imageHash,
      screenshotMatchesFrozenSource: true, imageAssetRetainedAfterRestart: true, nextDraftRetained: true, pageErrors,
    }, null, 2) + '\n');
  } finally {
    const appProcess = application?.process();
    try { if (application) await close(application); }
    finally {
      if (appProcess?.exitCode === null) appProcess.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
});
