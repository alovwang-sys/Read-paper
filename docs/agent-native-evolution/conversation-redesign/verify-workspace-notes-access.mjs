import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const origin = 'http://127.0.0.1:5173';
const url = `${origin}/docs/agent-native-evolution/conversation-redesign/workspace-preview.html`;
const out = fileURLToPath(new URL('./verification/workspace-notes-access/', import.meta.url));
const sourceFiles = ['workspace-preview.html', 'workspace-preview.jsx', 'workspace-preview.css', 'workspace-preview-board.jsx', 'workspace-preview-board.css', 'workspace-conversation-picker.jsx', 'workspace-paper-notes.jsx', 'workspace-notes-panel.jsx', 'workspace-notes-panel.css'];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(new URL(`./${file}`, import.meta.url))).digest('hex')])));
await mkdir(out, { recursive: true });
const report = { date: new Date().toISOString(), url, scope: '隔离笔记集合访问预览；合成PDF内容与定时回答，不接正式产品或真实模型', checks: [], errors: [], blockedRequests: [], screenshots: [], measurements: {} };
report.sourceHashes = await hashes();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/*', route => {
  const request = new URL(route.request().url());
  if (request.origin === origin && !request.pathname.startsWith('/api/')) return route.continue();
  report.blockedRequests.push(request.href);
  return route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(5000);
page.on('pageerror', error => report.errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && /ResizeObserver/i.test(message.text())) report.errors.push(message.text()); });
const first = () => page.locator('.resource-pane').first();
const panel = () => page.getByRole('dialog', { name: '卡片与摘录', exact: true });
const surface = () => page.locator('.workspace-notes-panel');
const editor = () => page.getByRole('dialog', { name: '卡片编辑', exact: true });
const rows = () => panel().locator('.reader-note');
const entry = () => page.getByRole('button', { name: '卡片与摘录', exact: true });
const reset = async (width = 1440, height = 900) => {
  await page.setViewportSize({ width, height });
  await page.goto(url);
  await expect(page.getByRole('tab', { name: '样例论文A', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '样例论文A', exact: true }).click();
};
const shot = async name => {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  report.screenshots.push(`${name}.png`);
};
const hitTarget = async locator => {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox(), viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await locator.evaluate(node => { const r = node.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return target === node || node.contains(target); })).toBe(true);
};
const selectText = async (scope, text = '比较两种检索策略时') => {
  const paragraph = scope.locator('.paper-copy p').first();
  await paragraph.scrollIntoViewIfNeeded();
  const box = await paragraph.boundingBox();
  await page.mouse.click(box.x + box.width - 2, box.y + box.height - 1);
  const points = await paragraph.evaluate((element, needle) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.textContent.indexOf(needle);
      if (start < 0) continue;
      const a = document.createRange(), b = document.createRange();
      a.setStart(node, start); a.setEnd(node, start + 1);
      b.setStart(node, start + needle.length - 1); b.setEnd(node, start + needle.length);
      const first = a.getBoundingClientRect(), last = b.getBoundingClientRect();
      return { x1: first.x + .2, y1: first.y + first.height / 2, x2: last.right - .2, y2: last.y + last.height / 2 };
    }
    throw new Error('待选原文不存在');
  }, text);
  await page.mouse.move(points.x1, points.y1);
  await page.mouse.down();
  await page.mouse.move(points.x2, points.y2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection().toString().trim())).toBe(text);
  await expect(page.getByRole('dialog', { name: '选区操作', exact: true })).toBeVisible();
};
const openNotes = async () => {
  if (!await panel().count()) await entry().click();
  await expect(panel()).toBeVisible();
};
const closeNotes = () => panel().getByRole('button', { name: '关闭卡片与摘录', exact: true }).click();
const geometry = async stage => {
  const box = await surface().boundingBox(), main = await page.locator('.main').boundingBox(), chat = await page.locator('.chat-side').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(main.x);
  expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height);
  if (chat) expect(box.x + box.width).toBeLessThanOrEqual(chat.x);
  await expect(surface()).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveCount(1);
  await hitTarget(page.getByRole('textbox', { name: '输入消息', exact: true }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  report.measurements[stage] = { box, main, chat };
};
const saveExcerpt = async (scope = first()) => {
  await selectText(scope);
  await page.getByRole('dialog', { name: '选区操作', exact: true }).getByRole('button', { name: '更多选区操作', exact: true }).click();
  const button = page.getByRole('menuitem', { name: '保存摘录', exact: true });
  const scroll = await scope.locator('.paper-scroll').evaluate(node => node.scrollTop);
  await button.click();
  expect(await scope.locator('.paper-scroll').evaluate(node => node.scrollTop)).toBe(scroll);
  return scroll;
};
const viewSaved = () => page.getByRole('status').getByRole('button', { name: '查看', exact: true }).click();
const createCard = async (title, body) => {
  await page.getByRole('dialog', { name: '选区操作', exact: true }).getByRole('button', { name: '更多选区操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '制作卡片', exact: true }).click();
  await editor().getByRole('textbox', { name: '卡片标题', exact: true }).fill(title);
  await editor().getByRole('textbox', { name: '卡片正文', exact: true }).fill(body);
  await editor().getByRole('button', { name: '保存卡片', exact: true }).click();
};
const check = async (name, run) => {
  try { await run(); report.checks.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, pass: false, error: error.message }); await shot(`failure-${report.checks.length}`); console.log(`FAIL ${name}: ${error.message}`); }
};

const cases = [
  ['三尺寸集合/编辑共用一容器，不覆盖侧聊；键盘入口与正文可命中', async () => {
    for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
      await reset(width, height);
      await saveExcerpt();
      await expect(surface()).toBeHidden();
      await viewSaved();
      await expect(rows()).toHaveCount(1);
      await geometry(`collection-${width}`);
      await expect(panel()).not.toHaveAttribute('aria-modal', 'true');
      await hitTarget(panel().getByRole('textbox', { name: '搜索笔记', exact: true }));
      await rows().getByRole('button', { name: '写成卡片', exact: true }).focus();
      await page.keyboard.press('Enter');
      await editor().getByRole('textbox', { name: '卡片标题', exact: true }).fill('先核对检索条件');
      await editor().getByRole('textbox', { name: '卡片正文', exact: true }).fill('年份、数据库与去重方式保持一致，再比较召回。');
      await geometry(`editor-${width}`);
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await hitTarget(editor().getByRole('button', { name: '保存卡片', exact: true }));
      if (width === 1280) await shot('notes-editor-1280');
      await editor().getByRole('button', { name: '保存卡片', exact: true }).click();
      await expect(rows()).toHaveCount(2);
      if (width === 1440) await shot('notes-collection-1440');
      if (width === 1024) await shot('notes-collection-1024');
    }
  }],
  ['顶栏随时访问，不在PDF底部堆列表；空/搜索/显式范围关闭再开保留', async () => {
    await reset();
    await expect(page.locator('.paper-scroll .reader-notes,.paper-scroll .reader-note')).toHaveCount(0);
    await entry().focus(); await page.keyboard.press('Enter');
    await expect(panel()).toContainText('选中原文，保存摘录或制作卡片');
    await expect(panel().getByRole('button', { name: '本研究', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await panel().getByRole('textbox', { name: '搜索笔记', exact: true }).fill('不会匹配');
    await expect(panel()).toContainText('没有找到匹配的笔记');
    await panel().getByRole('button', { name: '本篇：样例论文A', exact: true }).click();
    await closeNotes(); await openNotes();
    await expect(panel().getByRole('textbox', { name: '搜索笔记', exact: true })).toHaveValue('不会匹配');
    await expect(panel().getByRole('button', { name: '本篇：样例论文A', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await panel().getByRole('button', { name: '清空搜索', exact: true }).first().click();
    await expect(panel()).toContainText('选中原文，保存摘录或制作卡片');
    await closeNotes();
    for (const name of ['研究白板', '研究笔记']) {
      await page.getByRole('tab', { name, exact: true }).click();
      await hitTarget(entry()); await openNotes(); await closeNotes();
    }
    await page.getByRole('button', { name: '展开完整对话', exact: true }).click();
    await hitTarget(entry()); await openNotes(); await closeNotes();
    await page.locator('.sidebar-bottom').getByRole('button', { name: '全局资料库', exact: true }).click();
    await expect(entry()).toHaveCount(0);
    await expect(surface()).toBeHidden();
  }],
  ['长集合独立滚动，关闭重开保留范围/查询/滚动，不改变PDF非零位置', async () => {
    await reset(1280, 540);
    for (let i = 0; i < 8; i++) {
      if (i) await first().getByRole('button', { name: '下一页', exact: true }).click();
      await saveExcerpt();
    }
    const paper = first().locator('.paper-scroll'), paperBox = await paper.boundingBox();
    await page.mouse.move(paperBox.x + paperBox.width / 4, paperBox.y + paperBox.height / 2);
    await page.mouse.wheel(0, 180);
    await expect.poll(() => paper.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    const pdfScroll = await first().locator('.paper-scroll').evaluate(node => node.scrollTop);
    expect(pdfScroll).toBeGreaterThan(0);
    await openNotes();
    await panel().getByRole('button', { name: '本篇：样例论文A', exact: true }).click();
    await panel().getByRole('textbox', { name: '搜索笔记', exact: true }).fill('比较');
    await expect(rows()).toHaveCount(8);
    const list = panel().locator('.notes-panel-list'), box = await list.boundingBox();
    expect(await list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 420);
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    const noteScroll = await list.evaluate(node => node.scrollTop);
    expect(await first().locator('.paper-scroll').evaluate(node => node.scrollTop)).toBe(pdfScroll);
    await closeNotes(); await openNotes();
    await expect(panel().getByRole('textbox', { name: '搜索笔记', exact: true })).toHaveValue('比较');
    await expect(panel().getByRole('button', { name: '本篇：样例论文A', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await list.evaluate(node => node.scrollTop)).toBe(noteScroll);
    expect(await first().locator('.paper-scroll').evaluate(node => node.scrollTop)).toBe(pdfScroll);
    report.measurements.independentScroll = { viewport: '1280x540', pdfScroll, noteScroll };
  }],
  ['保存不自动开集合；查看清空过滤/切研究/标记新行，一步找到长列表新项', async () => {
    await reset();
    for (let i = 0; i < 8; i++) { if (i) await first().getByRole('button', { name: '下一页', exact: true }).click(); await saveExcerpt(); }
    await openNotes();
    await panel().getByRole('button', { name: '本篇：样例论文A', exact: true }).click();
    await panel().getByRole('textbox', { name: '搜索笔记', exact: true }).fill('暂时没有匹配');
    await closeNotes();
    await first().getByRole('button', { name: '下一页', exact: true }).click();
    const pdfScroll = await saveExcerpt();
    await expect(surface()).toBeHidden();
    await viewSaved();
    await expect(panel().getByRole('textbox', { name: '搜索笔记', exact: true })).toHaveValue('');
    await expect(panel().getByRole('button', { name: '本研究', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(rows()).toHaveCount(9);
    const focused = panel().locator('.reader-note.note-focused');
    await expect(focused).toHaveCount(1);
    await expect(focused).toHaveAttribute('data-page-index', '19');
    const item = await focused.boundingBox(), list = await panel().locator('.notes-panel-list').boundingBox();
    expect(item.y).toBeGreaterThanOrEqual(list.y);
    expect(item.y + item.height).toBeLessThanOrEqual(list.y + list.height + 1);
    expect(await first().locator('.paper-scroll').evaluate(node => node.scrollTop)).toBe(pdfScroll);
    await shot('notes-saved-view-long-list');
  }],
  ['不同摘录/已存卡片草稿逐条隔离，同一项恢复同稿，引用与正文独立', async () => {
    await reset(); await saveExcerpt();
    await first().getByRole('button', { name: '下一页', exact: true }).click(); await saveExcerpt();
    await openNotes();
    const a = () => panel().locator('.reader-note[data-note-kind="excerpt"][data-page-index="11"]');
    const b = () => panel().locator('.reader-note[data-note-kind="excerpt"][data-page-index="12"]');
    await a().getByRole('button', { name: '写成卡片', exact: true }).click();
    await editor().getByRole('textbox', { name: '卡片标题', exact: true }).fill('草稿A');
    await editor().getByRole('textbox', { name: '卡片正文', exact: true }).fill('A 独立推理');
    await editor().getByRole('button', { name: '关闭卡片编辑', exact: true }).click();
    await b().getByRole('button', { name: '写成卡片', exact: true }).click();
    await expect(editor().getByRole('textbox', { name: '卡片正文', exact: true })).toHaveValue('');
    await editor().getByRole('textbox', { name: '卡片标题', exact: true }).fill('草稿B');
    await editor().getByRole('textbox', { name: '卡片正文', exact: true }).fill('B 独立推理');
    await editor().getByRole('button', { name: '稍后继续', exact: true }).click();
    await expect(panel().locator('[aria-label="未保存草稿"]')).toHaveCount(2);
    await closeNotes();
    await page.getByRole('tab', { name: '研究白板', exact: true }).click();
    await page.getByRole('tab', { name: '样例论文A', exact: true }).click();
    await openNotes();
    await expect(panel().locator('[aria-label="未保存草稿"]')).toHaveCount(2);
    await a().getByRole('button', { name: '继续草稿', exact: true }).click();
    await expect(editor().getByRole('textbox', { name: '卡片正文', exact: true })).toHaveValue('A 独立推理');
    await editor().getByRole('button', { name: '保存卡片', exact: true }).click();
    const card = () => panel().locator('.reader-note[data-note-kind="card"]');
    const evidenceId = await a().getAttribute('data-evidence-id');
    await expect(card()).toHaveAttribute('data-evidence-id', evidenceId);
    await card().locator('.note-card-body').click();
    await editor().getByRole('textbox', { name: '卡片正文', exact: true }).fill('A 已存卡片的未保存修订');
    await page.keyboard.press('Escape');
    await b().getByRole('button', { name: '继续草稿', exact: true }).click();
    await expect(editor().getByRole('textbox', { name: '卡片正文', exact: true })).toHaveValue('B 独立推理');
    await editor().getByRole('button', { name: '稍后继续', exact: true }).click();
    await card().locator('.note-card-body').click();
    await expect(editor().getByRole('textbox', { name: '卡片正文', exact: true })).toHaveValue('A 已存卡片的未保存修订');
    await expect(editor().locator('.card-evidence blockquote')).toHaveText('比较两种检索策略时');
  }],
  ['关闭PDF后由卡片来源新开准确阅读页，保留未保存修订且不创建会话', async () => {
    await reset(); await selectText(first()); await createCard('来源关联卡片', '已保存的判断');
    await expect(surface()).toBeHidden(); await viewSaved(); await closeNotes();
    const count = await page.locator('.sidebar nav button').count();
    await first().getByRole('button', { name: '关闭样例论文A标签', exact: true }).click();
    await expect(page.getByRole('tab', { name: '样例论文A', exact: true })).toHaveCount(0);
    await openNotes(); await panel().locator('.note-card-body').click();
    await editor().getByRole('textbox', { name: '卡片正文', exact: true }).fill('跳原文前的未保存修改');
    await editor().locator('.card-source-link').click();
    await expect(surface()).toBeHidden();
    await expect(page.getByRole('tab', { name: '样例论文A', exact: true })).toHaveCount(1);
    await expect(first().locator('.paper-controls')).toContainText('第 12 / 20 页');
    await expect.poll(() => page.evaluate(() => getSelection().toString().trim())).toBe('比较两种检索策略时');
    await openNotes(); await panel().locator('.note-card-body').click();
    await expect(editor().getByRole('textbox', { name: '卡片正文', exact: true })).toHaveValue('跳原文前的未保存修改');
    expect(await page.locator('.sidebar nav button').count()).toBe(count);
    await expect(page.locator('.message')).toHaveCount(2);
  }],
  ['双组来源优先当前PDF再复用另一组，不重排标签/误改另一页，jump只消费一次', async () => {
    await reset(); await saveExcerpt();
    await first().getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByRole('button', { name: '分屏', exact: true }).click();
    const second = page.locator('.resource-pane').last();
    await second.getByRole('button', { name: '下一页', exact: true }).click();
    await second.getByRole('button', { name: '下一页', exact: true }).click();
    const tree = await page.locator('.resource-pane').evaluateAll(panes => panes.map(p => ({ id: p.dataset.groupId, views: [...p.querySelectorAll('.resource-tab')].map(t => t.dataset.viewId) })));
    await openNotes(); await panel().locator('.note-source').click();
    await expect(second.locator('.paper-controls')).toContainText('第 12 / 20 页');
    await expect(first().locator('.paper-controls')).toContainText('第 13 / 20 页');
    expect(await page.locator('.resource-pane').evaluateAll(panes => panes.map(p => ({ id: p.dataset.groupId, views: [...p.querySelectorAll('.resource-tab')].map(t => t.dataset.viewId) })))).toEqual(tree);
    await second.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(second.locator('.paper-controls')).toContainText('第 13 / 20 页');
    await page.locator('.sidebar-bottom').getByRole('button', { name: '研究笔记', exact: true }).click();
    await second.getByRole('button', { name: '关闭样例论文A标签', exact: true }).click();
    await openNotes(); await panel().locator('.note-source').click();
    await expect(page.locator('.resource-pane')).toHaveCount(2);
    await expect(first().locator('.paper-controls')).toContainText('第 12 / 20 页');
    await expect(second.getByRole('tab', { name: '研究笔记', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: '样例论文A', exact: true })).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => getSelection().toString().trim())).toBe('比较两种检索策略时');
    const beforeResize = await page.locator('.resource-pane').evaluateAll(panes => panes.map(p => ({ id: p.dataset.groupId, views: [...p.querySelectorAll('.resource-tab')].map(t => t.dataset.viewId) })));
    await page.setViewportSize({ width: 1024, height: 800 });
    await openNotes(); await geometry('two-groups-1024');
    expect(await page.locator('.resource-pane').evaluateAll(panes => panes.map(p => ({ id: p.dataset.groupId, views: [...p.querySelectorAll('.resource-tab')].map(t => t.dataset.viewId) })))).toEqual(beforeResize);
  }],
  ['集合操作不改A/B输入，在途A迟到仍只归A并显示未读，不抢集合/资源', async () => {
    await reset(); await saveExcerpt();
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('A 在途查询');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await openNotes();
    await page.locator('.sidebar nav button').filter({ hasText: '补查证据' }).click();
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('B 的未发送内容');
    await panel().getByRole('textbox', { name: '搜索笔记', exact: true }).fill('比较');
    await page.waitForTimeout(1600);
    await expect(panel()).toBeVisible();
    await expect(page.locator('.chat-head strong')).toHaveText('补查证据');
    await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('B 的未发送内容');
    await expect(page.locator('.message')).toHaveCount(0);
    await expect(page.locator('.sidebar nav button').filter({ hasText: '比较检索条件' }).locator('i')).toHaveCount(1);
    await expect(first().locator('.paper-controls')).toContainText('第 12 / 20 页');
    await closeNotes();
    await page.locator('.sidebar nav button').filter({ hasText: '比较检索条件' }).click();
    await expect(page.locator('.message.assistant').last()).toContainText('示例回答');
    await page.locator('.sidebar nav button').filter({ hasText: '补查证据' }).click();
    await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('B 的未发送内容');
  }],
  ['notesForScope覆盖不同文献/无来源卡片/搜索，真实UI仅样例A', async () => {
    await reset();
    const result = await page.evaluate(async () => {
      const { notesForScope } = await import('/docs/agent-native-evolution/conversation-redesign/workspace-notes-panel.jsx');
      const excerpts = [{ id: 'e1', documentId: 'a', documentTitle: 'Paper A', quote: 'alpha source', createdAt: 1 }, { id: 'e2', documentId: 'b', documentTitle: 'Paper B', quote: 'other source', createdAt: 2 }];
      const cards = [{ id: 'c3', evidenceId: 'e1', title: 'Result', body: 'Beta analysis', createdAt: 3 }, { id: 'c4', evidenceId: 'missing', title: 'Orphan', body: 'No evidence', createdAt: 4 }];
      const ids = (...args) => notesForScope(...args).map(row => row.id);
      return { research: ids(excerpts, cards, 'research', 'a'), docA: ids(excerpts, cards, 'document', 'a'), docB: ids(excerpts, cards, 'document', 'b'), bodySearch: ids(excerpts, cards, 'research', 'a', 'BETA'), sourceSearch: ids(excerpts, cards, 'research', 'a', 'Paper B'), orphan: notesForScope(excerpts, cards, 'research', 'a', 'Orphan')[0].source };
    });
    expect(result.research).toEqual(['c4', 'c3', 'e2', 'e1']);
    expect(result.docA).toEqual(['c3', 'e1']); expect(result.docB).toEqual(['e2']);
    expect(result.bodySearch).toEqual(['c3']); expect(result.sourceSearch).toEqual(['e2']);
    expect(result.orphan).toBeNull(); report.measurements.scopeHelper = result;
  }],
];
try {
  for (const [name, run] of cases) await check(name, run);
} finally {
  report.summary = { total: report.checks.length, passed: report.checks.filter(item => item.pass).length, failed: report.checks.filter(item => !item.pass).length };
  report.status = report.checks.length ? 'tested' : 'pending-ui-contract';
  report.endSourceHashes = await hashes();
  report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(report.endSourceHashes);
  await writeFile(path.join(out, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  console.log(JSON.stringify({ ...report.summary, status: report.status, sourceStable: report.sourceStable }));
  if (!report.checks.length || report.summary.failed || report.errors.length || report.blockedRequests.length || !report.sourceStable) process.exitCode = 1;
}
