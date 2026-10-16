import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { listPackage } from '@electron/asar';

const root = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin'
  ? join(root, 'Papertrail.app/Contents/MacOS/Papertrail') : join(root, 'Papertrail.exe'));
const screenshots = resolve('test-results-desktop/screenshots');
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const navigation = (page: Page) => page.getByRole('complementary', { name: '左侧导航' });
async function openNav(page: Page, name: string) {
  await navigation(page).getByRole('button', { name, exact: true }).first().click();
}
async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
}
async function launch(directory: string) {
  const application = await _electron.launch({ executablePath, env: { ...process.env, PAPERTRAIL_USER_DATA: directory }, timeout: 60_000 });
  const page = await application.firstWindow();
  await expect(page.getByRole('button', { name: '新建研究', exact: true })).toBeVisible();
  await saved(page);
  return { application, page };
}
async function close(application: ElectronApplication) {
  const exited = application.waitForEvent('close');
  void application.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
}
async function screenshot(page: Page, name: string) {
  await saved(page);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(screenshots, name), fullPage: false });
}

test('安装产物：独立运行、PDF与双栏、模型设置、关闭保存及重启恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-desktop-e2e-'));
  await mkdir(screenshots, { recursive: true });
  let application: ElectronApplication | undefined;
  const pageErrors: string[] = [];
  try {
    let session = await launch(directory);
    application = session.application;
    let page = session.page;
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(page.url()).toBe('papertrail://app/');
    const asar = process.platform === 'darwin' ? resolve(dirname(executablePath), '../Resources/app.asar') : join(dirname(executablePath), 'resources/app.asar');
    const entries = listPackage(asar, { isPack: false });
    expect(entries.filter(name => /(?:^|[/\\])(?:\.env[^/\\]*|\.git|tests|docs)(?:$|[/\\])|\.(?:p12|pfx)$|\.(?:test|spec)\.mjs$/.test(name))).toEqual([]);
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
    await expect(page.evaluate(() => (window.papertrailDesktop as unknown as { getAISettings(): Promise<unknown> }).getAISettings())).rejects.toThrow();
    expect(await page.evaluate(async () => (await fetch('/api/ai/config')).json())).toMatchObject({ configured: false });

    await page.getByLabel('选择 PDF 文件').first().setInputFiles(resolve('public/samples/adaptive-retrieval.pdf'));
    await expect(main(page).locator('.pdf-text-layer').first()).toContainText('Retrieval');
    await panel(page).getByRole('tab', { name: '参考', exact: true }).click();
    await panel(page).getByRole('button', { name: /相关性是检索收益的前提/ }).first().click();
    await expect(panel(page).getByLabel('卡片正文')).toBeVisible();
    await screenshot(page, '01-pdf-card-1440x900.png');

    await openNav(page, '证据与论证');
    await expect(main(page).locator('.board-viewport')).toBeVisible();
    await main(page).locator('[data-resource-id="card-a"]').first().click();
    await main(page).getByRole('button', { name: '查看卡片原文：相关性是检索收益的前提' }).click();
    await expect(panel(page).locator('.pdf-text-layer').first()).toContainText('Retrieval');
    await page.setViewportSize({ width: 1280, height: 800 });
    await screenshot(page, '02-board-source-1280x800.png');

    await openNav(page, '结论与导出');
    await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await expect(panel(page).getByRole('button', { name: '配置模型连接' })).toBeVisible();
    const settingsEvent = application.waitForEvent('window');
    await panel(page).getByRole('button', { name: '配置模型连接' }).click();
    const settings = await settingsEvent;
    await settings.getByLabel('API 密钥').fill('desktop-test-only-never-sent');
    await settings.getByRole('button', { name: '保存连接' }).click();
    await expect(settings.getByRole('status')).toContainText('连接已保存');
    const stored = await readFile(join(directory, 'ai-settings.json'), 'utf8');
    expect(stored).not.toContain('desktop-test-only-never-sent');
    const config = await page.evaluate(async () => (await fetch('/api/ai/config')).json());
    expect(config.configured).toBe(true);
    expect(JSON.stringify(config)).not.toContain('desktop-test-only-never-sent');
    await settings.getByLabel('清除此电脑保存的密钥').check();
    await settings.getByRole('button', { name: '保存连接' }).click();
    await expect(settings.getByRole('status')).toContainText('当前未配置密钥');
    await settings.close();
    await page.setViewportSize({ width: 1440, height: 900 });
    await screenshot(page, '03-writing-ai-1440x900.png');
    await page.setViewportSize({ width: 1024, height: 800 });
    await screenshot(page, '04-writing-ai-1024x800.png');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: '存储与设置' }).click();
    await expect(page.getByRole('button', { name: '导出完整备份' })).toBeVisible();
    await screenshot(page, '05-storage-1280x800.png');
    await page.getByRole('button', { name: '关闭弹层' }).click();

    // Exceed the recovery-journal size, edit, and quit before the debounce fires.
    const finalBody = `关闭前最后编辑\n${'保留原文与研究结论。'.repeat(170_000)}`;
    await main(page).getByLabel('结论正文').fill(finalBody);
    await close(application);
    application = undefined;
    session = await launch(directory);
    application = session.application;
    page = session.page;
    await expect(main(page).getByLabel('结论正文')).toHaveValue(finalBody);
    expect(await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('papertrail', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return new Promise<number>((resolve, reject) => {
        const request = db.transaction('assets').objectStore('assets').count();
        request.onsuccess = () => { resolve(request.result); db.close(); };
        request.onerror = () => reject(request.error);
      });
    })).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  } finally {
    if (application) await close(application).catch(() => application?.process().kill());
    await rm(directory, { recursive: true, force: true });
  }
});

