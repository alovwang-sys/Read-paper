import { expect, test, type Page } from '@playwright/test';
import type { WorkspaceData } from '../../src/domain/types';
import { mkdir } from 'node:fs/promises';

async function readData(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const journal =
      localStorage.getItem('papertrail-recovery-v3') ??
      localStorage.getItem('papertrail-recovery-v1');
    if (journal) return JSON.parse(journal);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('papertrail', 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const snapshot = await new Promise<WorkspaceData>((resolve, reject) => {
      const read = db
        .transaction('workspace')
        .objectStore('workspace')
        .get('current');
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    db.close();
    return snapshot;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '检索增强，何时有效？', exact: true }),
  ).toBeVisible();
});

test('保存失败后关闭资源、切换研究、切换面板和刷新恢复编辑缓冲', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: '相关性是检索收益的前提', exact: false })
    .last()
    .click();
  await expect(page.getByLabel('卡片正文')).toBeVisible();
  await page.evaluate(() => {
    const prototype = IDBObjectStore.prototype;
    const original = prototype.put;
    (window as unknown as { restoreWrites: () => void }).restoreWrites = () => {
      prototype.put = original;
    };
    prototype.put = function (...args) {
      if (this.name === 'workspace')
        throw new DOMException('E2E quota exhausted', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await page.getByLabel('卡片正文').fill('保存失败后，这段观点仍必须恢复。');
  await expect(page.getByTestId('save-status')).toHaveAttribute(
    'data-status',
    'error',
  );
  await page
    .getByRole('complementary', { name: '参考面板' })
    .getByRole('button', { name: '在当前窗格打开', exact: true })
    .click();
  await page
    .getByRole('button', { name: '关闭标签 相关性是检索收益的前提', exact: true })
    .click();
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await page.getByLabel('切换研究').selectOption('research-b');
  await page.getByLabel('切换研究').selectOption('research-a');
  await page.getByRole('tab', { name: '卡片', exact: true }).click();
  await expect(page.getByLabel('卡片正文')).toHaveValue(
    '保存失败后，这段观点仍必须恢复。',
  );
  await mkdir('docs/verification/screenshots', { recursive: true });
  await page.screenshot({
    path: 'docs/verification/screenshots/save-error.png',
  });
  await page.reload();
  await expect(page.getByLabel('卡片正文')).toHaveValue(
    '保存失败后，这段观点仍必须恢复。',
  );
  await expect(page.getByTestId('save-status')).toHaveAttribute(
    'data-status',
    'saved',
  );
});

test('不支持的存储版本加载失败后不覆盖已有数据', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(page.getByTestId('save-status')).toHaveAttribute(
    'data-status',
    'saved',
  );
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('papertrail', 1);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('workspace', 'readwrite');
        tx.objectStore('workspace').put(
          { schemaVersion: 999, originalUserData: 'must survive' },
          'current',
        );
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    localStorage.removeItem('papertrail-recovery-v1');
    localStorage.removeItem('papertrail-recovery-v3');
    localStorage.removeItem('papertrail-recovery-v2');
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '本地资料暂时无法加载' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '新建研究', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '重试加载' }).click();
  await expect(
    page.getByRole('heading', { name: '本地资料暂时无法加载' }),
  ).toBeVisible();
  const saved = await page.evaluate(
    () =>
      new Promise<unknown>((resolve) => {
        const open = indexedDB.open('papertrail', 1);
        open.onsuccess = () => {
          const db = open.result;
          const get = db
            .transaction('workspace')
            .objectStore('workspace')
            .get('current');
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
        };
      }),
  );
  expect(saved).toEqual({
    schemaVersion: 999,
    originalUserData: 'must survive',
  });
  expect(pageErrors).toEqual([]);
});

