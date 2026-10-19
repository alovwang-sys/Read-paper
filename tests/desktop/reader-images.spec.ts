import { expect, test, _electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createSeed } from '../../src/data/seed';
import type { ContextSnapshot, ReadingPosition, WorkspaceData } from '../../src/domain/types';
import { fixtureSessionRef, mockProjectService } from '../e2e/project-fixture';
import { openSource } from '../e2e/knowledge-helpers';
import { dragView, groups, paneAction, paneById, split } from '../e2e/workspace-split-helpers';

const packageRoot = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin'
  ? join(packageRoot, 'Papertrail.app/Contents/MacOS/Papertrail') : join(packageRoot, 'Papertrail.exe'));
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const primary = (page: Page) => main(page).getByRole('region', { name: '工作区窗格 1', exact: true });
const secondary = (page: Page) => main(page).getByRole('region', { name: '工作区窗格 2', exact: true });
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

async function viewportPosition(pane: Locator) {
  return pane.locator('.pdf-scroll').evaluate(node => {
    const bounds = node.getBoundingClientRect(), padding = parseFloat(getComputedStyle(node).paddingTop);
    const sheet = [...node.querySelectorAll<HTMLElement>('.pdf-sheet')].find(sheet => sheet.getBoundingClientRect().bottom > bounds.top + padding + 1)!;
    const page = sheet.getBoundingClientRect();
    return { pageIndex: Number(sheet.dataset.pageIndex), offset: (bounds.top + padding - page.top) / page.height };
  });
}
function expectSameReading(actual: ReadingPosition | undefined, expected: ReadingPosition | undefined) {
  expect(actual).toBeDefined(); expect(expected).toBeDefined();
  expect(actual).toMatchObject({ pageIndex: expected!.pageIndex, scale: expected!.scale });
  // Canvas dimensions round to pixels when the layout returns to two panes.
  expect(Math.abs((actual!.offset ?? 0) - (expected!.offset ?? 0))).toBeLessThanOrEqual(.002);
}

