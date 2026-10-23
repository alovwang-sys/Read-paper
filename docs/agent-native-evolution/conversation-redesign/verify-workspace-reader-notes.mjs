import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const origin = 'http://127.0.0.1:5173';
const url = `${origin}/docs/agent-native-evolution/conversation-redesign/workspace-preview.html`;
const out = fileURLToPath(new URL('./verification/workspace-reader-notes/', import.meta.url));
const sourceFiles = ['workspace-preview.html', 'workspace-preview.jsx', 'workspace-preview.css', 'workspace-preview-board.jsx', 'workspace-preview-board.css', 'workspace-conversation-picker.jsx', 'workspace-paper-notes.jsx'];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(new URL(`./${file}`, import.meta.url))).digest('hex')])));
await mkdir(out, { recursive: true });
const report = { date: new Date().toISOString(), url, scope: '隔离阅读摘录/卡片预览；真实鼠标选择合成原文，不连接真实模型或正式产品', checks: [], errors: [], blockedRequests: [], screenshots: [], measurements: {} };
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
const selectText = async (locator, text) => {
  await locator.scrollIntoViewIfNeeded();
  const paragraph = await locator.boundingBox();
  await page.mouse.click(paragraph.x + paragraph.width - 2, paragraph.y + paragraph.height - 1);
  const points = await locator.evaluate((element, needle) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.textContent.indexOf(needle);
      if (start < 0) continue;
      const first = document.createRange(), last = document.createRange();
      first.setStart(node, start); first.setEnd(node, start + 1);
      last.setStart(node, start + needle.length - 1); last.setEnd(node, start + needle.length);
      const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
      return { start: { x: a.x + .2, y: a.y + a.height / 2 }, end: { x: b.right - .2, y: b.y + b.height / 2 } };
    }
    throw new Error(`原文中找不到待选文字：${needle}`);
  }, text);
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim())).toBe(text);
};
const check = async (name, run) => {
  try { await run(); report.checks.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, pass: false, error: error.message }); await shot(`failure-${report.checks.length}`); console.log(`FAIL ${name}: ${error.message}`); }
};
const excerpt = scope => scope.locator('.reader-note[data-note-kind="excerpt"]');
const cards = scope => scope.locator('.reader-note[data-note-kind="card"]');
const editor = () => page.getByRole('dialog', { name: '卡片编辑', exact: true });
const tools = scope => scope.locator('[aria-label="原文选区操作"]');
const first = () => page.locator('.resource-pane').first();
const phraseA = '比较两种检索策略时';
const phraseB = '跨数据库对照仍需补充核验';
const fallbackQuote = '样例结果：B的召回更高，但同义词扩展也是变化因素，不能只据此推断证据更可靠。';
const saveSelected = async (scope, text, paragraph = 0) => {
  await selectText(scope.locator('.paper-copy p').nth(paragraph), text);
  await expect(tools(scope)).toContainText(`已选 ${text.length} 字`);
  await tools(scope).getByRole('button', { name: '保存摘录', exact: true }).click();
};
const noChatChange = async () => {
  await expect(page.locator('.chat-head strong')).toHaveText('比较检索条件');
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '停止回答', exact: true })).toHaveCount(0);
};
const selectAcross = async () => {
  const box = await first().locator('.paper-copy').boundingBox();
  await page.mouse.click(box.x + box.width - 2, box.y + 2);
  const points = await first().locator('.paper-copy').evaluate(root => {
    const textPoint = (needle, end) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const start = node.textContent.indexOf(needle);
        if (start < 0) continue;
        const range = document.createRange(), offset = start + (end ? needle.length - 1 : 0);
        range.setStart(node, offset); range.setEnd(node, offset + 1);
        const r = range.getBoundingClientRect();
        return { x: end ? r.right - .2 : r.x + .2, y: r.y + r.height / 2 };
      }
      throw new Error(`找不到跨段选文端点：${needle}`);
    };
    return { a: textPoint('需要保持年份', false), b: textPoint('并记录检索式', true) };
  });
  await page.mouse.move(points.a.x, points.a.y);
  await page.mouse.down();
  await page.mouse.move(points.b.x, points.b.y, { steps: 12 });
  await page.mouse.up();
  const quote = await page.evaluate(() => getSelection().toString().trim());
  expect(quote).toContain('需要保持年份');
  expect(quote).toContain(fallbackQuote);
  expect(quote).toContain('并记录检索式');
  return quote;
};

