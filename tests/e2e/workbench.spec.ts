import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { WorkspaceData } from '../../src/domain/types';

const screenshots = resolve('docs/verification/screenshots');
const samples = resolve('public/samples');
const quote =
  'Retrieval improves factual accuracy when the evidence corpus is relevant.';
const cardTitle = 'E2E：相关证据改善可靠性';
const cardBody = '检索的收益需要相关证据支持，并应保留可核查的出处。';

async function data(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const journal = localStorage.getItem('papertrail-recovery-v1');
    if (journal) return JSON.parse(journal);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise<WorkspaceData>((resolve, reject) => {
      const request = db
        .transaction('workspace')
        .objectStore('workspace')
        .get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  });
}
async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute(
    'data-status',
    'saved',
  );
}
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) =>
  page.getByRole('complementary', { name: '参考面板' });
const navigation = (page: Page) =>
  page.getByRole('complementary', { name: '左侧导航' });
async function start(page: Page) {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: '新建研究', exact: true }),
  ).toBeVisible();
  await saved(page);
}
async function screenshot(page: Page, name: string) {
  await mkdir(screenshots, { recursive: true });
  await expect(page.locator('.pdf-page-loading')).toHaveCount(0);
  await expect(page.locator('.pdf-loading')).toHaveCount(0);
  await page.locator('.writing-scroll').evaluateAll((elements) =>
    elements.forEach((element) => {
      element.scrollTop = 0;
    }),
  );
  const toastClose = page.locator('.toast button[aria-label="关闭提示"]');
  if (await toastClose.isVisible()) await toastClose.click();
  await saved(page);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: resolve(screenshots, `${name}.png`),
    fullPage: false,
  });
}
async function createResearch(page: Page, title: string, question: string) {
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  await page.getByLabel('研究名称', { exact: true }).fill(title);
  await page.getByLabel('新研究核心问题').fill(question);
  await page.getByRole('button', { name: '创建研究', exact: true }).click();
  await expect(main(page).getByRole('heading', { name: title })).toBeVisible();
  const state = await data(page);
  return state.scope.kind === 'research' ? state.scope.researchId : '';
}
async function importSample(page: Page, filename: string) {
  await expect(
    page.getByRole('button', { name: '导入 PDF', exact: true }).first(),
  ).toBeEnabled();
  await page
    .getByLabel('选择 PDF 文件')
    .first()
    .setInputFiles(resolve(samples, filename));
  await expect
    .poll(async () => {
      const state = await data(page),
        active =
          state.sessions[
            state.scope.kind === 'research' ? state.scope.researchId : 'library'
          ].active;
      return active.kind === 'document'
        ? state.documents[active.id].filename
        : active.kind;
    })
    .toBe(filename);
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: '导入 PDF', exact: true }).first(),
  ).toBeEnabled();
}
async function selectText(
  page: Page,
  target: string,
  root: Locator = main(page),
) {
  const layer = root.locator('.pdf-text-layer').first();
  await expect(layer).toContainText(target.slice(0, 28));
  await layer.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let current: Node | null;
    while ((current = walker.nextNode())) nodes.push(current as Text);
    const combined = nodes.map((node) => node.textContent).join('');
    const positions: number[] = [];
    for (let index = 0; index < combined.length; index++)
      if (!/\s/.test(combined[index])) positions.push(index);
    const compact = positions.map((index) => combined[index]).join('');
    const match = compact.indexOf(text.replace(/\s/g, ''));
    if (match < 0) throw new Error(`Selection target not found: ${text}`);
    const start = positions[match],
      finish = positions[match + text.replace(/\s/g, '').length - 1] + 1;
    let offset = 0;
    const range = document.createRange();
    for (const node of nodes) {
      const end = offset + (node.textContent?.length ?? 0);
      if (start >= offset && start < end) range.setStart(node, start - offset);
      if (finish > offset && finish <= end) {
        range.setEnd(node, finish - offset);
        break;
      }
      offset = end;
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, view: window }),
    );
  }, target);
}
async function setPdfPage(
  page: Page,
  pageNumber: number,
  root: Locator = main(page),
) {
  const input = root.getByRole('spinbutton').first();
  await input.fill(String(pageNumber));
  await input.press('Enter');
}
async function addToBoard(
  page: Page,
  kind: 'card' | 'document',
  title: string,
) {
  await main(page)
    .getByRole('button', { name: '添加资料', exact: true })
    .click();
  if (kind === 'document')
    await main(page)
      .getByRole('button', { name: 'PDF 论文', exact: true })
      .click();
  else
    await main(page)
      .getByRole('button', { name: '观点卡片', exact: true })
      .click();
  await main(page)
    .getByRole('button', { name: `添加到白板：${title}`, exact: true })
    .click();
}
async function openNav(page: Page, name: string) {
  await navigation(page)
    .getByRole('button', { name, exact: true })
    .first()
    .click();
}

