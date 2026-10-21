import { useClassicWorkbench } from './helpers';
import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { WorkspaceData } from '../../src/domain/types';

const root = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin'
  ? join(root, 'Papertrail.app/Contents/MacOS/Papertrail') : join(root, 'Papertrail.exe'));
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
declare global {
  interface Window {
    __papertrailSourceTest: { resolving: boolean; pdfCalls: number; chatCalls: number; release(): void };
  }
}

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
}

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

async function launch(directory: string) {
  const application = await _electron.launch({ executablePath, env: { ...process.env, PAPERTRAIL_USER_DATA: directory }, timeout: 60_000 });
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('button', { name: '新建研究', exact: true })).toBeVisible();
    await useClassicWorkbench(page); await saved(page);
    return { application, page };
  } catch (error) {
    const exited = application.waitForEvent('close');
    application.process().kill();
    await exited;
    throw error;
  }
}

async function close(application: ElectronApplication) {
  const exited = application.waitForEvent('close');
  void application.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
}

test('安装产物来源收录：先保存、补齐本地全文与摘要备注、重启恢复及打包 WASM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-desktop-source-'));
  let application: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    let session = await launch(directory);
    application = session.application;
    let page = session.page;
    page.on('pageerror', error => errors.push(error.message));
    expect(page.url()).toBe('papertrail://app/');
    const wasm = await page.evaluate(async () => {
      const response = await fetch('papertrail://app/pdfjs/wasm/jbig2.wasm');
      return { status: response.status, type: response.headers.get('content-type'), magic: Array.from(new Uint8Array(await response.arrayBuffer()).slice(0, 4)) };
    });
    expect(wasm).toEqual({ status: 200, type: 'application/wasm', magic: [0, 97, 115, 109] });

    const url = 'https://desktop.example.org/retained-source';
    const pdf = await PDFDocument.load(await readFile('public/samples/adaptive-retrieval.pdf'));
    pdf.setTitle('Desktop source intake fixture');
    const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    // Chromium routing skips the custom scheme. Mock only source API fetches in the renderer; packaged assets and storage stay real.
    await page.evaluate(({ url, bytes }) => {
      const original = window.fetch.bind(window);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const fixture = { resolving: false, pdfCalls: 0, chatCalls: 0, release };
      window.__papertrailSourceTest = fixture;
      window.fetch = async (input, init) => {
        const target = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString(), location.href);
        if (target.pathname === '/api/ai/chat') { fixture.chatCalls++; throw new Error('此验证禁止真实模型调用'); }
        if (target.pathname === '/api/sources/resolve') {
          fixture.resolving = true;
          await gate;
          return Response.json({ url, title: '桌面来源收录验证论文', authors: 'Papertrail Test Authors', year: '2026', kind: 'paper', identifiers: { url }, metadataSource: url,
            abstract: { text: '原来源的作者摘要在桌面重启后仍然保留。', url, retrievedAt: '2026-10-17T08:00:00.000Z' }, pdfUrl: `${url}.pdf`, resolvedAt: '2026-10-17T08:00:00.000Z' });
        }
        if (target.pathname === '/api/sources/pdf') {
          fixture.pdfCalls++;
          return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/pdf' } });
        }
        return original(input, init);
      };
    }, { url, bytes: Array.from(bytes) });

    await page.getByRole('button', { name: '添加资料', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: '添加资料', exact: true });
    await dialog.getByLabel('标识、链接或资料标题').fill(url);
    await dialog.getByLabel('标识、链接或资料标题').press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__papertrailSourceTest.resolving)).toBe(true);
    await saved(page);
    const data = await state(page);
    const doc = Object.values(data.documents).find(item => item.identifiers?.url === url)!;
    expect(doc).toBeDefined();
    expect(doc.acquisition?.status).toBe('fetching');
    expect(doc.assetId).toBeUndefined();
    expect(data.researches['research-a'].documentIds).toContain(doc.id);

    await page.evaluate(() => window.__papertrailSourceTest.release());
    await expect(main(page).locator('canvas').first()).toBeVisible();
    await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
    await saved(page);
    expect((await state(page)).documents[doc.id]).toMatchObject({ hash: expectedHash, pageCount: 3, title: '桌面来源收录验证论文' });
    await page.getByRole('button', { name: '文献信息', exact: true }).click();
    await expect(main(page).getByRole('heading', { name: '作者摘要', exact: true })).toBeVisible();
    await expect(main(page)).toContainText('原来源的作者摘要在桌面重启后仍然保留。');
    await main(page).getByLabel('本研究收录备注').fill('用于验证桌面收录后的来源与研究关联。');
    await saved(page);
    await main(page).getByLabel('本研究收录备注').scrollIntoViewIfNeeded();
    const notice = page.getByRole('button', { name: '关闭提示', exact: true });
    if (await notice.isVisible()) await notice.click();
    await mkdir('docs/verification/source-intake', { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: 'docs/verification/source-intake/desktop-source-1440.png' });
    expect(await page.evaluate(() => ({ chatCalls: window.__papertrailSourceTest.chatCalls, pdfCalls: window.__papertrailSourceTest.pdfCalls }))).toEqual({ chatCalls: 0, pdfCalls: 1 });
    await close(application);
    application = undefined;

    session = await launch(directory);
    application = session.application;
    page = session.page;
    page.on('pageerror', error => errors.push(error.message));
    await expect(main(page).getByLabel('本研究收录备注')).toHaveValue('用于验证桌面收录后的来源与研究关联。');
    await expect(main(page)).toContainText('原来源的作者摘要在桌面重启后仍然保留。');
    const restored = await state(page);
    expect(restored.documents[doc.id]).toMatchObject({ hash: expectedHash, pageCount: 3 });
    expect(restored.researches['research-a'].sourceRecords?.[doc.id].discoveries).toHaveLength(1);
    expect(Object.keys(restored.requests)).toHaveLength(0);
    await page.getByRole('button', { name: '阅读全文', exact: true }).click();
    await expect(main(page).locator('canvas').first()).toBeVisible();
    await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    if (application) await close(application).catch(() => application?.process().kill());
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
