import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow } from 'electron';
import { createSeed } from '../../src/data/seed';
import { mockProjectService } from '../e2e/project-fixture';

const packageRoot = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin'
  ? join(packageRoot, 'Papertrail.app/Contents/MacOS/Papertrail') : join(packageRoot, 'Papertrail.exe'));
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const input = (page: Page) => panel(page).getByLabel('向 AI 提问');
const exitButton = (page: Page) => page.getByRole('button', { name: '退出全屏', exact: true });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');

async function launch(userData: string, home: string) {
  const application = await _electron.launch({ executablePath, env: {
    ...process.env, PAPERTRAIL_USER_DATA: userData, HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
    OPENCODE_CONFIG_DIR: join(home, '.opencode'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '',
    AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
  }, timeout: 60_000 });
  try {
    const page = await application.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible(); await saved(page);
    return { application, page };
  } catch (error) { const exited = application.waitForEvent('close'); application.process().kill(); await exited; throw error; }
}
async function close(application: ElectronApplication) {
  const exited = application.waitForEvent('close');
  void application.evaluate(({ app }) => app.quit()).catch(() => {}); await exited;
}

for (const initialState of ['default', 'maximized'] as const) test(`打包桌面：${initialState === 'default' ? '默认' : '最大化'}窗口全屏可退出，刷新与快捷键保留草稿和原生框架`, async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-desktop-fullscreen-'));
  const userData = join(directory, 'app-data'), home = join(directory, 'isolated-home');
  await Promise.all([mkdir(userData), mkdir(home)]);
  let application: ElectronApplication | undefined;
  const pageErrors: string[] = [], modelCalls: string[] = [];
  const draft = '退出全屏时保留这段未发送的研究问题。';
  try {
    const session = await launch(userData, home); application = session.application; const page = session.page;
    const mainWindow = await application.browserWindow(page);
    if (initialState === 'maximized') await mainWindow.evaluate((window: BrowserWindow) => new Promise<void>(resolve => {
      if (window.isMaximized()) resolve();
      else { window.once('maximize', () => resolve()); window.maximize(); }
    }));
    const readFrame = () => mainWindow.evaluate((window: BrowserWindow) => ({
      fullScreen: window.isFullScreen(), normal: window.isNormal(), maximized: window.isMaximized(), minimized: window.isMinimized(),
      closable: window.isClosable(), minimizable: window.isMinimizable(), fullScreenable: window.isFullScreenable(),
      frameInset: window.getBounds().height - window.getContentBounds().height, bounds: window.getBounds(),
    }));
    const suffix = initialState === 'maximized' ? '-maximized' : '';
    const evidencePath = `docs/verification/pane-navigation/desktop-fullscreen${suffix}.json`;
    const frameAuditPath = testInfo.outputPath('native-window-frames.json');
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { if (/\/api\/ai\/(?:chat|agents\/run)$/.test(new URL(request.url()).pathname)) modelCalls.push(request.url()); });
    const seed = createSeed(); seed.sessions['research-a'].panel.mode = 'ai';
    for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'demo';
    await mockProjectService(page, { seed });
    await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: '', mode: 'demo', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
    await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
    await page.reload(); await expect(input(page)).toBeVisible(); await input(page).fill(draft); await saved(page);
    await expect(exitButton(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.papertrailDesktop?.getFullScreen?.())).toBe(false);

    const settingsReady = application.waitForEvent('window');
    await page.evaluate(() => window.papertrailDesktop?.openAISettings()); const settings = await settingsReady;
    await settings.waitForLoadState();
    const rejected = await settings.evaluate(async () => {
      const results = await Promise.allSettled([window.papertrailDesktop!.getFullScreen!(), window.papertrailDesktop!.exitFullScreen!()]);
      return results.map(result => result.status === 'rejected' ? String(result.reason) : 'unexpectedly allowed');
    });
    expect(rejected[0]).toContain('不允许此页面读取工作台窗口状态');
    expect(rejected[1]).toContain('不允许此页面修改工作台窗口状态');
    const settingsWindow = await application.browserWindow(settings);
    await settingsWindow.evaluate((window: BrowserWindow) => new Promise<void>(resolve => {
      window.once('closed', () => resolve()); window.close();
    }));

    const initialFrame = await readFrame();
    expect(initialFrame).toMatchObject({ fullScreen: false, minimized: false, closable: true, minimizable: true, fullScreenable: true });
    if (initialState === 'maximized') expect(initialFrame).toMatchObject({ normal: false, maximized: true });
    expect(initialFrame.frameInset).toBeGreaterThan(0);
    await mkdir('docs/verification/pane-navigation', { recursive: true });
    await writeFile(frameAuditPath, JSON.stringify({ executablePath, initialState, stage: 'before-fullscreen', initialFrame }, null, 2) + '\n');
    console.info('Native frame before fullscreen', initialFrame);
    await mainWindow.evaluate((window: BrowserWindow) => new Promise<void>(resolve => {
      window.once('enter-full-screen', () => resolve()); window.setFullScreen(true);
    }));
    await expect(exitButton(page)).toBeVisible();
    await expect(exitButton(page)).toHaveAttribute('title', process.platform === 'darwin' ? '退出全屏 · ⌃⌘F' : '退出全屏 · F11');
    expect(await page.evaluate(() => window.papertrailDesktop?.getFullScreen?.())).toBe(true);
    await page.reload(); await expect(exitButton(page)).toBeVisible(); await expect(input(page)).toHaveValue(draft);
    await page.screenshot({ path: `docs/verification/pane-navigation/desktop-fullscreen${suffix}.png` });

    const left = mainWindow.evaluate((window: BrowserWindow) => new Promise<void>(resolve => {
      window.once('leave-full-screen', () => resolve());
    }));
    await exitButton(page).click(); await left;
    await expect(exitButton(page)).toHaveCount(0); await expect(input(page)).toHaveValue(draft);
    const expectedFrame = { fullScreen: false, normal: initialFrame.normal, maximized: initialFrame.maximized, minimized: initialFrame.minimized,
      closable: true, minimizable: true, fullScreenable: true };
    let restoredFrame = await readFrame();
    try {
      // Native transitions are asynchronous, and fullscreen must restore the original window state.
      await expect.poll(async () => { restoredFrame = await readFrame(); return restoredFrame; }).toMatchObject(expectedFrame);
      expect(restoredFrame.frameInset).toBeGreaterThan(0);
    } finally {
      await writeFile(frameAuditPath, JSON.stringify({ executablePath, initialState, stage: 'restored-frame-check', initialFrame, restoredFrame }, null, 2) + '\n');
    }

    const shortcut = process.platform === 'darwin' ? 'Control+Meta+f' : 'F11';
    await mainWindow.evaluate((window: BrowserWindow) => {
      const audit = { entered: 0, left: 0, inputs: [] as object[] };
      Reflect.set(window, '__fullscreenKeyboardAudit', audit);
      window.on('enter-full-screen', () => audit.entered++); window.on('leave-full-screen', () => audit.left++);
      window.webContents.on('before-input-event', (_event, input) => audit.inputs.push({ ...input }));
      window.focus(); window.webContents.focus();
    });
    const keyboardState = () => mainWindow.evaluate((window: BrowserWindow) => {
      return { focused: window.isFocused(), contentsFocused: window.webContents.isFocused(), fullScreen: window.isFullScreen(), ...Reflect.get(window, '__fullscreenKeyboardAudit') as { entered: number; left: number; inputs: object[] } };
    });
    await expect.poll(async () => { const state = await keyboardState(); return state.focused && state.contentsFocused; }).toBe(true);
    const sendShortcut = () => mainWindow.evaluate((window: BrowserWindow) => {
      const contents = window.webContents;
      const keyCode = process.platform === 'darwin' ? 'F' : 'F11';
      const modifiers: ('control' | 'meta')[] = process.platform === 'darwin' ? ['control', 'meta'] : [];
      // CDP keyboard events bypass Electron's native shortcut pipeline; use its documented input API.
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    });
    try {
      await input(page).focus(); await sendShortcut();
      await expect.poll(async () => (await keyboardState()).entered).toBe(1);
      await expect(exitButton(page)).toBeVisible();
      await sendShortcut();
      await expect.poll(async () => (await keyboardState()).left).toBe(1);
    } catch (error) {
      console.info('Isolated fullscreen keyboard audit', await keyboardState()); throw error;
    }
    const keyboardAudit = await keyboardState();
    console.info('Verified native fullscreen keyboard audit', keyboardAudit);
    expect(keyboardAudit.inputs.filter(input => Reflect.get(input, 'type') === 'keyDown')).toHaveLength(2);
    await expect(exitButton(page)).toHaveCount(0); await expect(input(page)).toHaveValue(draft);
    await expect.poll(readFrame).toMatchObject(expectedFrame);
    await saved(page); expect(modelCalls).toEqual([]); expect(pageErrors).toEqual([]);
    await page.screenshot({ path: `docs/verification/pane-navigation/desktop-window-restored${suffix}.png` });
    const evidence = JSON.stringify({ executablePath, initialState, stage: 'complete', initialFrame,
      protocol: 'papertrail://app/', nativeFullscreenEventsVerified: true, refreshRetainsExitButton: true,
      exitButtonWorks: true, shortcutWorks: true, shortcut, keyboardTransport: 'Electron webContents.sendInputEvent', keyboardAudit, restoredFrame, settingsIPCRejected: true,
      nextDraftRetained: true, actualModelCalls: 0, pageErrors,
    }, null, 2) + '\n';
    await Promise.all([writeFile(evidencePath, evidence), writeFile(frameAuditPath, evidence)]);
  } finally {
    const appProcess = application?.process();
    try { if (application) await close(application); }
    finally {
      if (appProcess?.exitCode === null) appProcess.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
});