test('完整研究路径：导入、真实 PDF 选区、卡片、白板、引用导出与恢复', async ({
  page,
}) => {
  test.setTimeout(120000);
  await start(page);
  const researchId = await createResearch(
    page,
    'E2E 证据研究',
    '何时检索能改善回答可靠性？',
  );
  await screenshot(page, '00-empty-research-1440x900');
  for (const filename of [
    'adaptive-retrieval.pdf',
    'retrieval-baseline.pdf',
    'scanned-note.pdf',
  ])
    await importSample(page, filename);
  let state = await data(page);
  expect(state.researches[researchId].documentIds).toHaveLength(3);
  expect(Object.keys(state.documents)).toHaveLength(3);
  const doc = Object.values(state.documents).find(
    (item) => item.filename === 'adaptive-retrieval.pdf',
  )!;
  await navigation(page)
    .locator('.open-item-link')
    .filter({ hasText: doc.title })
    .click();
  await setPdfPage(page, 3);
  await selectText(page, quote);
  await main(page)
    .getByRole('button', { name: '创建证据卡片', exact: true })
    .click();
  await expect(panel(page).getByLabel('卡片正文')).toBeVisible();
  await panel(page).getByLabel('卡片标题').fill(cardTitle);
  await panel(page).getByLabel('卡片正文').fill(cardBody);
  await expect(main(page).locator('.pdf-text-layer').first()).toContainText(
    quote,
  );
  await expect(
    panel(page).getByText('PDF 第 3 页', { exact: true }),
  ).toBeVisible();
  await screenshot(page, '01-pdf-card-1440x900');
  state = await data(page);
  const card = Object.values(state.cards).find(
    (item) => item.title === cardTitle,
  )!;
  const evidence = state.evidence[card.evidenceIds[0]];
  expect(evidence).toMatchObject({ documentId: doc.id, pageIndex: 2, quote });

  await openNav(page, '证据与论证');
  await addToBoard(page, 'card', cardTitle);
  await addToBoard(page, 'document', doc.title);
  const cardNode = main(page).locator(`[data-resource-id="${card.id}"]`);
  const pdfNode = main(page).locator(`[data-resource-id="${doc.id}"]`);
  await cardNode.click();
  await pdfNode.click({ modifiers: ['Shift'] });
  await main(page).getByLabel('白板分组名称').fill('验证条件');
  await main(page)
    .getByRole('button', { name: '应用分组', exact: true })
    .click();
  await main(page)
    .getByRole('button', { name: '连接卡片', exact: true })
    .click();
  await cardNode.click();
  await pdfNode.click();
  await main(page).getByLabel('连线说明').fill('由原文支持');
  await pdfNode.dblclick();
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '主区返回', exact: true }).click();
  await expect(pdfNode).toBeVisible();
  await cardNode
    .getByRole('button', { name: `查看卡片原文：${cardTitle}` })
    .click();
  await expect(panel(page).locator('.pdf-text-layer').first()).toContainText(
    quote,
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await main(page)
    .locator('.board-viewport')
    .evaluate((element) => {
      element.scrollLeft = 0;
      element.scrollTop = 0;
    });
  await screenshot(page, '02-board-source-1280x800');
  await page.setViewportSize({ width: 1440, height: 900 });

  await openNav(page, '结论与导出');
  await main(page).getByLabel('结论标题').fill('E2E 检索增强的适用条件');
  await main(page).getByLabel('结论正文').fill('研究结论需要保留条件与出处。');
  await main(page)
    .getByRole('button', { name: '插入卡片引用', exact: true })
    .click();
  await main(page)
    .getByRole('button', { name: `插入引用：${cardTitle}`, exact: true })
    .click();
  await expect(main(page).getByLabel('结论正文')).toHaveValue(
    new RegExp(`${cardBody}.*\\[1\\]`),
  );
  await main(page)
    .getByRole('button', { name: '查看原文', exact: true })
    .click();
  await expect(panel(page).locator('.pdf-text-layer').first()).toContainText(
    quote,
  );
  const downloadEvent = page.waitForEvent('download');
  await main(page)
    .getByRole('button', { name: '导出 Markdown', exact: true })
    .click();
  const download = await downloadEvent;
  const exportPath = resolve('docs/verification/e2e-research-note.md');
  await download.saveAs(exportPath);
  const markdown = await readFile(exportPath, 'utf8');
  expect(markdown).toContain('# E2E 检索增强的适用条件');
  expect(markdown).toContain('何时检索能改善回答可靠性？');
  expect(markdown).toContain(cardBody);
  expect(markdown).toContain('PDF 第 3 页');
  expect(markdown).toContain(quote);
  expect(markdown).toContain(doc.authors);
  expect(markdown).toContain(doc.filename);
  expect(markdown).toContain('未附带原始 PDF');
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await screenshot(page, '03-writing-ai-1440x900');
  await page.setViewportSize({ width: 1024, height: 800 });
  await screenshot(page, '04-writing-ai-1024x800');
  await page.setViewportSize({ width: 1440, height: 900 });
  await saved(page);
  await page.getByLabel('切换研究').selectOption('research-b');
  await expect(
    main(page).getByRole('heading', { name: '长文本阅读方法' }),
  ).toBeVisible();
  await page.getByLabel('切换研究').selectOption(researchId);
  await expect(main(page).getByLabel('结论标题')).toHaveValue(
    'E2E 检索增强的适用条件',
  );
  await saved(page);
  await page.reload();
  await expect(main(page).getByLabel('结论正文')).toHaveValue(
    new RegExp(cardBody),
  );
  await expect(
    panel(page).getByRole('tab', { name: 'AI', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  state = await data(page);
  expect(state.researches[researchId].cardIds).toContain(card.id);
  expect(state.evidence[evidence.id].quote).toBe(quote);
  const boardId = Object.values(state.boards).find(
    (item) => item.researchId === researchId,
  )!.id;
  const placements = Object.values(state.placements).filter(
    (item) => item.boardId === boardId,
  );
  expect(placements).toHaveLength(2);
  expect(placements.every((item) => item.group === '验证条件')).toBe(true);
  expect(
    Object.values(state.edges).find((item) => item.boardId === boardId)?.label,
  ).toBe('由原文支持');
  expect(state.sessions[researchId].readers[`main:${doc.id}`].pageIndex).toBe(
    2,
  );
  await navigation(page)
    .locator('.open-item-link')
    .filter({ hasText: doc.title })
    .click();
  await expect(main(page).locator('.pdf-text-layer').first()).toContainText(
    quote,
  );
  await page.getByRole('button', { name: '主区返回', exact: true }).click();
  await expect(main(page).getByLabel('结论正文')).toHaveValue(
    new RegExp(cardBody),
  );
});

test('共享卡片、摆放实例移出撤销、移动和白板视口持久化', async ({ page }) => {
  await start(page);
  await openNav(page, '证据与论证');
  const node = main(page).locator('[data-placement-id="placement-a"]');
  await node.click();
  await panel(page)
    .getByLabel('卡片正文')
    .fill('两个白板都应显示这份共享正文。');
  await expect(node).toContainText('两个白板都应显示这份共享正文。');
  await openNav(page, '条件与限制');
  await expect(
    main(page).locator('[data-placement-id="placement-a2"]'),
  ).toContainText('两个白板都应显示这份共享正文。');
  await openNav(page, '证据与论证');
  const handle = node.locator('.board-node-header');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 45, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 145, box.y + 78, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await data(page)).placements['placement-a'].x)
    .toBe(155);
  await main(page)
    .getByRole('button', { name: '缩小白板', exact: true })
    .click();
  await main(page)
    .locator('.board-viewport')
    .evaluate((element) => {
      element.scrollLeft = 220;
      element.scrollTop = 180;
    });
  await saved(page);
  const before = (await data(page)).sessions['research-a'].viewports['board-a'];
  await openNav(page, '条件与限制');
  await openNav(page, '证据与论证');
  await expect
    .poll(async () =>
      main(page)
        .locator('.board-viewport')
        .evaluate((element) => ({
          x: element.scrollLeft,
          y: element.scrollTop,
        })),
    )
    .toEqual({ x: before.x, y: before.y });
  await saved(page);
  await page.reload();
  await expect(
    main(page).getByRole('button', { name: '重置白板缩放' }),
  ).toHaveText('90%');
  expect((await data(page)).placements['placement-a']).toMatchObject({
    x: 155,
    y: 160,
  });
  await main(page).getByRole('button', { name: '重置白板缩放' }).click();
  await main(page)
    .locator('.board-viewport')
    .evaluate((element) => {
      element.scrollLeft = 0;
      element.scrollTop = 0;
    });
  await node.focus();
  await node.press('Delete');
  await expect(node).toHaveCount(0);
  let state = await data(page);
  expect(state.cards['card-a'].body).toBe('两个白板都应显示这份共享正文。');
  expect(state.placements['placement-a2']).toBeTruthy();
  expect(state.edges['edge-a']).toBeUndefined();
  await main(page).getByRole('button', { name: '撤销移出' }).click();
  await expect(node).toHaveCount(1);
  state = await data(page);
  expect(state.edges['edge-a']).toBeTruthy();
  await node.focus();
  await node.press('Enter');
  await expect(panel(page).getByLabel('卡片正文')).toHaveValue(
    '两个白板都应显示这份共享正文。',
  );
});