test('保存失败保留窗口与最新修改，重试后允许退出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-save-error-'));
  let application: ElectronApplication | undefined;
  try {
    const session = await launch(directory);
    application = session.application;
    const page = session.page;
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
    await openNav(page, '结论与导出');
    await saved(page);
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      (window as unknown as { restorePut(): void }).restorePut = () => { IDBObjectStore.prototype.put = original; };
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'workspace' && args[1] === 'current') throw new DOMException('injected quota error', 'QuotaExceededError');
        return original.apply(this, args as Parameters<typeof original>);
      };
    });
    await main(page).getByLabel('结论正文').fill('保存失败也必须保留这条修改');
    await application.evaluate(({ app }) => app.quit());
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'error');
    await expect.poll(() => page.evaluate(() => document.body.inert)).toBe(false);
    await expect(main(page).getByLabel('结论正文')).toHaveValue('保存失败也必须保留这条修改');
    await page.evaluate(() => (window as unknown as { restorePut(): void }).restorePut());
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await saved(page);
  } finally {
    if (application) await close(application).catch(() => application?.process().kill());
    await rm(directory, { recursive: true, force: true });
  }
});

test('生成过程中退出保留已收到的文字与原研究归属', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-stream-close-'));
  let application: ElectronApplication | undefined;
  try {
    let session = await launch(directory);
    application = session.application;
    let page = session.page;
    await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await panel(page).getByLabel('AI 运行模式').selectOption('demo');
    await panel(page).getByLabel('向 AI 提问').fill('退出时保留收到的文字。'.repeat(150));
    await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(panel(page).getByText(/演示回答：/).first()).toBeVisible();
    await close(application);
    application = undefined;
    session = await launch(directory);
    application = session.application;
    page = session.page;
    const requests = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('papertrail', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return new Promise<Array<{ body: string; status: string; researchId: string }>>((resolve, reject) => {
        const request = db.transaction('workspace').objectStore('workspace').get('current');
        request.onsuccess = () => { resolve(Object.values(request.result.requests)); db.close(); };
        request.onerror = () => reject(request.error);
      });
    });
    expect(requests.at(-1)).toMatchObject({ status: 'stopped', researchId: 'research-a' });
    expect(requests.at(-1)?.body).toContain('演示回答：');
  } finally {
    if (application) await close(application).catch(() => application?.process().kill());
    await rm(directory, { recursive: true, force: true });
  }
});

test('工作台没有关闭回应时保留应用，并允许用户明确强制退出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-unresponsive-'));
  let application: ElectronApplication | undefined;
  try {
    const session = await launch(directory);
    application = session.application;
    await application.evaluate(({ BrowserWindow, dialog }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const originalSend = contents.send.bind(contents);
      contents.send = (channel, ...args) => { if (channel !== 'papertrail:prepare-close') originalSend(channel, ...args); };
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await application.evaluate(({ app }) => app.quit());
    // Timeout offers a choice; it must never silently allow data loss.
    await new Promise(resolve => setTimeout(resolve, 10_500));
    await expect(session.page.getByRole('button', { name: '新建研究', exact: true })).toBeVisible();
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); });
    await close(application);
    application = undefined;
  } finally {
    if (application) application.process().kill();
    await rm(directory, { recursive: true, force: true });
  }
});
