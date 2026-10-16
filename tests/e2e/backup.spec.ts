import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import type { WorkspaceData } from '../../src/domain/types';

async function stored(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = <T,>(store: string, id: string) => new Promise<T>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const current = await read<WorkspaceData>('workspace', 'current');
    const previous = await read<{ data: WorkspaceData; assets: Array<{ id: string; blob: Blob }> } | undefined>('workspace', 'before-backup-restore');
    const assets = await new Promise<Array<{ id: string; blob: Blob }>>((resolve, reject) => {
      const result: Array<{ id: string; blob: Blob }> = [];
      const cursor = db.transaction('assets').objectStore('assets').openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (item) { result.push({ id: String(item.key), blob: item.value }); item.continue(); }
        else resolve(result);
      };
      cursor.onerror = () => reject(cursor.error);
    });
    const hashes = async (files: typeof assets) => Promise.all(files.map(async file => ({ id: file.id, hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('') })));
    const assetHashes = await hashes(assets);
    const previousHashes = previous && await hashes(previous.assets);
    db.close();
    return { current, assetHashes, previous: previous && { data: previous.data, assetHashes: previousHashes } };
  });
}

test('导出、校验预览、明确替换和刷新恢复，原资料与文件留有原子副本', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '检索增强，何时有效？', exact: true })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: /Adaptive Retrieval/ }).click();
  await expect(page.getByRole('main').locator('canvas').first()).toBeVisible();
  await expect(page.getByRole('main')).toContainText('文本已就绪');
  await page.getByRole('button', { name: '主区返回', exact: true }).click();
  await page.getByRole('button', { name: '相关性是检索收益的前提', exact: false }).last().click();
  await page.getByLabel('卡片正文').fill('备份里的原始卡片内容，保留可核查的论文引用。');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.getByRole('button', { name: '存储与设置' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出完整备份' }).click();
  const download = await downloadPromise;
  const backupPath = testInfo.outputPath('workspace.zip');
  await download.saveAs(backupPath);
  const files = unzipSync(new Uint8Array(await readFile(backupPath)));
  const expected = JSON.parse(strFromU8(files['workspace.json'])) as WorkspaceData;
  const expectedHashes = Object.entries(files).filter(([path]) => path.startsWith('assets/')).map(([path, bytes]) => ({ id: path.slice(7), hash: createHash('sha256').update(bytes).digest('hex') })).sort((a, b) => a.id.localeCompare(b.id));
  expect(expectedHashes).toHaveLength(3);
  await page.getByRole('button', { name: '关闭弹层' }).click();
  await page.getByLabel('卡片正文').fill('导出后继续写入的当前内容，替换前必须另存恢复副本。');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  const beforeRestore = await stored(page);
  expect(beforeRestore.assetHashes.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: '存储与设置' }).click();
  await page.getByLabel('选择工作区备份').setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('invalid zip') });
  await expect(page.getByRole('alert')).toContainText('ZIP 目录损坏');
  expect((await stored(page)).current).toEqual(beforeRestore.current);
  expect((await stored(page)).previous).toBeUndefined();
  await page.getByLabel('选择工作区备份').setInputFiles(backupPath);
  const preview = page.getByLabel('备份预览');
  await expect(preview).toContainText('2 个研究 · 3 篇论文 · 3 张卡片 · 3 个文件');
  const restore = page.getByRole('button', { name: '确认替换并恢复' });
  await expect(restore).toBeDisabled();
  expect((await stored(page)).current.cards['card-a'].body).toContain('导出后继续写入');
  await mkdir('docs/verification/desktop', { recursive: true });
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `docs/verification/desktop/backup-preview-${width}.png` });
    const box = await page.getByRole('dialog', { name: '存储与设置' }).boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(height);
  }
  await page.getByRole('checkbox', { name: '我确认用此备份替换当前全部资料' }).check();
  await restore.click();
  await expect(page.getByText('备份恢复完成，全部论文和资料已保存到此设备。')).toBeVisible();
  const afterRestore = await stored(page);
  expect(afterRestore.current).toEqual(expected);
  expect(afterRestore.assetHashes.sort((a, b) => a.id.localeCompare(b.id))).toEqual(expectedHashes);
  expect(afterRestore.previous?.data).toEqual(beforeRestore.current);
  expect(afterRestore.previous?.assetHashes).toEqual(beforeRestore.assetHashes);
  await page.reload();
  await expect(page.getByLabel('卡片正文')).toHaveValue(expected.cards['card-a'].body);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  const refreshed = await stored(page);
  expect(refreshed.current).toEqual(expected);
  expect(refreshed.current.cards['card-a'].evidenceIds).toEqual(['evidence-a']);
  expect(refreshed.current.evidence['evidence-a'].documentId).toBe('paper-a');
  expect(refreshed.previous).toEqual(afterRestore.previous);
});

test('本地保存失败后仍能导出包含最新内存编辑的完整备份', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.getByRole('button', { name: '相关性是检索收益的前提', exact: false }).last().click();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'workspace') throw new DOMException('E2E quota exhausted', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  const latest = '数据库保存失败时，完整备份仍须保留这段最新编辑。';
  await page.getByLabel('卡片正文').fill(latest);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'error');
  await page.getByRole('button', { name: '存储与设置' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出完整备份' }).click();
  const download = await downloadPromise;
  const backupPath = testInfo.outputPath('unsaved-workspace.zip');
  await download.saveAs(backupPath);
  await expect(page.getByText('本地保存未成功，备份包含当前编辑，请确认文件保存成功。')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'error');
  const files = unzipSync(new Uint8Array(await readFile(backupPath)));
  const data = JSON.parse(strFromU8(files['workspace.json'])) as WorkspaceData;
  expect(data.cards['card-a'].body).toBe(latest);
  expect(Object.keys(files).filter(name => name.startsWith('assets/'))).toHaveLength(3);
  expect((await stored(page)).current.cards['card-a'].body).not.toBe(latest);
  await mkdir('docs/verification/desktop', { recursive: true });
  await page.screenshot({ path: 'docs/verification/desktop/backup-save-error.png' });
});
