import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const base = 'http://127.0.0.1:5173';
const url = `${base}/docs/agent-native-evolution/conversation-redesign/prototype.html`;
const out = fileURLToPath(new URL('./verification/qa/', import.meta.url));
await mkdir(out, { recursive: true });
const report = { date: new Date().toISOString(), url, scope: '本地静态交互原型；合成回答，不调用真实模型', checks: [], screenshots: [], errors: [], blockedRequests: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/*', route => {
  const requestURL = new URL(route.request().url());
  if (requestURL.origin === base) return route.continue();
  report.blockedRequests.push(requestURL.href);
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
const visibleInViewport = async selector => {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${selector} exists`).toBeTruthy();
  expect(box.x, `${selector} left`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${selector} top`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height, `${selector} bottom`).toBeLessThanOrEqual(viewport.height + 1);
};
const hitTarget = async selector => {
  await visibleInViewport(selector);
  expect(await page.locator(selector).evaluate(node => {
    const box = node.getBoundingClientRect();
    const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return target === node || node.contains(target);
  }), `${selector} receives pointer at its centre`).toBe(true);
};
const parallelReference = async () => {
  const main = await page.locator('#M').boundingBox();
  const reference = await page.locator('#R').boundingBox();
  expect(main.x + main.width, 'main and reference do not overlap').toBeLessThanOrEqual(reference.x + 1);
  expect(reference.width, 'reference width').toBe(360);
  await hitTarget('#ta');
  await hitTarget('#sb');
};
const send = async text => {
  await page.locator('#ta').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
};
const finished = async () => expect(page.getByRole('button', { name: '停止回答', exact: true })).toHaveCount(0, { timeout: 5000 });
const openResource = async name => {
  if (await page.locator('#lib').isHidden()) await page.locator('[data-act="lib"]').click();
  await page.locator(`#lib [data-v="${name}"]`).click();
};

try {
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await check(`${width}×${height}：无横向溢出、输入/切换/发送可见、会话36px单行`, async () => {
      await reset({ width, height });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const selector of ['#ta', '#ab', '#sb']) await visibleInViewport(selector);
      if (width === 1024) await page.locator('[data-act="nav"]').click();
      const rows = await page.locator('#rows .row').evaluateAll(nodes => nodes.map(n => ({ height: n.getBoundingClientRect().height, whiteSpace: getComputedStyle(n.querySelector('span')).whiteSpace, lines: n.innerText.split('\n').length })));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => row.height === 36 && row.whiteSpace === 'nowrap' && row.lines === 1)).toBe(true);
      if (width === 1024) await page.keyboard.press('Escape');
      await shot(`chat-${width}x${height}`);
      await page.locator('[data-act="cite"]').first().click();
      await visibleInViewport('#R');
      await parallelReference();
      await shot(`reference-${width}x${height}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  await check('发送即时进中央，输入清空，示例回答留在本会话', async () => {
    await reset();
    await send('再次比较近五年的召回');
    await expect(page.locator('#ta')).toHaveValue('');
    await expect(page.locator('#thread .u').last()).toContainText('再次比较近五年的召回');
    await expect(page.locator('#thread .a').last()).toContainText('正在查阅资料');
    await finished();
    await expect(page.locator('#thread .a').last()).toContainText('0.81 对 0.66');
    await shot('sent-and-answered');
  });

  await check('普通换助手保留会话/草稿，旧回答仍标原助手', async () => {
    await reset();
    const title = await page.locator('#hd h1').innerText();
    const count = await page.locator('#rows .row').count();
    const labels = await page.locator('#thread .a .n').allTextContents();
    await page.locator('#ta').fill('保留这段未发送草稿');
    await page.locator('#ab').click();
    await page.locator('[data-act="pick"][data-n="Codex"]').click();
    await expect(page.locator('#ab')).toContainText('Codex');
    await expect(page.locator('#ta')).toHaveValue('保留这段未发送草稿');
    await expect(page.locator('#hd h1')).toHaveText(title);
    expect(await page.locator('#rows .row').count()).toBe(count);
    expect(await page.locator('#thread .a .n').allTextContents()).toEqual(labels);
    await page.locator('#ab').click();
    await page.locator('[data-act="pick"][data-n="Claude Code"]').click();
    await expect(page.locator('#ta')).toHaveValue('保留这段未发送草稿');
    await expect(page.locator('#hd h1')).toHaveText(title);
    expect(await page.locator('#thread .a .n').allTextContents()).toEqual(labels);
  });

  await check('不同会话独立输入，往返恢复草稿', async () => {
    await reset();
    await page.locator('#ta').fill('会话一草稿');
    await page.locator('#rows [data-id="2"]').click();
    await expect(page.locator('#ta')).toHaveValue('');
    await page.locator('#ta').fill('会话二草稿');
    await page.locator('#rows [data-id="1"]').click();
    await expect(page.locator('#ta')).toHaveValue('会话一草稿');
    await page.locator('#rows [data-id="2"]').click();
    await expect(page.locator('#ta')).toHaveValue('会话二草稿');
  });

  await check('引用右侧打开，全文同页，加入材料发送回会话并可返回全文', async () => {
    await reset();
    await page.locator('[data-act="cite"]').first().click();
    await expect(page.locator('#R')).toBeVisible();
    await expect(page.locator('#hd h1')).toHaveText('比较检索条件');
    await expect(page.locator('#R .rh')).toContainText('第12页');
    await page.locator('[data-act="full"]').click();
    await expect(page.locator('#hd h1')).toHaveText('样例论文A');
    await expect(page.locator('#V')).toContainText('第 12 / 20 页');
    await page.locator('#V [data-act="add"]').click();
    await expect(page.locator('#chips')).toContainText('样例论文A·第12页');
    await send('解释这页检索条件');
    await expect(page.locator('#hd h1')).toHaveText('比较检索条件');
    await expect(page.locator('#thread .u').last()).toContainText('样例论文A·第12页');
    await finished();
    await page.locator('[data-act="return"]').click();
    await expect(page.locator('#V')).toContainText('第 12 / 20 页');
  });

  await check('白板加入材料发送后可回原白板，文稿编辑后往返保留', async () => {
    await reset();
    await openResource('board');
    const board = await page.locator('#V .cards').innerText();
    await page.locator('#V [data-act="add"]').first().click();
    await send('核对这张卡片');
    await expect(page.locator('#hd h1')).toHaveText('比较检索条件');
    await finished();
    await page.locator('[data-act="return"]').click();
    expect((await page.locator('#V .cards').innerText()).replace('已加入', '加入提问')).toBe(board);
    await openResource('doc');
    const draft = '手动修改后的研究笔记\n第二行草稿继续保留。';
    await page.locator('#doc').fill(draft);
    await page.locator('#V [data-act="add"]').click();
    await send('帮我检查这段研究笔记');
    await finished();
    await page.locator('[data-act="return"]').click();
    await expect(page.locator('#doc')).toHaveValue(draft);
  });

  await check('发出后切换会话，迟到回复不抢当前会话且有未读标记', async () => {
    await reset();
    await send('等待时切换到第二会话');
    await page.locator('#rows [data-id="2"]').click();
    await page.waitForTimeout(2100);
    await expect(page.locator('#hd h1')).toHaveText('补查证据');
    await expect(page.locator('#rows [data-id="1"]')).toHaveClass(/un/);
    await page.locator('#rows [data-id="1"]').click();
    await expect(page.locator('#thread .a').last()).toContainText('0.81 对 0.66');
    await expect(page.locator('#rows [data-id="1"]')).not.toHaveClass(/un/);
  });

  await check('发出后停留同会话白板，迟到回复不抢主区，查看新回复可返回', async () => {
    await reset();
    await send('等待时继续看白板');
    await openResource('board');
    await page.waitForTimeout(2100);
    await expect(page.locator('#hd h1')).toHaveText('白板');
    await expect(page.locator('#latest')).toBeVisible();
    await expect(page.locator('#rows [data-id="1"]')).toHaveClass(/un/);
    await shot('late-reply-on-board');
    await page.locator('#latest').click();
    await expect(page.locator('#hd h1')).toHaveText('比较检索条件');
    await expect(page.locator('#thread .a').last()).toContainText('0.81 对 0.66');
  });

  await check('模拟失败一轮重试，不重复用户问题，不覆盖后续草稿', async () => {
    await reset();
    await send('模拟失败：核对检索差异');
    await page.locator('#ta').fill('后续草稿');
    await finished();
    const count = await page.locator('#thread .u').count();
    await expect(page.locator('#thread .a').last()).toContainText('连接中断');
    await page.locator('[data-act="retry"]').click();
    await finished();
    expect(await page.locator('#thread .u').count()).toBe(count);
    await expect(page.locator('#thread .a').last()).toContainText('0.81 对 0.66');
    await expect(page.locator('#ta')).toHaveValue('后续草稿');
  });

  await check('助手菜单Esc/外部点击关闭，OpenCode模拟连接后可选择', async () => {
    await reset();
    await page.locator('#ab').click();
    await expect(page.locator('#menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#menu')).toBeHidden();
    await page.locator('#ab').click();
    await page.locator('#ta').click();
    await expect(page.locator('#menu')).toBeHidden();
    await page.locator('#ab').click();
    await expect(page.locator('[data-act="conn"]')).toHaveText('连接');
    await page.locator('[data-act="conn"]').click();
    await expect(page.locator('#notice')).toHaveText('示例连接已就绪');
    await page.locator('[data-act="pick"][data-n="OpenCode"]').click();
    await expect(page.locator('#ab')).toContainText('OpenCode');
  });

  await check('旧原生记录换助手建立新会话，复制原稿，原会话仍保留', async () => {
    await reset();
    await page.locator('#rows [data-id="3"]').click();
    const draft = await page.locator('#ta').inputValue();
    await page.locator('#ab').click();
    await expect(page.locator('[data-act="fork"][data-n="Claude Code"]')).toContainText('新会话');
    await page.locator('[data-act="fork"][data-n="Claude Code"]').click();
    await expect(page.locator('#ta')).toHaveValue(draft);
    await expect(page.locator('#hd h1')).toHaveText('旧 Codex 原生记录 · Claude Code');
    await expect(page.locator('#thread .u')).toHaveCount(0);
    await page.locator('#rows [data-id="3"]').click();
    await expect(page.locator('#ta')).toHaveValue(draft);
    await expect(page.locator('#thread')).toContainText('整理一张检索式对照表');
  });

  await check('收录文献入资料库且去重，白板卡片不增加', async () => {
    await reset();
    await openResource('board');
    const count = await page.locator('#V .card').count();
    await page.locator('[data-act="chat"]').click();
    await page.locator('[data-act="keep"]').first().click();
    await expect(page.locator('[data-act="keep"]').first()).toBeDisabled();
    await page.locator('[data-act="library"]').click();
    await expect(page.locator('#V .source-result')).toHaveCount(2);
    await expect(page.locator('#V')).toContainText('检索扩展的跨库对照（样例B）');
    await openResource('board');
    await expect(page.locator('#V .card')).toHaveCount(count);
    await shot('collected-library-not-board');
  });

  await check('1024px引用与回答并列，输入/发送命中且发送后保留参考', async () => {
    await reset({ width: 1024, height: 800 });
    await page.locator('[data-act="cite"]').first().click();
    await parallelReference();
    await page.locator('#R [data-act="add"]').click();
    await send('窄屏问这段材料');
    await finished();
    await expect(page.locator('#R')).toBeVisible();
    await parallelReference();
    await expect(page.locator('#thread .u').last()).toContainText('窄屏问这段材料');
    await visibleInViewport('#sb');
    await shot('sent-1024x800');
  });

  await check('900/901/1100/1101/1247/1248px引用布局边界与实际发送', async () => {
    for (const width of [900, 901, 1100, 1101, 1247, 1248]) {
      await reset({ width, height: 800 });
      await page.locator('[data-act="cite"]').first().click();
      await visibleInViewport('#R');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const main = await page.locator('#M').boundingBox();
      const reference = await page.locator('#R').boundingBox();
      const left = await page.locator('#L').boundingBox();
      if (width > 900) {
        await parallelReference();
        expect(main.width).toBeGreaterThanOrEqual(540);
        if (width < 1248) expect(left.x + left.width).toBeLessThanOrEqual(0);
        else expect(main.x).toBe(224);
      } else {
        expect(main.x + main.width).toBeGreaterThan(reference.x);
        await hitTarget('#ta');
        await hitTarget('#sb');
      }
      await shot(`reference-boundary-${width}x800`);
      await send(`布局边界${width}px发送`);
      await finished();
      await expect(page.locator('#thread .u').last()).toContainText(`布局边界${width}px发送`);
      if (width <= 900) await expect(page.locator('#R')).toBeHidden();
      else {
        await expect(page.locator('#R')).toBeVisible();
        await parallelReference();
      }
    }
  });
} finally {
  report.summary = { total: report.checks.length, passed: report.checks.filter(c => c.pass).length, failed: report.checks.filter(c => !c.pass).length };
  await writeFile(path.join(out, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  console.log(JSON.stringify(report.summary));
  if (report.summary.failed || report.errors.length || report.blockedRequests.length) process.exitCode = 1;
}