// PDF rendering, cropping, IndexedDB and shutdown are real; only the native service uses fixtures.
test('打包桌面：唯一论文标签拖边缘分屏、连续阅读和Codex区域图片在正常退出重启后保留', async () => {
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
    await primary(page).getByRole('button', { name: '关闭标签 研究主页', exact: true }).click();
    await primary(page).getByRole('button', { name: '关闭标签 资料', exact: true }).click();

    const scroller = primary(page).locator('.pdf-scroll');
    const pageStep = await primary(page).locator('.pdf-sheet[data-page-index="0"]').evaluate(sheet => sheet.getBoundingClientRect().height + 24);
    await scroller.hover(); await page.mouse.wheel(0, pageStep + 10);
    await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
    await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(pageStep);
    const beforeSplit = await scroller.evaluate(node => node.scrollTop);
    const initialGroups = groups((await state(page)).sessions['research-a'].layout!.root);
    expect(initialGroups).toHaveLength(1); expect(initialGroups[0].tabs).toHaveLength(1);
    const originalView = initialGroups[0].tabs[0];
    expect(originalView.ref).toEqual({ kind: 'document', id: 'paper-a' });
    await expect(primary(page).getByRole('tab')).toHaveCount(1);
    await expect(primary(page).getByRole('button', { name: '窗格 1 操作', exact: true })).toContainText('分屏');
    await page.evaluate(() => window.addEventListener('drop', event => {
      const drag = event as DragEvent;
      (window as unknown as { nativePaneDrop: { alt: boolean; trusted: boolean } }).nativePaneDrop = { alt: drag.altKey, trusted: drag.isTrusted };
    }, true));
    await dragView(page, originalView.id, primary(page), 'down', false, async () => {
      await expect(primary(page).locator('.pane-drop-preview')).toHaveAttribute('data-drop-mode', 'copy');
      await mkdir('docs/verification/pane-navigation', { recursive: true });
      await page.screenshot({ path: 'docs/verification/pane-navigation/desktop-copy-preview.png' });
    }, '保留原标签');
    const nativeDrop = await page.evaluate(() => (window as unknown as { nativePaneDrop: { alt: boolean; trusted: boolean } }).nativePaneDrop);
    expect(nativeDrop).toEqual({ alt: false, trusted: true });
    await expect(secondary(page)).toBeVisible();
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
    const selection = page.getByLabel('原文选区操作', { exact: true });
    await selection.getByText('查看所选区域', { exact: true }).click();
    await expect(selection.getByAltText('所选区域预览，PDF 第 2 页')).toBeVisible();
    await selection.getByRole('button', { name: '摘录', exact: true }).click();
    await selection.getByRole('button', { name: '提问', exact: true }).click();
    await page.getByRole('dialog', { name: '原文旁提问' }).getByRole('button', { name: '在右侧继续', exact: true }).click();
    await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Codex', exact: true }).click();
    await panel(page).getByRole('button', { name: '添加材料', exact: true }).click();
    const materials = panel(page).getByRole('dialog', { name: '添加对话材料', exact: true });
    await materials.getByRole('button', { name: /Adaptive Retrieval.*PDF 第 2 页.*已保存的原文区域/ }).click();
    await materials.getByRole('button', { name: '完成', exact: true }).click();
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
    const secondaryId = (await secondary(page).getAttribute('data-pane-id'))!;
    await saved(page);
    const ordinaryViews = groups((await state(page)).sessions['research-a'].layout!.root).flatMap(group => group.tabs).filter(tab => tab.ref.kind === 'document').map(tab => ({ id: tab.id, reading: tab.reading }));
    // Leave a source region, then clone and move its view: the current offset must win over the old anchor.
    await panel(page).getByRole('button', { name: /^引用 1：/ }).click();
    await expect(primary(page).locator('.pdf-region-source')).toHaveCount(1);
    const citationViewId = (await primary(page).getByRole('region', { name: 'PDF 阅读器', exact: true }).getAttribute('data-view-id'))!;
    expect(ordinaryViews.some(view => `view:${view.id}` === citationViewId)).toBe(false);
    const afterCitation = groups((await state(page)).sessions['research-a'].layout!.root).flatMap(group => group.tabs);
    for (const view of ordinaryViews) expectSameReading(afterCitation.find(tab => tab.id === view.id)?.reading, view.reading);
    await primary(page).locator('.pdf-scroll').evaluate(async node => {
      node.scrollTop += node.querySelector<HTMLElement>('.pdf-sheet[data-page-index="1"]')!.getBoundingClientRect().height * .28;
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    });
    const beforeClone = await viewportPosition(primary(page));
    expect(beforeClone.pageIndex).toBe(1); expect(beforeClone.offset).toBeGreaterThan(.2);
    const cloned = await split(page, primary(page), '下');
    await expect.poll(async () => Math.abs((await viewportPosition(cloned)).offset - beforeClone.offset)).toBeLessThanOrEqual(.02);
    await expect(cloned.locator('.pdf-region-source')).toHaveCount(1);
    const clonedViewId = (await cloned.getByRole('region', { name: 'PDF 阅读器', exact: true }).getAttribute('data-view-id'))!;
    await paneAction(page, cloned, `移到 下方 · ${seed.documents['paper-a'].title}`);
    const moved = paneById(page, secondaryId);
    await expect(moved.getByRole('region', { name: 'PDF 阅读器', exact: true })).toHaveAttribute('data-view-id', clonedViewId);
    await expect.poll(async () => Math.abs((await viewportPosition(moved)).offset - beforeClone.offset)).toBeLessThanOrEqual(.02);
    await expect(moved.locator('.pdf-region-source')).toHaveCount(1);
    await paneAction(page, moved, '关闭当前标签');
    await expect(secondary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('3');
    await expect(secondary(page).locator('.pdf-zoom')).toContainText('125%');
    const readingViews = async () => groups((await state(page)).sessions['research-a'].layout!.root).flatMap(group => group.tabs).filter(tab => tab.ref.kind === 'document' && tab.ref.id === 'paper-a');
    await expect.poll(async () => (await readingViews()).map(tab => tab.reading)).toMatchObject([{ pageIndex: 1, scale: 1 }, { pageIndex: 1, scale: 1 }, { pageIndex: 2, scale: 1.25 }]);
    await saved(page); const before = await state(page);
    const beforeViews = await readingViews();
    expect(beforeViews).toHaveLength(3);
    expect(new Set(beforeViews.map(tab => tab.id)).size).toBe(3);
    for (const view of ordinaryViews) expectSameReading(beforeViews.find(tab => tab.id === view.id)?.reading, view.reading);
    await expect(primary(page).getByRole('region', { name: 'PDF 阅读器', exact: true })).toHaveAttribute('data-view-id', citationViewId);
    await expect(secondary(page).getByRole('region', { name: 'PDF 阅读器', exact: true })).toHaveAttribute('data-view-id', `view:${ordinaryViews[1].id}`);
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
    expect(restored.documents['paper-a']).toMatchObject({ assetId: seed.documents['paper-a'].assetId, hash: seed.documents['paper-a'].hash, pageCount: 3 });
    expect(restored.sessions['research-a'].layout).toEqual(before.sessions['research-a'].layout);
    const restoredViews = groups(restored.sessions['research-a'].layout!.root).flatMap(group => group.tabs).filter(tab => tab.ref.kind === 'document' && tab.ref.id === 'paper-a');
    expect(restoredViews.map(tab => ({ id: tab.id, reading: tab.reading }))).toEqual(beforeViews.map(tab => ({ id: tab.id, reading: tab.reading })));
    await primary(page).locator(`[role="tab"][data-tab-id="${originalView.id}"]`).click();
    await expect(primary(page).getByLabel('PDF 页码', { exact: true })).toHaveValue('2');
    await expect(primary(page).locator('.pdf-zoom')).toContainText('100%');
    await expect(primary(page).locator('.pdf-region-source')).toHaveCount(0);
    await primary(page).locator(`[role="tab"][data-tab-id="${citationViewId.slice(5)}"]`).click();
    await expect(primary(page).locator('.pdf-region-source')).toHaveCount(1);
    await expect.poll(async () => Math.abs((await viewportPosition(primary(page))).offset - beforeClone.offset)).toBeLessThanOrEqual(.02);
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
    await saved(page); await mkdir('docs/verification/pane-navigation', { recursive: true });
    await page.screenshot({ path: 'docs/verification/pane-navigation/desktop-reader-images.png' });
    await writeFile('docs/verification/pane-navigation/desktop-reader-images.json', JSON.stringify({
      executablePath, protocol: 'papertrail://app/', mockNativeRequests: runs.length, actualModelCalls: 0, recordingStarted: false,
      continuousScrollReachedPage: 2, paneLayoutRetainedAfterRestart: true,
      soleTabEdgeDrag: { direction: 'down', ...nativeDrop, copyPreview: true },
      citationCreatesSeparateView: true, ordinaryReadingPositionsRetained: true,
      anchoredViewCloneAndMoveRetainOffset: true, sourceHighlightRetainedAfterCloneAndMove: true,
      readersAfterRestart: restoredViews.map(tab => ({ viewId: tab.id, documentId: tab.ref.id, reading: tab.reading })),
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
