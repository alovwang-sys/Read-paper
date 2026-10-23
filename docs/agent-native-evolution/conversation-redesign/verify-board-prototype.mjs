import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const base = 'http://127.0.0.1:5173';
const url = `${base}/docs/agent-native-evolution/conversation-redesign/prototype.html`;
const out = fileURLToPath(new URL('./verification/board-open/', import.meta.url));
await mkdir(out, { recursive: true });
const report = {
  date: new Date().toISOString(), url,
  scope: '白板交互原型：合成卡片、内存保存、固定示例回答；不验证生产 Excalidraw、真实 AI 或磁盘持久化。',
  checks: [], screenshots: [], errors: [], nonLocalRequests: []
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/*', route => {
  const requestURL = new URL(route.request().url());
  if (requestURL.origin === base) return route.continue();
  report.nonLocalRequests.push(requestURL.href);
  return route.abort();
});
const page = await context.newPage();
page.on('pageerror', error => report.errors.push(error.message));
const reset = async (viewport = { width: 1440, height: 900 }) => {
  await page.setViewportSize(viewport);
  await page.goto(url);
  await expect(page.locator('#ta')).toBeVisible();
};
const shot = async name => {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  report.screenshots.push(`${name}.png`);
};
const check = async (name, run) => {
  try {
    await run();
    report.checks.push({ name, pass: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, pass: false, error: error.message });
    await shot(`failure-${report.checks.length}`);
    console.log(`FAIL ${name}: ${error.message}`);
  }
};
const boardReady = async () => {
  await expect(page.locator('#board-canvas')).toBeVisible();
  // The prototype fits the canvas in requestAnimationFrame after mounting it.
  await expect.poll(() => page.locator('#board-canvas').evaluate(node => node.style.transform)).toMatch(/^scale\(/);
};
const openBoard = async () => {
  const nav = page.locator('[data-act="nav"]');
  if (await nav.isVisible() && !(await page.locator('#L').evaluate(node => node.classList.contains('on')))) await nav.click();
  if (await page.locator('#lib').isHidden()) await page.locator('[data-act="lib"]').click();
  await page.locator('#lib [data-v="board"]').click();
  await boardReady();
};
const card = index => page.locator(`#board-canvas .board-node[data-node="${index}"]`);
const openCard = async index => {
  await page.locator(`[data-act="boardcard"][data-i="${index}"]`).click();
  await expect(page.locator('#board-card-body')).toBeVisible();
};
const backToBoard = async () => {
  await page.locator('[data-act="boardback"]').click();
  await boardReady();
};
const point = async locator => {
  const b = await locator.boundingBox();
  expect(b).toBeTruthy();
  return { x: b.x, y: b.y };
};
const designPoint = locator => locator.evaluate(node => ({ left: node.style.left, top: node.style.top }));
const paths = () => page.locator('#board-paths > path').evaluateAll(nodes => nodes.map(node => node.getAttribute('d')));
const dragFirst = async () => {
  const handle = card(0).locator('.board-node-head[data-drag="0"]');
  const b = await handle.boundingBox();
  expect(b).toBeTruthy();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 72, b.y + b.height / 2 + 54, { steps: 12 });
  await page.mouse.up();
};

try {
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await check(`${width}×${height}：白板打开为关系画布，卡片正文可打开，画布不撑破页面`, async () => {
      await reset({ width, height });
      await openBoard();
      await expect(page.locator('.board-node')).toHaveCount(3);
      expect((await paths()).length).toBeGreaterThanOrEqual(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await shot(`board-${width}x${height}`);
      await openCard(0);
      await expect(page.locator('#board-card-body')).not.toHaveValue('');
      await backToBoard();
      await expect(page.locator('.board-node')).toHaveCount(3);
    });
  }

  await check('打开正文编辑，返回白板再打开保留编辑内容', async () => {
    await reset();
    await openBoard();
    await openCard(0);
    const text = '限定2018年后的证据需要分数据库核对。\n保留这一行人工修改。';
    await page.locator('#board-card-body').fill(text);
    await backToBoard();
    await expect(card(0)).toContainText('限定2018年后的证据需要分数据库核对。');
    await openCard(0);
    await expect(page.locator('#board-card-body')).toHaveValue(text);
    await shot('card-open-edited');
  });

  await check('卡片拖动改变连线，打开正文与会话往返均保留位置', async () => {
    await reset();
    await openBoard();
    const before = await point(card(0));
    const beforePaths = await paths();
    await dragFirst();
    const moved = await point(card(0));
    expect(moved.x - before.x).toBeGreaterThan(40);
    expect(moved.y - before.y).toBeGreaterThan(30);
    expect(await paths()).not.toEqual(beforePaths);
    const movedDesign = await designPoint(card(0));
    const movedPaths = await paths();
    await openCard(0);
    await backToBoard();
    expect(await point(card(0))).toEqual(moved);
    expect(await designPoint(card(0))).toEqual(movedDesign);
    await card(0).locator('[data-act="add"]').click();
    await page.locator('#ta').fill('核对这张卡片中的证据');
    await page.locator('#sb').click();
    await expect(page.locator('#thread .u').last()).toContainText('核对这张卡片中的证据');
    await expect(page.locator('#ta')).toHaveValue('');
    await expect(page.locator('[aria-label="停止回答"]')).toHaveCount(0, { timeout: 5000 });
    await page.locator('[data-act="return"]').click();
    await boardReady();
    expect(await designPoint(card(0))).toEqual(movedDesign);
    expect(await paths()).toEqual(movedPaths);
    await shot('board-after-drag-chat-return');
  });

  await check('独立加入提问带正文快照，后续修改卡片不会悄悄更换已选上下文', async () => {
    await reset();
    await openBoard();
    await openCard(0);
    const snapshot = '提交快照：数据库A在2018年后召回0.81。';
    await page.locator('#board-card-body').fill(snapshot);
    await backToBoard();
    await card(0).locator('[data-act="add"]').click();
    await expect(page.locator('#chips')).toContainText('白板卡片1');
    await openCard(0);
    await page.locator('#board-card-body').fill('后续编辑：这段不应替换已选择的正文快照。');
    await backToBoard();
    await page.locator('#ta').fill('请根据我选中的卡片继续检索');
    await page.locator('#sb').click();
    await expect(page.locator('#thread .u').last()).toContainText(snapshot);
    await expect(page.locator('#thread .u').last()).not.toContainText('后续编辑');
    await expect(page.locator('[aria-label="停止回答"]')).toHaveCount(0, { timeout: 5000 });
    await shot('card-context-snapshot-in-chat');
    await page.locator('[data-act="return"]').click();
    await openCard(0);
    await expect(page.locator('#board-card-body')).toHaveValue('后续编辑：这段不应替换已选择的正文快照。');
  });
} finally {
  report.summary = { total: report.checks.length, passed: report.checks.filter(c => c.pass).length, failed: report.checks.filter(c => !c.pass).length };
  await writeFile(path.join(out, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  console.log(JSON.stringify(report.summary));
  if (report.summary.failed || report.errors.length || report.nonLocalRequests.length) process.exitCode = 1;
}