const cases = [
  ['三尺寸选文工具/编辑器无溢出、按钮可命中，Tab/Enter/Escape可完成路径', async () => {
    for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
      await reset(width, height);
      await selectText(first().locator('.paper-copy p').first(), phraseA);
      for (const name of ['保存摘录', '制作卡片', '问这段']) await hitTarget(tools(first()).getByRole('button', { name, exact: true }));
      const save = tools(first()).getByRole('button', { name: '保存摘录', exact: true });
      await save.focus();
      await page.keyboard.press('Enter');
      await expect(excerpt(first())).toHaveCount(1);
      await page.keyboard.press('Tab');
      await expect(tools(first()).getByRole('button', { name: '制作卡片', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(editor()).toBeVisible();
      await editor().getByRole('textbox', { name: '卡片标题', exact: true }).fill('检索条件核对');
      await editor().getByRole('textbox', { name: '卡片正文', exact: true }).fill('先保持年份与数据库一致。');
      for (const locator of [editor().getByRole('textbox', { name: '卡片标题', exact: true }), editor().getByRole('textbox', { name: '卡片正文', exact: true }), editor().getByRole('button', { name: '保存卡片', exact: true }), editor().getByRole('button', { name: '关闭卡片编辑', exact: true })]) await hitTarget(locator);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      report.measurements[`${width}x${height}`] = { editor: await editor().boundingBox(), toolbar: await tools(first()).boundingBox() };
      if (width === 1024) await shot('reader-editor-1024');
      await page.keyboard.press('Escape');
      await expect(editor()).toHaveCount(0);
    }
  }],
  ['真实鼠标选择不同原文后保存对应quote，12/13页分别保存pageIndex 11/12', async () => {
    await reset();
    await saveSelected(first(), phraseA);
    await expect(excerpt(first()).first().locator('blockquote')).toHaveText(phraseA);
    await expect(excerpt(first()).first()).toHaveAttribute('data-document-id', 'sample-paper-a');
    await expect(excerpt(first()).first()).toHaveAttribute('data-page-index', '11');
    await saveSelected(first(), phraseB, 1);
    await expect(excerpt(first())).toHaveCount(2);
    await expect(excerpt(first()).last().locator('blockquote')).toHaveText(phraseB);
    await first().getByRole('button', { name: '下一页', exact: true }).click();
    await saveSelected(first(), phraseA);
    await expect(excerpt(first())).toHaveCount(3);
    await expect(excerpt(first()).last()).toHaveAttribute('data-page-index', '12');
    report.measurements.evidence = await excerpt(first()).evaluateAll(rows => rows.map(row => ({ documentId: row.dataset.documentId, pageIndex: +row.dataset.pageIndex, id: row.dataset.evidenceId, quote: row.querySelector('blockquote').textContent })));
    await first().locator('.reader-notes').scrollIntoViewIfNeeded();
    await shot('different-selection-excerpts');
    await noChatChange();
  }],
  ['重复摘录不重复保存，摘录操作保留当前会话与未发送输入', async () => {
    await reset();
    const draft = '聊天草稿独立保留';
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(draft);
    await saveSelected(first(), phraseA);
    const id = await excerpt(first()).first().getAttribute('data-evidence-id');
    await tools(first()).getByRole('button', { name: '保存摘录', exact: true }).click();
    await saveSelected(first(), phraseA);
    await expect(excerpt(first())).toHaveCount(1);
    await expect(excerpt(first()).first()).toHaveAttribute('data-evidence-id', id);
    await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue(draft);
    await noChatChange();
  }],
  ['制作/修订卡片保存独立正文，保留原文引用与同一evidenceId', async () => {
    await reset();
    await selectText(first().locator('.paper-copy p').last(), phraseB);
    await tools(first()).getByRole('button', { name: '制作卡片', exact: true }).click();
    await editor().getByRole('textbox', { name: '卡片标题', exact: true }).fill('跨库对照仍待验证');
    await editor().getByRole('textbox', { name: '卡片正文', exact: true }).fill('我的判断：检索数量不能代替相关性。');
    await expect(editor().locator('.card-evidence blockquote')).toHaveText(phraseB);
    await shot('reader-card-editor-1440');
    await editor().getByRole('button', { name: '保存卡片', exact: true }).click();
    await expect(cards(first())).toHaveCount(1);
    await expect(excerpt(first())).toHaveCount(1);
    const id = await excerpt(first()).getAttribute('data-evidence-id');
    await expect(cards(first())).toHaveAttribute('data-evidence-id', id);
    await cards(first()).getByRole('button', { name: '编辑卡片', exact: true }).click();
    await editor().getByRole('textbox', { name: '卡片正文', exact: true }).fill('修订判断：应先对齐年份和筛选条件。');
    await editor().getByRole('button', { name: '保存卡片', exact: true }).click();
    await expect(cards(first())).toHaveCount(1);
    await expect(cards(first()).locator('p')).toHaveText('修订判断：应先对齐年份和筛选条件。');
    await expect(excerpt(first()).locator('blockquote')).toHaveText(phraseB);
    await expect(excerpt(first())).toHaveAttribute('data-page-index', '11');
    await cards(first()).scrollIntoViewIfNeeded();
    await shot('reader-card-saved');
    await noChatChange();
  }],
  ['稍后继续/关闭/Escape保留未保存卡片草稿，切资源后可恢复原依据', async () => {
    await reset();
    await selectText(first().locator('.paper-copy p').first(), phraseA);
    await tools(first()).getByRole('button', { name: '制作卡片', exact: true }).click();
    await editor().getByRole('textbox', { name: '卡片标题', exact: true }).fill('尚未完成的判断');
    await editor().getByRole('textbox', { name: '卡片正文', exact: true }).fill('保留这段尚未保存的推理。');
    await editor().getByRole('button', { name: '稍后继续', exact: true }).click();
    await expect(editor()).toHaveCount(0);
    await expect(cards(first())).toHaveCount(0);
    await first().getByRole('button', { name: '继续卡片草稿', exact: true }).click();
    await expect(editor().getByRole('textbox', { name: '卡片正文', exact: true })).toHaveValue('保留这段尚未保存的推理。');
    await editor().getByRole('button', { name: '关闭卡片编辑', exact: true }).click();
    await page.getByRole('tab', { name: '研究白板', exact: true }).click();
    await page.getByRole('tab', { name: '样例论文A', exact: true }).click();
    await first().getByRole('button', { name: '继续卡片草稿', exact: true }).click();
    await expect(editor().getByRole('textbox', { name: '卡片标题', exact: true })).toHaveValue('尚未完成的判断');
    await expect(editor().locator('.card-evidence blockquote')).toHaveText(phraseA);
    await page.keyboard.press('Escape');
    await tools(first()).getByRole('button', { name: '制作卡片', exact: true }).click();
    await expect(editor().getByRole('textbox', { name: '卡片正文', exact: true })).toHaveValue('保留这段尚未保存的推理。');
    await expect(editor().locator('.card-evidence blockquote')).toHaveText(phraseA);
    await noChatChange();
  }],
  ['保存项跨页/资源/分屏共用，点来源回原页且不改另一视图位置', async () => {
    await reset();
    await saveSelected(first(), phraseA);
    const id = await excerpt(first()).getAttribute('data-evidence-id');
    await tools(first()).getByRole('button', { name: '制作卡片', exact: true }).click();
    await editor().getByRole('textbox', { name: '卡片标题', exact: true }).fill('跨视图共用的判断');
    await editor().getByRole('textbox', { name: '卡片正文', exact: true }).fill('这张卡片与同一份原文证据保持关联。');
    await editor().getByRole('button', { name: '保存卡片', exact: true }).click();
    await expect(cards(first())).toHaveAttribute('data-evidence-id', id);
    await first().getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByRole('tab', { name: '研究白板', exact: true }).click();
    await page.getByRole('tab', { name: '样例论文A', exact: true }).click();
    await expect(excerpt(first())).toHaveAttribute('data-evidence-id', id);
    await expect(cards(first())).toHaveAttribute('data-evidence-id', id);
    await page.getByRole('button', { name: '分屏', exact: true }).click();
    const second = page.locator('.resource-pane').last();
    await expect(excerpt(second)).toHaveAttribute('data-evidence-id', id);
    await expect(cards(second)).toHaveAttribute('data-evidence-id', id);
    await expect(cards(second).locator('p')).toHaveText('这张卡片与同一份原文证据保持关联。');
    await second.getByRole('button', { name: '下一页', exact: true }).click();
    await second.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(second.locator('.paper-controls')).toContainText('第 14 / 20 页');
    await excerpt(first()).getByRole('button', { name: '样例论文A · 第12页 ↗', exact: true }).click();
    await expect(first().locator('.paper-controls')).toContainText('第 12 / 20 页');
    await expect(second.locator('.paper-controls')).toContainText('第 14 / 20 页');
    await expect.poll(() => page.evaluate(() => getSelection().toString().trim())).toBe(phraseA);
    await expect(excerpt(first())).toHaveAttribute('data-evidence-id', id);
    await expect(excerpt(second)).toHaveAttribute('data-evidence-id', id);
    await excerpt(first()).scrollIntoViewIfNeeded();
    await shot('shared-reader-evidence');
    await noChatChange();
  }],
  ['真实跨段选文保存完整quote，不裁成高亮示例句', async () => {
    await reset();
    const quote = await selectAcross();
    await tools(first()).getByRole('button', { name: '保存摘录', exact: true }).click();
    await expect(excerpt(first())).toHaveCount(1);
    const savedQuote = await excerpt(first()).locator('blockquote').textContent();
    expect(savedQuote).toBe(quote);
    await expect(excerpt(first())).toHaveAttribute('data-page-index', '11');
    report.measurements.crossParagraphQuote = quote;
    report.measurements.crossParagraphSavedQuote = savedQuote;
  }],
  ['跨段来源回页时精确选回完整保存quote及段落分隔', async () => {
    await reset();
    const quote = await selectAcross();
    await tools(first()).getByRole('button', { name: '保存摘录', exact: true }).click();
    await first().getByRole('button', { name: '下一页', exact: true }).click();
    await selectText(first().locator('.paper-copy p').last(), phraseB);
    await excerpt(first()).getByRole('button', { name: '样例论文A · 第12页 ↗', exact: true }).click();
    await expect(first().locator('.paper-controls')).toContainText('第 12 / 20 页');
    const selected = await page.evaluate(() => getSelection().toString().trim());
    expect(selected).toBe(quote);
    report.measurements.crossParagraphSourceSelection = selected;
    await shot('cross-paragraph-source');
  }],
  ['引用定位offset精确/空白映射正确，空quote或未匹配均返回null', async () => {
    await reset();
    const result = await page.evaluate(async () => {
      const { quoteOffsets } = await import('/docs/agent-native-evolution/conversation-redesign/workspace-paper-notes.jsx');
      const text = '前缀甲 \n乙\t丙后缀', mapped = quoteOffsets(text, '甲乙丙');
      const compact = '前甲乙丙后', multiline = quoteOffsets(compact, '甲\n乙 丙');
      const exact = quoteOffsets(text, '乙\t丙');
      return { mappedSlice: text.slice(mapped.start, mapped.end), compactSlice: compact.slice(multiline.start, multiline.end), exactSlice: text.slice(exact.start, exact.end), empty: quoteOffsets(text, ''), whitespace: quoteOffsets(text, ' \n\t '), missing: quoteOffsets(text, '不存在的原文') };
    });
    expect(result.mappedSlice).toBe('甲 \n乙\t丙');
    expect(result.compactSlice).toBe('甲乙丙');
    expect(result.exactSlice).toBe('乙\t丙');
    expect(result.empty).toBeNull();
    expect(result.whitespace).toBeNull();
    expect(result.missing).toBeNull();
    report.measurements.quoteOffsets = result;
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
