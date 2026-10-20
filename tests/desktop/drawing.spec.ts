import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { BoardDrawingRef, WorkspaceData } from '../../src/domain/types';

const packageRoot = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin'
  ? join(packageRoot, 'Papertrail.app/Contents/MacOS/Papertrail') : join(packageRoot, 'Papertrail.exe'));
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const drawing = (page: Page) => main(page).getByLabel('白板自由绘图', { exact: true });
const canvas = (page: Page) => drawing(page).locator('canvas.interactive');
const note = '离线绘图：原文依据与适用条件';
type DrawingNetwork = { fonts: string[]; fontResponses: { url: string; status: number }[]; failedFonts: string[]; externalRequests: string[]; modelRequests: string[] };

async function close(application: ElectronApplication) {
  const exited = application.waitForEvent('close');
  void application.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
}

async function storedDrawing(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const read = <T,>(store: string, id: string) => new Promise<T>((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).get(id);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const data = await read<WorkspaceData>('workspace', 'current'), ref = data.boards['board-a'].drawing;
      if (!ref) return undefined;
      const blob = await read<Blob>('assets', ref.assetId);
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const scene = JSON.parse(await blob.text()) as { type: string; elements: { id: string; type: string; text?: string; isDeleted: boolean }[] };
      return { ref, hash, scene, mode: data.sessions['research-a'].boardModes?.['board-a'] };
    } finally { db.close(); }
  });
}