test('1024px 导航抽屉、右侧关闭、键盘搜索均可操作', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(
    page.locator('.sidebar'),
  ).toBeHidden();
  await page.getByRole('button', { name: '关闭右侧面板' }).click();
  await page.getByRole('button', { name: '展开左栏' }).click();
  await expect(
    page.locator('.sidebar'),
  ).toBeVisible();
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(
    page.getByRole('heading', { name: '资料库', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('dialog', { name: '全局搜索' })).toBeVisible();
  await page.getByLabel('搜索全部资料').fill('不存在的关键词');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('文本提取失败保留阅读能力，AI 请求失败可重试且不覆盖正文', async ({
  page,
}) => {
  let attempts = 0;
  await page.route('**/api/ai/config', route => route.fulfill({ json: {
    configured: true, model: 'test-retry', images: false,
  } }));
  await page.route('**/api/ai/chat', route => {
    attempts++;
    return route.fulfill({
      status: attempts === 1 ? 503 : 200,
      contentType: 'application/x-ndjson',
      body: attempts === 1
        ? `${JSON.stringify({ type: 'error', error: '测试适配器：请求暂时不可用' })}\n`
        : `${JSON.stringify({ type: 'delta', text: '确定性测试回答，未调用真实模型。 [1]' })}\n${JSON.stringify({ type: 'done', model: 'test-retry' })}\n`,
    });
  });
  await page.evaluate(async () => {
    const storePath = '/src/services/workspace.ts',
      pdfPath = '/src/services/pdf.ts';
    const { workspace } = await import(storePath),
      { loadPdfDocument } = await import(pdfPath);
    const { pdf } = await loadPdfDocument(
      workspace.getState().data.documents['paper-a'],
    );
    const firstPage = await pdf.getPage(1),
      prototype = Object.getPrototypeOf(firstPage),
      original = prototype.getTextContent;
    (
      window as unknown as { restoreTextExtraction: () => void }
    ).restoreTextExtraction = () => {
      prototype.getTextContent = original;
    };
    prototype.getTextContent = async () => {
      throw new Error('E2E extraction failure');
    };
  });
  await page
    .getByRole('main')
    .getByRole('button', { name: 'Adaptive Retrieval: Evidence & Reliability', exact: true })
    .click();
  await expect(
    page.getByRole('main').getByText('文本提取失败', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('main').locator('canvas').first()).toBeVisible();
  await expect(
    page.getByRole('main').getByText('阅读就绪', { exact: true }),
  ).toBeVisible();
  await mkdir('docs/verification/screenshots', { recursive: true });
  await page.screenshot({
    path: 'docs/verification/screenshots/text-extraction-error.png',
  });
  await page.evaluate(() =>
    (
      window as unknown as { restoreTextExtraction: () => void }
    ).restoreTextExtraction(),
  );
  await page.getByRole('button', { name: '重试文本提取' }).click();
  await expect(page.getByRole('main')).toContainText('文本已就绪');
  await page.getByRole('tab', { name: '摘录', exact: true }).click();
  await page
    .locator('[data-evidence-id="evidence-a"]')
    .getByRole('button', { name: '加入 AI', exact: true })
    .click();
  await page.getByLabel('向 AI 提问', { exact: true }).fill('重试这份证据的解释');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '测试适配器：请求暂时不可用' }),
  ).toBeVisible();
  await page.screenshot({
    path: 'docs/verification/screenshots/ai-request-error.png',
  });
  await page.getByRole('button', { name: '按原范围重试', exact: true }).click();
  await expect(page.locator('.ai-answer').last()).toContainText(
    '未调用真实模型',
  );
  const snapshot = await readData(page);
  const retried = Object.values(snapshot.requests).at(-1)!;
  expect(retried).toMatchObject({ mode: 'live', connectionId: 'model', status: 'done' });
  expect(attempts).toBe(2);
  expect(retried.retryOf).toBeTruthy();
  const body = snapshot.drafts['draft-a'].body;
  expect(body).toBe(
    '检索增强的收益依赖证据相关性。无关语料可能增加不确定性，因此评估需要同时报告语料条件与来源可追踪性。',
  );
});

test('未发送的 AI 输入按研究保留，切换面板和刷新后恢复', async ({ page }) => {
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await page.getByLabel('向 AI 提问').fill('研究 A 尚未发送的问题');
  await page.getByRole('tab', { name: '卡片', exact: true }).click();
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(page.getByLabel('向 AI 提问')).toHaveValue(
    '研究 A 尚未发送的问题',
  );
  await page.getByLabel('切换研究').selectOption('research-b');
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(page.getByLabel('向 AI 提问')).not.toHaveValue(
    '研究 A 尚未发送的问题',
  );
  await page.getByLabel('向 AI 提问').fill('研究 B 的另一个问题');
  await page.getByLabel('切换研究').selectOption('research-a');
  await expect(page.getByLabel('向 AI 提问')).toHaveValue(
    '研究 A 尚未发送的问题',
  );
  await expect(page.getByTestId('save-status')).toHaveAttribute(
    'data-status',
    'saved',
  );
  await page.reload();
  await expect(page.getByLabel('向 AI 提问')).toHaveValue(
    '研究 A 尚未发送的问题',
  );
});