test('AI 固定快照、迟到隔离、编辑另存及插入结论编号', async ({ page }) => {
  await start(page);
  const research = await data(page);
  for (const id of ['paper-a', 'paper-b']) {
    await main(page)
      .getByRole('button', { name: new RegExp(research.documents[id].title) })
      .click();
    await expect(main(page).locator('canvas').first()).toBeVisible();
    await openNav(page, '研究概览');
  }
  await panel(page).getByRole('tab', { name: '证据', exact: true }).click();
  for (const id of ['evidence-b', 'evidence-c']) {
    await panel(page)
      .locator(`[data-evidence-id="${id}"]`)
      .getByRole('button', { name: '加入 AI', exact: true })
      .click();
    if (id === 'evidence-b')
      await panel(page).getByRole('tab', { name: '证据', exact: true }).click();
  }
  await expect(panel(page).locator('.context-chip')).toHaveCount(2);
  await panel(page).getByLabel('向 AI 提问').fill('E2E 比较相关性与追溯性');
  await panel(page)
    .getByRole('button', { name: '生成草稿', exact: true })
    .click();
  await expect(
    panel(page).getByText('正在生成演示草稿…', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => Object.keys((await data(page)).requests).length)
    .toBe(1);
  const submitting = await data(page);
  const request = Object.values(submitting.requests)[0];
  expect(request.status).toBe('generating');
  expect(request.context.map((item) => item.evidenceId)).toEqual([
    'evidence-b',
    'evidence-c',
  ]);
  await page.getByLabel('切换研究').selectOption('research-b');
  await expect
    .poll(async () => (await data(page)).requests[request.id].status)
    .toBe('done');
  let state = await data(page);
  expect(state.scope).toEqual({ kind: 'research', researchId: 'research-b' });
  expect(
    state.conversations['conversation-research-b'].requestIds,
  ).toHaveLength(0);
  expect(state.requests[request.id].researchId).toBe('research-a');
  expect(state.requests[request.id].context).toEqual(request.context);
  await page.getByLabel('切换研究').selectOption('research-a');
  await panel(page)
    .getByLabel('AI 草稿')
    .fill('编辑后的比较，第一条来源是限制 [1]，第二条来源是方法 [2]。');
  await panel(page)
    .getByRole('button', { name: '另存卡片', exact: true })
    .click();
  await expect(panel(page).getByLabel('卡片正文')).toHaveValue(
    '编辑后的比较，第一条来源是限制 [1]，第二条来源是方法 [2]。',
  );
  await panel(page).getByLabel('卡片标题').fill('E2E AI 比较卡片');
  await openNav(page, '结论与导出');
  await main(page)
    .getByRole('button', { name: '插入卡片引用', exact: true })
    .click();
  await main(page)
    .getByRole('button', { name: '插入引用：E2E AI 比较卡片', exact: true })
    .click();
  await expect(main(page).getByLabel('结论正文')).toHaveValue(
    /第一条来源是限制 \[2\]，第二条来源是方法 \[3\]/,
  );
  state = await data(page);
  expect(state.drafts['draft-a'].evidenceIds).toEqual([
    'evidence-a',
    'evidence-b',
    'evidence-c',
  ]);
  expect(state.drafts['draft-b'].body).toBe('');
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await screenshot(page, '05-writing-ai-context-1440x900');
});

test('双栏与扫描边界、损坏 PDF 导入、来源及返回恢复', async ({ page }) => {
  await start(page);
  await main(page)
    .getByRole('button', { name: /Retrieval Baselines/ })
    .click();
  await main(page).getByRole('button', { name: '目录与全文搜索' }).click();
  await main(page)
    .getByLabel('搜索 PDF 全文')
    .fill('Irrelevant sources can leave');
  await main(page)
    .locator('.pdf-search-results')
    .getByRole('button', { name: /PDF 第 2 页/ })
    .click();
  await expect(main(page).getByLabel('PDF 页码')).toHaveValue('2');
  await main(page).getByRole('button', { name: '放大 PDF' }).click();
  await main(page).getByRole('button', { name: '缩小 PDF' }).click();
  await main(page).getByRole('button', { name: '关闭目录与搜索' }).click();
  await saved(page);
  await page.reload();
  await expect(main(page).getByLabel('PDF 页码')).toHaveValue('2');
  await setPdfPage(page, 1);
  await selectText(
    page,
    'A fixed retrieval budget does not guarantee relevant evidence.',
  );
  await expect(
    main(page).getByRole('button', { name: '创建证据卡片', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.getSelection()?.toString().replace(/\s+/g, ' ').trim(),
    ),
  ).toBe('A fixed retrieval budget does not guarantee relevant evidence.');
  await screenshot(page, '06-two-column-selection-1440x900');
  await page.getByRole('button', { name: '主区返回', exact: true }).click();
  await main(page)
    .getByRole('button', { name: /Scanned Research Note/ })
    .click();
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await expect(main(page)).toContainText(/扫描|无文本|没有可选择/);
  expect(await main(page).locator('.pdf-text-layer span').count()).toBe(0);
  await screenshot(page, '07-scanned-pdf-1440x900');
  await page
    .getByLabel('选择 PDF 文件')
    .first()
    .setInputFiles(resolve('tests/fixtures/malformed.pdf'));
  await expect(
    page.getByRole('alert').filter({ hasText: '文件内容不是 PDF' }),
  ).toBeVisible();
  await screenshot(page, '08-pdf-import-error-1440x900');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page
    .getByLabel('选择 PDF 文件')
    .first()
    .setInputFiles({
      name: 'broken-document.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\nBroken xref and missing objects\n%%EOF'),
    });
  await expect(
    page.getByRole('alert').filter({ hasText: 'PDF 无法解析' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await openNav(page, '证据与论证');
  await main(page)
    .locator('[data-placement-id="placement-a"]')
    .getByRole('button', { name: /查看卡片原文/ })
    .click();
  await expect(panel(page).locator('.pdf-text-layer').first()).toContainText(
    quote,
  );
  await panel(page)
    .getByRole('button', { name: '在主区打开 ↗', exact: true })
    .click();
  await expect(main(page).locator('.pdf-text-layer').first()).toContainText(
    quote,
  );
  await page.getByRole('button', { name: '主区返回', exact: true }).click();
  await expect(
    main(page).locator('[data-placement-id="placement-a"]'),
  ).toBeVisible();
  await main(page).locator('[data-placement-id="placement-a"]').click();
  await expect(panel(page).getByLabel('卡片正文')).toBeVisible();
  await panel(page)
    .getByRole('button', { name: '右侧返回', exact: true })
    .click();
  await expect(panel(page).locator('.pdf-text-layer').first()).toContainText(
    quote,
  );
  await panel(page)
    .getByRole('button', { name: '上一页', exact: true })
    .click();
  await expect(panel(page).getByLabel('PDF 页码')).toHaveValue('2');
  await saved(page);
  await page.reload();
  await expect(panel(page).getByLabel('PDF 页码')).toHaveValue('2');
  await expect(
    main(page).locator('[data-placement-id="placement-a"]'),
  ).toBeVisible();
});

test('原 PDF 资产缺失后同 hash 重导入修复，保留文档与证据身份', async ({
  page,
}) => {
  await start(page);
  const pdf = await PDFDocument.load(
    await readFile(resolve(samples, 'adaptive-retrieval.pdf')),
  );
  pdf.setTitle('E2E 资产恢复论文');
  const file = {
    name: 'restore-source.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save({ useObjectStreams: false })),
  };
  await page.getByLabel('选择 PDF 文件').first().setInputFiles(file);
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await setPdfPage(page, 3);
  await selectText(page, quote);
  await main(page)
    .getByRole('button', { name: '创建证据卡片', exact: true })
    .click();
  await expect(panel(page).getByLabel('卡片正文')).toBeVisible();
  await saved(page);
  const before = await data(page);
  const doc = Object.values(before.documents).find(
    (item) => item.filename === file.name,
  )!;
  const evidence = Object.values(before.evidence).find(
    (item) => item.documentId === doc.id,
  )!;
  expect(doc.sampleUrl).toBeUndefined();
  await page.evaluate(async (assetId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('assets', 'readwrite');
      transaction.objectStore('assets').delete(assetId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, doc.assetId);
  await page.reload();
  await expect(
    main(page).getByRole('heading', { name: 'PDF 暂时无法打开' }),
  ).toBeVisible();
  await expect(main(page)).toContainText('原 PDF 文件缺失');
  await screenshot(page, '09-missing-source-1440x900');
  await page.getByLabel('选择 PDF 文件').first().setInputFiles(file);
  await expect(main(page).locator('.pdf-text-layer').first()).toContainText(
    quote,
  );
  const after = await data(page);
  expect(Object.keys(after.documents)).toHaveLength(
    Object.keys(before.documents).length,
  );
  expect(after.documents[doc.id]).toMatchObject({
    hash: doc.hash,
    assetId: doc.assetId,
  });
  expect(after.evidence[evidence.id]).toEqual(evidence);
});

test('延迟 PDF 导入绑定提交研究，切换研究后保持目标工作区', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      await new Promise((resolve) => setTimeout(resolve, 750));
      return original.call(this);
    };
  });
  await start(page);
  const researchId = await createResearch(
    page,
    'E2E 延迟导入研究',
    '导入期间切研究是否保持归属？',
  );
  const pdf = await PDFDocument.load(
    await readFile(resolve(samples, 'retrieval-baseline.pdf')),
  );
  pdf.setTitle('E2E 延迟导入论文');
  await page
    .getByLabel('选择 PDF 文件')
    .first()
    .setInputFiles({
      name: 'delayed-source.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save({ useObjectStreams: false })),
    });
  await page.getByLabel('切换研究').selectOption('research-b');
  await expect
    .poll(async () =>
      Object.values((await data(page)).documents).some(
        (item) => item.filename === 'delayed-source.pdf',
      ),
    )
    .toBe(true);
  const state = await data(page),
    doc = Object.values(state.documents).find(
      (item) => item.filename === 'delayed-source.pdf',
    )!;
  expect(state.scope).toEqual({ kind: 'research', researchId: 'research-b' });
  expect(state.researches[researchId].documentIds).toContain(doc.id);
  expect(state.researches['research-b'].documentIds).not.toContain(doc.id);
  await expect(
    main(page).getByRole('heading', { name: '长文本阅读方法' }),
  ).toBeVisible();
});

test('桌面导航、论文库与窄屏折叠的稳定截图', async ({ page }) => {
  await start(page);
  await screenshot(page, '10-overview-1440x900');
  await page.setViewportSize({ width: 1280, height: 800 });
  await openNav(page, '论文库');
  await screenshot(page, '11-library-1280x800');
  await page.getByRole('button', { name: '收起左栏', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveCount(1);
  await expect(page.locator('.sidebar')).not.toBeVisible();
  await screenshot(page, '12-left-collapsed-1280x800');
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.getByRole('button', { name: '展开左栏', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '新建研究', exact: true }),
  ).toBeVisible();
  await screenshot(page, '13-narrow-navigation-1024x800');
});