test('打包桌面真实绘图与中文文字离线可用，字体本地加载且退出重启后保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-desktop-drawing-'));
  const userData = join(directory, 'app-data'), home = join(directory, 'isolated-home');
  await Promise.all([mkdir(userData), mkdir(join(home, '.codex'), { recursive: true })]);
  const fonts: string[] = [], failedFonts: string[] = [], externalRequests: string[] = [], modelRequests: string[] = [], pageErrors: string[] = [], securityErrors: string[] = [];
  const fontResponses: { url: string; status: number }[] = [];
  let application: ElectronApplication | undefined;
  async function captureNetwork() {
    const network = await application!.evaluate(() => Reflect.get(globalThis, '__papertrailDrawingNetwork') as DrawingNetwork);
    fonts.push(...network.fonts); fontResponses.push(...network.fontResponses); failedFonts.push(...network.failedFonts);
    externalRequests.push(...network.externalRequests); modelRequests.push(...network.modelRequests);
  }
  async function launch() {
    application = await _electron.launch({ executablePath, env: {
      ...process.env, PAPERTRAIL_USER_DATA: userData, HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
      OPENCODE_CONFIG_DIR: join(home, '.opencode'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '',
      AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
    }, timeout: 60_000 });
    await application.evaluate(({ session }) => {
      const network: DrawingNetwork = { fonts: [], fontResponses: [], failedFonts: [], externalRequests: [], modelRequests: [] };
      Object.assign(globalThis, { __papertrailDrawingNetwork: network });
      const font = (url: string) => /\.(?:woff2?|ttf)(?:\?|$)/i.test(url);
      // Electron network events include papertrail:// font loads that Playwright omits.
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (font(details.url)) network.fonts.push(details.url);
        if (/^https?:\/\//.test(details.url) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(details.url)) network.externalRequests.push(details.url);
        if (/\/api\/ai\/(?:chat|agents\/run)$/.test(new URL(details.url).pathname)) network.modelRequests.push(details.url);
        callback({});
      });
      session.defaultSession.webRequest.onCompleted(details => {
        if (font(details.url)) { network.fontResponses.push({ url: details.url, status: details.statusCode }); if (details.statusCode >= 400) network.failedFonts.push(details.url); }
      });
      session.defaultSession.webRequest.onErrorOccurred(details => { if (font(details.url)) network.failedFonts.push(`${details.url} ${details.error}`); });
    });
    const page = await application.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (/Content Security Policy|Refused to|Failed to decode downloaded font|OTS parsing error/i.test(message.text())) securityErrors.push(message.text()); });
    await page.route('**/api/ai/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (/\/api\/ai\/(?:chat|agents\/run)$/.test(pathname)) modelRequests.push(route.request().url());
      if (pathname === '/api/ai/config') return route.fulfill({ json: { configured: false, images: false, model: '离线绘图验收', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } });
      if (pathname === '/api/ai/agents') return route.fulfill({ json: { agents: [] } });
      return route.fulfill({ status: 501, json: { error: '离线绘图验收不调用助手服务' } });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(main(page)).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    expect(page.url()).toBe('papertrail://app/');
    return page;
  }
  try {
    let page = await launch();
    await page.getByRole('complementary', { name: '左侧导航' }).getByRole('button', { name: '证据与论证', exact: true }).click();
    await main(page).getByRole('button', { name: '绘图', exact: true }).click();
    await expect(canvas(page)).toBeVisible();
    await drawing(page).getByRole('button', { name: '缩小', exact: true }).click();
    await drawing(page).getByRole('button', { name: '缩小', exact: true }).click();
    const bounds = (await canvas(page).boundingBox())!, x = bounds.x + bounds.width - 215, y = bounds.y + bounds.height - 240;
    await drawing(page).getByTestId('toolbar-rectangle').locator('..').click();
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 160, y + 70, { steps: 12 }); await page.mouse.up();
    await drawing(page).getByTestId('toolbar-text').locator('..').click();
    await canvas(page).click({ position: { x: bounds.width - 350, y: bounds.height - 140 } });
    await page.keyboard.insertText(note); await page.keyboard.press('Escape');
    await expect.poll(async () => (await storedDrawing(page))?.scene.elements.filter(element => !element.isDeleted).map(element => element.type)).toEqual(expect.arrayContaining(['rectangle', 'text']));
    await expect(drawing(page).getByText('绘图已保存', { exact: true })).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    const saved = (await storedDrawing(page))!;
    expect(saved.scene.elements.some(element => !element.isDeleted && element.text === note)).toBe(true);
    expect(saved.ref).toEqual({ assetId: `drawing-${saved.hash}`, hash: saved.hash } satisfies BoardDrawingRef);
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(async () => application!.evaluate(() => (Reflect.get(globalThis, '__papertrailDrawingNetwork') as DrawingNetwork).fonts.length)).toBeGreaterThan(0);
    await captureNetwork();
    const fontRuntime = await page.evaluate(() => ({
      href: window.location.href,
      assetPath: (window as unknown as { EXCALIDRAW_ASSET_PATH?: string | string[] }).EXCALIDRAW_ASSET_PATH,
      excalifont: [...document.fonts].filter(face => face.family === 'Excalifont').slice(0, 1).map(face => ({ family: face.family, status: face.status, unicodeRange: face.unicodeRange, weight: face.weight, style: face.style })),
      fontResources: performance.getEntriesByType('resource').filter(entry => /\.(?:woff2?|ttf)(?:\?|$)/i.test(entry.name)).map(entry => entry.name),
    }));
    await writeFile(test.info().outputPath('desktop-drawing-observation.json'), JSON.stringify({ fontRuntime, fonts, fontResponses, failedFonts, externalRequests, modelRequests, pageErrors, securityErrors }, null, 2) + '\n');
    expect(fonts.every(url => url.startsWith('papertrail://app/')), fonts.slice(0, 5).join('\n')).toBe(true);
    await drawing(page).locator('.excalidraw').press('Escape');
    await canvas(page).click({ position: { x: bounds.width - 80, y: bounds.height - 80 } });
    await mkdir('docs/verification/drawing', { recursive: true });
    await page.screenshot({ path: 'docs/verification/drawing/desktop-drawing.png' });
    await close(application!); application = undefined;
    page = await launch();
    await expect(canvas(page)).toBeVisible();
    const restored = (await storedDrawing(page))!;
    expect(restored.ref).toEqual(saved.ref); expect(restored.hash).toBe(saved.hash);
    expect(restored.scene).toEqual(saved.scene); expect(restored.mode).toBe('draw');
    await page.evaluate(() => document.fonts.ready);
    await captureNetwork();
    expect(fonts.every(url => url.startsWith('papertrail://app/'))).toBe(true);
    expect(failedFonts).toEqual([]); expect(externalRequests).toEqual([]); expect(modelRequests).toEqual([]); expect(pageErrors).toEqual([]); expect(securityErrors).toEqual([]);
    const evidence = JSON.stringify({ executablePath, localFonts: [...new Set(fonts)], fontResponses, failedFonts, externalRequests, modelRequests, pageErrors, securityErrors, drawingRetainedAfterRestart: true, drawing: saved.ref }, null, 2) + '\n';
    await writeFile(test.info().outputPath('desktop-drawing-evidence.json'), evidence);
    await writeFile('docs/verification/drawing/font-desktop-evidence.json', evidence);
  } finally {
    if (application) await close(application);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
