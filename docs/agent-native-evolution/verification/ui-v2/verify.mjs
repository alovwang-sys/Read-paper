import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('.', import.meta.url));
const url = process.env.PROTOTYPE_URL || 'http://127.0.0.1:5173/docs/agent-native-evolution/prototype.html';
const report = { checkedAt: new Date().toISOString(), url, checks: [], screenshots: [], pageErrors: [], externalRequests: [], storageCalls: [], limitations: ['Fixed synthetic examples; no real model, tool loop, external search, PDF, or research quality verification.', 'Page memory only; reload resets this isolated prototype.', 'Canvas offers a fixed mixed example and simple additions, not a production drawing engine.'] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await context.addInitScript(() => {
  window.prototypeStorageCalls = [];
  for (const method of ['getItem', 'setItem', 'removeItem', 'clear']) {
    Storage.prototype[method] = function () { window.prototypeStorageCalls.push(method); throw new Error('Prototype must not access persistent storage'); };
  }
  indexedDB.open = function () { window.prototypeStorageCalls.push('indexedDB.open'); throw new Error('Prototype must not open user IndexedDB'); };
});
await context.route('**/@vite/client', route => route.fulfill({ contentType: 'text/javascript', body: 'export const injectQuery = (url) => url;' }));
const page = await context.newPage();
page.setDefaultTimeout(9000);
page.on('pageerror', e => report.pageErrors.push(e.message));
page.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:5173/') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) report.externalRequests.push(r.url()); });
const pass = label => report.checks.push({ label, status: 'passed' });
const capture = async name => { if (!await page.evaluate(() => state.busy)) await page.locator('#toast').waitFor({ state: 'hidden', timeout: 4500 }); await page.screenshot({ path: output + name }); report.screenshots.push(name); };
const send = async text => { await page.getByRole('textbox', { name: '研究指令', exact: true }).fill(text); await page.getByRole('button', { name: '发送研究指令', exact: true }).click(); };
const askRow = async id => { await page.locator(`[data-row="${id}"]`).click({ position: { x: 20, y: 20 } }); await page.locator(`[data-row="${id}"]`).getByRole('button', { name: '围绕这里追问', exact: true }).click(); };
const closeRef = () => page.getByRole('button', { name: '关闭参考区', exact: true }).click();
const oneInput = async () => {
  assert.equal(await page.locator('textarea').count(), 1);
  assert.equal(await page.evaluate(() => window.originalComposer === document.getElementById('agent-input')), true);
};
const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

try {
  await page.goto(url);
  await page.waitForFunction(() => typeof state === 'object');
  await page.evaluate(() => { window.originalComposer = document.getElementById('agent-input'); });
  assert.equal(await page.locator('#reference').isVisible(), false);
  await oneInput();
  assert.equal(await page.getByRole('button', { name: '对话记录', exact: true }).count(), 1);
  await capture('welcome-1440.png');
  assert.equal(await page.getByRole('textbox', { name: '编辑研究名称' }).textContent(), '新研究');
  assert.equal(await page.locator('#scope-button').count(), 0);
  pass('Empty state has one composer, one discoverable history entry, no default focus/scope chip or permanent chat panel, and an editable untitled research name');

  await send('解释为什么要比较这些论文？');
  assert.equal(await page.evaluate(() => state.rows.length), 0);
  assert.equal(await page.evaluate(() => state.view), 'welcome');
  assert.match(await page.locator('#short-answer').textContent(), /普通解释会留在这里/);
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  assert.equal(await page.locator('#short-answer details').isVisible(), true);
  await closeRef();
  pass('Ordinary explanation stays in a collapsible short answer; viewing history does not erase it or create an artifact');

  await page.getByRole('button', { name: '新研究', exact: true }).click();
  assert.equal(await page.evaluate(() => state.documents.length), 0);
  await page.getByRole('button', { name: /添加资料/ }).click();
  await page.getByRole('button', { name: '加入 3 份示例资料', exact: true }).click();
  assert.equal(await page.evaluate(() => state.documents.length), 3);
  await closeRef();
  await oneInput();
  pass('A new empty research adds the three explicitly synthetic sources with one adoption action');

  await page.getByRole('button', { name: /比较这些论文/ }).click();
  await page.getByRole('button', { name: '发送研究指令', exact: true }).click();
  await page.waitForFunction(() => state.rows.length >= 1);
  await capture('running-1440.png');
  await page.getByRole('button', { name: '停止本次研究', exact: true }).click();
  const completed = await page.evaluate(() => state.rows.length);
  await page.waitForTimeout(900);
  assert.equal(await page.evaluate(() => state.rows.length), completed);
  assert.equal(await page.evaluate(() => state.stopped), true);
  assert.match(await page.locator('#run-line').textContent(), /已完成的/);
  await page.getByRole('button', { name: '继续研究', exact: true }).click();
  await page.waitForFunction(() => !state.busy);
  assert.equal(await page.locator('[data-row]').count(), 3);
  await oneInput();
  assert.equal(await page.getByRole('button', { name: '对话记录', exact: true }).count(), 1);
  pass('Start creates editable results directly, stopping preserves completed parts, continuing finishes without duplicate rows or a second input');

  await page.locator('#content').evaluate(e => { e.scrollTop = 0; });
  await page.locator('#agent-input').blur();
  await capture('result-1440.png');
  await noOverflow();
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    await page.locator('#content').evaluate(e => { e.scrollTop = 0; });
    await noOverflow();
    await oneInput();
    const inputBox = await page.locator('#agent-input').boundingBox();
    assert.ok(inputBox.x >= 0 && inputBox.x + inputBox.width <= width && inputBox.y + inputBox.height <= 800);
    await capture(`result-${width}.png`);
  }
  assert.equal(await page.locator('#sidebar').evaluate(e => e.inert), true);
  await page.getByRole('button', { name: '展开研究导航' }).click();
  assert.equal(await page.locator('#sidebar').evaluate(e => e.inert), false);
  await page.locator('#drawer-shade').click({ position: { x: 700, y: 200 } });
  pass('1440×900, 1280×800 and 1024×800 have no document overflow; the single input stays visible and the narrow navigation is an accessible drawer');

  await askRow('r2');
  const focus = await page.evaluate(() => ({ ...state.focus }));
  assert.equal(focus.row, 'r2');
  await page.getByRole('button', { name: /资料 · 3/ }).click();
  await page.locator('[data-source-card="a"]').getByRole('button', { name: '查看', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => state.focus), focus);
  await closeRef();
  await send('解释一下这一处。');
  assert.equal(await page.evaluate(() => state.focus), null);
  assert.match(await page.locator('#short-answer').textContent(), /第2项/);
  await send('还有哪些方面需要留意？');
  assert.equal(await page.evaluate(() => state.history.filter(h => h.who === 'user').at(-1).target), null);
  const beforeExplanation = await page.evaluate(() => state.rows.map(r => r.text));
  await send('解释为什么不能改成材料越多越差？');
  assert.deepEqual(await page.evaluate(() => state.rows.map(r => r.text)), beforeExplanation);
  pass('Only an explicit local ask sets a visible target; browsing does not change it, sending consumes it, and explanation questions containing revision words do not mutate results');

  await page.locator('#agent-input').fill(Array(10).fill('这是尚未发送的长研究指令，继续保留当前工作位置。').join('\n'));
  assert.equal(await page.locator('#short-answer details').evaluate(e => e.open), false);
  assert.ok((await page.locator('#agent-input').boundingBox()).height <= 140);
  assert.ok((await page.locator('#content').boundingBox()).height >= 250);
  await capture('long-input-1024.png');
  await page.locator('#agent-input').fill('');
  await page.locator('#agent-input').pressSequentially('保留文字');
  await page.locator('#agent-input').press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
  assert.notEqual(await page.locator('#agent-input').inputValue(), '保留文字');
  await page.locator('#agent-input').fill('');
  pass('A long input collapses the bounded short answer, preserves a usable work area at 1024px, and native text undo is not hijacked');
  await page.locator('#short-answer details').evaluate(e => { e.open = false; });
  await page.locator('[data-row="r2"]').getByRole('button', { name: /信息位置 · p.7/ }).click();
  await capture('reference-1024.png');
  await oneInput();
  assert.equal(await page.locator('#reference').count(), 1);
  const saved = await page.evaluate(() => ({ ...state.referenceOrigin }));
  await page.getByRole('button', { name: '阅读全文', exact: true }).click();
  assert.equal(await page.evaluate(() => state.view), 'pdf');
  assert.equal(await page.locator('#reference').isVisible(), false);
  assert.match(await page.locator('.pdf-paper').textContent(), /合成文字，非真实论文 PDF/);
  await capture('deep-read-1024.png');
  await page.getByRole('button', { name: /返回比较结果 · 第2项/ }).click();
  assert.equal(await page.evaluate(() => state.selection), 'r2');
  assert.equal(await page.locator('#content').evaluate(e => e.scrollTop), saved.scroll);
  pass('Citation opens the one reference region; deep reading has an explicit return target and restores the exact comparison scroll position and selected item');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(250);
  const edit = page.getByRole('textbox', { name: '编辑第1项比较', exact: true });
  await edit.fill('我的判断：先固定相关性，再单独比较数量。这个条件还需要核查。');
  await askRow('r1');
  await send('这里混淆了噪声比例和材料数量，请修订这一处。');
  assert.match(await edit.textContent(), /我的判断/);
  assert.equal(await page.locator('[data-conflict="r1"]').isVisible(), true);
  assert.match(await page.locator('[data-row="r1"] .citation').textContent(), /p.4/);
  await capture('edit-conflict-1440.png');
  await edit.fill('我的新编辑：固定相关性与位置之后，再比较数量；尚待核查。');
  await page.getByRole('button', { name: '采用建议', exact: true }).click();
  assert.match(await edit.textContent(), /我的新编辑/);
  assert.match(await page.locator('[data-conflict="r1"]').textContent(), /你刚才又修改/);
  await page.getByRole('button', { name: '采用建议', exact: true }).click();
  assert.match(await edit.textContent(), /应把材料数量与无关信息比例分别比较/);
  await page.getByRole('button', { name: '撤销本次修改', exact: true }).click();
  assert.match(await edit.textContent(), /我的新编辑/);
  await askRow('r1');
  await send('再修订这一处。');
  await page.getByRole('button', { name: '保留我的', exact: true }).click();
  assert.match(await edit.textContent(), /我的新编辑/);
  assert.equal(await page.locator('[data-conflict]').count(), 0);
  await askRow('r1');
  await send('再修订这一处。');
  await page.getByRole('button', { name: '采用建议', exact: true }).click();
  await edit.fill('应用建议之后，我又写下了新的判断。');
  await page.getByRole('button', { name: '撤销本次修改', exact: true }).click();
  assert.equal(await edit.textContent(), '应用建议之后，我又写下了新的判断。');
  pass('Manual edits retain source labels; revisions show inline differences, stale proposals cannot overwrite new edits, and apply/undo/keep preserve user text');

  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await page.locator('[data-source-card="d"]').getByRole('button', { name: '收入本研究', exact: true }).click();
  assert.equal(await page.evaluate(() => state.documents.filter(id => id === 'd').length), 1);
  assert.match(await page.locator('[data-source-card="d"]').textContent(), /已在本研究/);
  await page.locator('[data-source-card="d"]').getByRole('button', { name: '查看', exact: true }).click();
  assert.match(await page.locator('#ref-body').textContent(), /尚无全文，无法定位原文/);
  assert.equal(await page.getByRole('button', { name: '阅读全文', exact: true }).count(), 0);
  await closeRef();
  for (const [query, type] of [['变量应该', '卡片'], ['上周', '白板'], ['证据综述', '文稿']]) {
    await page.getByRole('button', { name: /查找/ }).click();
    await page.getByRole('textbox', { name: '查找资料', exact: true }).fill(query);
    await page.getByRole('button', { name: `打开 ${type} →`, exact: true }).click();
    assert.equal(await page.evaluate(() => state.view), 'legacy');
    assert.match(await page.locator('#content').textContent(), new RegExp(type));
    await page.getByRole('button', { name: '返回研究工作面', exact: true }).click();
  }
  pass('One library adoption associates the source without repeated steps; metadata-only sources cannot pretend to have full text; search retrieves old cards, whiteboards and drafts');

  await page.getByRole('button', { name: '查看关系 ↗', exact: true }).click();
  assert.equal(await page.locator('.canvas-card').count(), 3);
  assert.equal(await page.locator('.canvas-note').count(), 1);
  assert.equal(await page.getByRole('button', { name: /卡片布局|绘图模式/ }).count(), 0);
  await page.getByRole('button', { name: '新增卡片', exact: true }).click();
  assert.equal(await page.locator('.canvas-new').count(), 1);
  await page.getByRole('button', { name: '形状工具', exact: true }).click();
  await page.locator('.canvas-scene').click({ position: { x: 690, y: 390 } });
  assert.equal(await page.locator('.canvas-new').count(), 2);
  await page.getByRole('button', { name: '围绕这张卡片追问 ↗', exact: true }).click();
  assert.match(await page.locator('#focus-chip').textContent(), /卡片/);
  await page.locator('#content').evaluate(e => { e.scrollTop = 0; });
  await capture('mixed-canvas-1440.png');
  await page.getByRole('button', { name: '清除本次追问目标', exact: true }).click();
  await page.getByRole('button', { name: '返回比较结果', exact: true }).click();
  await oneInput();
  pass('The canvas combines content cards, a source and a shape without a card/drawing mode switch; local ask uses the same composer');

  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await capture('history-1440.png');
  assert.equal(await page.locator('#reference textarea').count(), 0);
  await closeRef();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出当前成果' }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), '研究初稿-设计示例.md');
  pass('History stays a read-only temporary reference, and the current draft exports through one object action');

  report.storageCalls.push(...await page.evaluate(() => window.prototypeStorageCalls));
  assert.deepEqual(report.storageCalls, []);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.pageErrors, []);
  pass('No JavaScript errors, external requests, persistent-storage reads or writes occurred');

  // A separate isolated run verifies that late results do not navigate away from deep reading.
  await page.reload();
  await page.waitForFunction(() => typeof state === 'object');
  await page.getByRole('button', { name: /比较这些论文/ }).click();
  await page.getByRole('button', { name: '发送研究指令', exact: true }).click();
  await page.waitForFunction(() => state.rows.length >= 1);
  await page.locator('[data-row="r1"]').getByRole('button', { name: /相关性与数量 · p.4/ }).click();
  await page.getByRole('button', { name: '阅读全文', exact: true }).click();
  await page.waitForFunction(() => !state.busy);
  assert.equal(await page.evaluate(() => state.view), 'pdf');
  assert.equal(await page.evaluate(() => state.pdfSource), 'a');
  assert.match(await page.locator('#run-line').textContent(), /已完成比较初稿/);
  assert.equal(await page.getByRole('button', { name: '打开成果 →', exact: true }).isVisible(), true);
  pass('Completing a run while reading preserves the central source page and offers a one-line result link instead of stealing focus');

  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error.stack || error);
  await capture('failure.png');
  throw error;
} finally {
  fs.writeFileSync(output + 'checks.json', JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, screenshots: report.screenshots.length, pageErrors: report.pageErrors, error: report.error }));
}
