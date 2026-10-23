import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const origin = 'http://127.0.0.1:5173';
const url = `${origin}/docs/agent-native-evolution/conversation-redesign/workspace-preview.html`;
const out = fileURLToPath(new URL('./verification/workspace-preview/', import.meta.url));
await mkdir(out, { recursive: true });
const report = { date: new Date().toISOString(), url, scope: '隔离布局预览；回答为定时合成，PDF与分屏为示意；Excalidraw为真实本地编辑实例', checks: [], errors: [], blockedRequests: [], screenshots: [], measurements: {} };
const sourceHashes = async () => Object.fromEntries(await Promise.all(['workspace-preview.html', 'workspace-preview.jsx', 'workspace-preview.css', 'workspace-preview-board.jsx', 'workspace-preview-board.css', 'workspace-conversation-picker.jsx'].map(async file => [file, createHash('sha256').update(await readFile(new URL(`./${file}`, import.meta.url))).digest('hex')])));
report.sourceHashes = await sourceHashes();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/*', route => {
  const request = new URL(route.request().url());
  if (request.origin === origin) return route.continue();
  report.blockedRequests.push(request.href);
  return route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(5000);
page.on('pageerror', error => report.errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && /ResizeObserver/i.test(message.text())) report.errors.push(message.text()); });
const input = () => page.getByRole('textbox', { name: '输入消息', exact: true });
const reset = async (width = 1440, height = 900) => {
  await page.setViewportSize({ width, height });
  await page.goto(url);
  await expect(input()).toBeVisible();
  await expect(page.getByRole('radio', { name: '矩形', exact: true })).toBeAttached();
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
const hitTarget = async locator => {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox(), view = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height + 1);
  expect(await locator.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return target === node || node.contains(target);
  })).toBe(true);
};
const tab = async name => {
  const locator = page.getByRole('tab', { name, exact: true });
  if (await locator.count()) await locator.first().click();
  else await sidebar(name);
};
const sidebar = async name => {
  const button = page.locator('.sidebar-bottom').getByRole('button', { name, exact: true });
  if ((await button.boundingBox()).x < 0) await page.getByRole('button', { name: '展开导航', exact: true }).click();
  await button.click();
};
const provider = async name => {
  await page.locator('.composer .pill').click();
  await page.locator('.menu-row').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) }).click();
};
const send = async text => {
  await input().fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
};
const finished = () => expect(page.getByRole('button', { name: '停止回答', exact: true })).toHaveCount(0, { timeout: 5000 });
const openPicker = async () => {
  await page.getByRole('button', { name: '选择会话', exact: true }).click();
  await expect(page.locator('.conversation-picker')).toBeVisible();
};
const pickConversation = async (id, carry) => {
  await openPicker();
  const checkbox = page.getByRole('checkbox', { name: '带上当前选区', exact: true });
  if (carry !== undefined && await checkbox.count()) await checkbox.setChecked(carry);
  await page.locator(`[data-conversation-id="${id}"]`).click();
};
const localPDF = async () => {
  await tab('样例论文A');
  const text = '样例结果：B的召回更高，但同义词扩展也是变化因素，不能只据此推断证据更可靠。';
  const mark = page.locator('.paper-copy mark');
  await mark.scrollIntoViewIfNeeded();
  const points = await mark.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes=[];
    let node; while ((node=walker.nextNode())) nodes.push(node);
    const a=document.createRange(),b=document.createRange(),first=nodes[0],last=nodes.at(-1);
    a.setStart(first,0);a.setEnd(first,1);b.setStart(last,last.length-1);b.setEnd(last,last.length);
    const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();
    return {x1:ar.left+.2,y1:ar.top+ar.height/2,x2:br.right-.2,y2:br.top+br.height/2};
  });
  await page.mouse.move(points.x1,points.y1); await page.mouse.down();
  await page.mouse.move(points.x2,points.y2,{steps:14}); await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>getSelection().toString().trim())).toBe(text);
  const source = await page.evaluate(()=>{const r=getSelection().getRangeAt(0).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}});
  await page.getByRole('dialog',{name:'选区操作',exact:true}).getByRole('button',{name:'提问',exact:true}).click();
  await expect(page.locator('.chat')).toBeVisible();
  return source;
};
const drawRectangle = async (x, y, width, height) => {
  await page.getByRole('radio', { name: '矩形', exact: true }).locator('..').click();
  const box = await page.getByTestId('workspace-board').boundingBox();
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + width, box.y + y + height, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('ask-board-selection')).toContainText('1 项');
};
const toolbarReady = async (stage, requireHit = true) => {
  report.measurements.toolbar ??= {};
  await expect.poll(async () => {
    const state = await page.getByTestId('workspace-board').evaluate(board => {
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const host = rect(board), inputs = [...board.querySelectorAll('input[type="radio"]')];
      const tools = ['选择', '矩形', '箭头', '自由书写', '文字', '橡皮'].map(name => {
        const input = inputs.find(node => node.getAttribute('aria-label') === name), label = input?.closest('label');
        if (!label) return { name, inside: false, hit: false };
        const box = rect(label), target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { name, box, hit: target === label || label.contains(target), inside: box.x >= host.x - .5 && box.y >= host.y - .5 && box.x + box.width <= host.x + host.width + .5 && box.y + box.height <= host.y + host.height + .5 };
      });
      return { host, tools };
    });
    report.measurements.toolbar[stage] = { ...state, pointerRequired: requireHit };
    return state.tools.every(tool => tool.inside && (!requireHit || tool.hit));
  }, { timeout: 5000, message: `${stage}: six native labels stay inside the board${requireHit ? ' and receive pointer hits' : ''}` }).toBe(true);
  await expect(page.getByTestId('ask-board-selection')).toContainText('1 项');
};

try {
  await check('三尺寸：唯一输入、权限/语音/发送命中、无页面横向溢出', async () => {
    for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
      await reset(width, height);
      await expect(input()).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const locator of [input(), page.getByRole('button', { name: '查看当前权限', exact: true }), page.locator('.composer .voice'), page.getByRole('button', { name: '发送', exact: true })]) await hitTarget(locator);
      const main = await page.locator('.main').boundingBox(), chat = await page.locator('.chat-side').boundingBox();
      expect(main.x + main.width).toBeLessThanOrEqual(chat.x + 1);
      report.measurements[`${width}x${height}`] = { main, chat };
      if (width !== 1280) await shot(`workspace-${width}x${height}`);
    }
  });

  await check('研究资料A/全局A+B，浏览不关联，显式加入后本研究可见', async () => {
    await reset();
    await sidebar('研究资料');
    await expect(page.locator('.library-row')).toHaveCount(1);
    await expect(page.locator('.library-row')).toContainText('样例论文A');
    await sidebar('全局资料库');
    await expect(page.locator('.library-row')).toHaveCount(2);
    await expect(input()).toHaveCount(0);
    await shot('global-library');
    await page.getByRole('button', { name: '返回研究', exact: true }).click();
    await expect(page.locator('.library-row')).toHaveCount(1);
    await sidebar('全局资料库');
    await page.getByRole('button', { name: '加入本研究', exact: true }).click();
    await page.getByRole('button', { name: '返回研究', exact: true }).click();
    await expect(page.locator('.library-row')).toHaveCount(2);
    await expect(page.locator('.library-row').last()).toContainText('样例论文B');
  });

  await check('权限反映Codex研究工具/Claude文字问答，无假三档选项', async () => {
    await reset();
    await page.getByRole('button', { name: '查看当前权限', exact: true }).click();
    await expect(page.locator('.popover')).toContainText('研究工具权限');
    await expect(page.locator('.popover')).toContainText('读取研究资料、检索公开文献、生成草稿');
    await expect(page.locator('.popover input,.popover select')).toHaveCount(0);
    const permission = await page.locator('.permission').boundingBox(), popup = await page.locator('.popover').boundingBox();
    expect(popup.y + popup.height).toBeLessThanOrEqual(permission.y);
    expect(await page.locator('.popup-backdrop').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await page.getByRole('button', { name: '关闭选项', exact: true }).click();
    await provider('Claude Code');
    await expect(page.locator('.permission')).toHaveText('文字问答');
    await page.getByRole('button', { name: '查看当前权限', exact: true }).click();
    await expect(page.locator('.popover')).toContainText('仅发送明确提供的文字材料');
    await expect(page.locator('.popover')).toContainText('未开放文件工具或可调文件权限');
    await expect(page.locator('.popover input,.popover select')).toHaveCount(0);
  });

  await check('语音示例仅追加草稿，不自动发送或切换资源', async () => {
    await reset();
    const count = await page.locator('.message').count();
    await input().fill('手动起草');
    await page.locator('.composer .voice').click();
    await expect(page.locator('.popover')).toContainText('不录音或上传音频');
    await page.getByRole('button', { name: '放入一段示例听写文字', exact: true }).click();
    await expect(input()).toHaveValue('手动起草\n请核对这部分检索条件。');
    await expect(page.locator('.message')).toHaveCount(count);
    await expect(page.locator('.resource-tabs .active')).toHaveText('研究白板');
  });

  await check('侧边/浮窗/主聊天移位保同会话草稿，连续键入保持焦点', async () => {
    await reset();
    const title = await page.locator('.chat-head strong').innerText();
    const count = await page.locator('.sidebar nav button').count();
    await input().click();
    await input().pressSequentially('连续输入 ABC 123', { delay: 20 });
    await expect(input()).toHaveValue('连续输入 ABC 123');
    await expect(input()).toBeFocused();
    await page.getByRole('button', { name: '浮窗继续', exact: true }).click();
    await expect(page.locator('.chat-float')).toBeVisible();
    await expect(input()).toHaveValue('连续输入 ABC 123');
    await input().click();
    await input().pressSequentially('再输入 DEF', { delay: 20 });
    await expect(input()).toHaveValue('连续输入 ABC 123再输入 DEF');
    await expect(input()).toBeFocused();
    const before = await page.locator('.chat-float').boundingBox();
    const dragLabel = await page.locator('.chat-float .eyebrow').boundingBox();
    await page.mouse.move(dragLabel.x + 8, dragLabel.y + 4);
    await page.mouse.down();
    await page.mouse.move(dragLabel.x - 72, dragLabel.y - 104, { steps: 5 });
    await page.mouse.up();
    const after = await page.locator('.chat-float').boundingBox();
    expect(after.x).toBeLessThan(before.x);
    expect(after.y).toBeGreaterThanOrEqual(64);
    await page.getByRole('button', { name: '展开完整对话', exact: true }).click();
    await expect(page.locator('.chat-main')).toBeVisible();
    await expect(input()).toHaveValue('连续输入 ABC 123再输入 DEF');
    await input().click();
    await input().press('End');
    await input().pressSequentially('主聊天继续', { delay: 20 });
    await expect(input()).toBeFocused();
    await expect(input()).toHaveCount(1);
    await expect(page.locator('.chat-head strong')).toHaveText(title);
    await tab('研究白板');
    await expect(page.locator('.chat-side')).toBeVisible();
    await expect(input()).toHaveValue('连续输入 ABC 123再输入 DEF主聊天继续');
    await expect(page.locator('.sidebar nav button')).toHaveCount(count);
  });

  await check('资源旁发送不跳页，回答留侧边，已发输入清空', async () => {
    await reset();
    await tab('样例论文A');
    await send('核对原文这部分的条件');
    await expect(input()).toHaveValue('');
    await expect(page.locator('.resource-tabs .active')).toHaveText('样例论文A');
    await expect(page.locator('.chat-side')).toBeVisible();
    await finished();
    await expect(page.locator('.message.assistant').last()).toContainText('示例回答');
    await expect(page.locator('.resource-tabs .active')).toHaveText('样例论文A');
    await shot('pdf-side-answer');
  });

  await check('PDF真实选文提问建立具名局部会话，侧边继续保持同会话', async () => {
    await reset();
    const count = await page.locator('.sidebar nav button').count();
    const sourceMark = await localPDF();
    const title = '样例结果：B的召回更高，但同义词… · p12';
    await expect(page.locator('.chat-head strong')).toHaveText(title);
    await expect(page.locator('.sidebar nav button')).toHaveCount(count + 1);
    await expect(page.locator('.sidebar nav button.selected')).toHaveText(title);
    await expect(page.locator('.material')).toHaveCount(1);
    const float = await page.locator('.chat-float').boundingBox();
    expect(float.x + float.width <= sourceMark.x || float.x >= sourceMark.x + sourceMark.width || float.y + float.height <= sourceMark.y || float.y >= sourceMark.y + sourceMark.height, 'floating chat does not cover the selected original text').toBe(true);
    await input().fill('围绕这段继续问');
    await shot('pdf-local-float');
    await page.getByRole('button', { name: '在侧边继续', exact: true }).click();
    await expect(page.locator('.chat-side')).toBeVisible();
    await expect(page.locator('.chat-head strong')).toHaveText(title);
    await expect(page.locator('.sidebar nav button')).toHaveCount(count + 1);
    await expect(input()).toHaveValue('围绕这段继续问');
    await expect(page.locator('.material')).toHaveCount(1);
  });

  await check('关闭进行中浮窗不停止，完成后列表未读，不抢当前资源', async () => {
    await reset();
    await localPDF();
    await send('关闭窗口后继续处理');
    await page.getByRole('button', { name: '关闭聊天', exact: true }).click();
    await expect(page.locator('.chat')).toHaveCount(0);
    await expect(page.locator('.sidebar nav button.selected i')).toHaveCount(1, { timeout: 6000 });
    await expect(page.locator('.resource-tabs .active')).toHaveText('样例论文A');
    await expect(page.locator('.sidebar nav button.selected i')).toHaveCount(1);
    await shot('closed-float-unread');
    await page.locator('.sidebar nav button.selected').click();
    await expect(page.locator('.chat-side')).toBeVisible();
    await expect(page.locator('.message.assistant').last()).toContainText('示例回答');
    await expect(page.locator('.sidebar nav button.selected i')).toHaveCount(0);
  });

  await check('双页独立页码，1024主动放大/恢复保持各页位置', async () => {
    await reset(1024, 800);
    await tab('样例论文A');
    await page.getByRole('button', { name: '分屏', exact: true }).click();
    await expect(page.locator('.paper-controls').first()).toContainText('第 12 / 20 页');
    await expect(page.locator('.paper-controls').last()).toContainText('第 12 / 20 页');
    const first = page.locator('.resource-pane').first(), second = page.locator('.resource-pane').last();
    await first.getByRole('button', { name: '下一页', exact: true }).click();
    await second.getByRole('button', { name: '上一页', exact: true }).click();
    await expect(page.locator('.paper-controls').first()).toContainText('第 13 / 20 页');
    await expect(page.locator('.paper-controls').last()).toContainText('第 11 / 20 页');
    await first.getByRole('button', { name: '放大当前页', exact: true }).click();
    await expect(page.locator('.resource-pane:not([hidden])')).toHaveCount(1);
    await expect(page.locator('.resource-pane:not([hidden]) .paper-controls')).toContainText('第 13 / 20 页');
    await expect(input()).toHaveCount(1);
    await shot('split-1024-maximized');
    await page.getByRole('button', { name: '恢复分屏', exact: true }).first().click();
    await expect(page.locator('.resource-pane:not([hidden])')).toHaveCount(2);
    await expect(page.locator('.paper-controls').first()).toContainText('第 13 / 20 页');
    await expect(page.locator('.paper-controls').last()).toContainText('第 11 / 20 页');
    await second.getByRole('button', { name: '放大当前页', exact: true }).click();
    await expect(page.locator('.resource-pane:not([hidden]) .paper-controls')).toContainText('第 11 / 20 页');
    await reset(1157, 800);
    await tab('样例论文A');
    await page.getByRole('button', { name: '分屏', exact: true }).click();
    const left = await page.locator('.sidebar').boundingBox();
    expect(left.x + left.width).toBeLessThanOrEqual(0);
    const widths = await page.locator('.resource-pane').evaluateAll(panes => panes.map(pane => pane.getBoundingClientRect().width));
    expect(widths).toHaveLength(2);
    expect(widths.every(width => width >= 320)).toBe(true);
    await hitTarget(input());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    report.measurements['1157pxSplit'] = widths;
  });

  await check('原生画布绘制矩形→问所选→局部PNG快照，改选不扩大材料', async () => {
    await reset();
    await drawRectangle(480, 540, 180, 100);
    await page.getByTestId('ask-board-selection').click();
    await expect(page.locator('.chat')).toBeVisible();
    await expect(input()).toHaveCount(1);
    await expect(page.locator('.material')).toHaveCount(1);
    await page.locator('.material button').first().click();
    const dimensions = await page.locator('.selection-preview').evaluate(async img => { await img.decode(); return { width: img.naturalWidth, height: img.naturalHeight, src: img.src }; });
    expect(dimensions.width).toBeGreaterThan(100);
    expect(dimensions.width).toBeLessThan(400);
    expect(dimensions.height).toBeGreaterThan(50);
    expect(dimensions.height).toBeLessThan(300);
    await expect(page.locator('.popover pre')).toContainText('所选内容是图形或手绘');
    await expect(page.locator('.popover pre')).not.toContainText('同义词扩展更敏感');
    report.measurements.boardSelection = { width: dimensions.width, height: dimensions.height };
    await shot('board-selection-snapshot');
    await page.getByRole('button', { name: '关闭选项', exact: true }).click();
    await drawRectangle(300, 560, 100, 60);
    await expect(page.locator('.material')).toHaveCount(1);
    await page.locator('.material button').first().click();
    await expect(page.locator('.selection-preview')).toHaveAttribute('src', dimensions.src);
    await expect(page.locator('.popover pre')).not.toContainText('同义词扩展更敏感');
  });

  await check('Claude含图阻止示例发送，保留草稿与材料', async () => {
    await reset();
    await drawRectangle(480, 540, 180, 100);
    await page.getByTestId('ask-board-selection').click();
    await expect(page.locator('.material')).toHaveCount(1);
    await provider('Claude Code');
    const count = await page.locator('.message').count();
    await send('分析这张局部图片');
    await expect(page.getByRole('status')).toContainText('仅支持文字');
    await expect(input()).toHaveValue('分析这张局部图片');
    await expect(page.locator('.material')).toHaveCount(1);
    await expect(page.locator('.message')).toHaveCount(count);
    await expect(page.getByRole('button', { name: '停止回答', exact: true })).toHaveCount(0);
  });

  await check('会话菜单可搜索，所有聊天host可打开，新建保资源/host且只有一处输入', async () => {
    await reset();
    await openPicker();
    await expect(page.locator('.picker-caption').first()).toHaveText('最近会话');
    await page.getByRole('textbox', { name: '搜索本研究会话', exact: true }).fill('补查');
    await expect(page.locator('.conversation-choice')).toHaveCount(1);
    await expect(page.locator('.conversation-choice')).toContainText('补查证据');
    await expect(page.locator('.chat-head strong')).toHaveText('比较检索条件');
    await page.getByRole('textbox', { name: '搜索本研究会话', exact: true }).fill('没有这个标题');
    await expect(page.locator('.picker-none')).toHaveText('没有匹配的会话');
    await page.getByRole('button', { name: '关闭选项', exact: true }).click();
    await page.getByRole('button', { name: '浮窗继续', exact: true }).click();
    await openPicker();
    await page.locator('.picker-new').click();
    await expect(page.locator('.chat-float')).toBeVisible();
    await expect(page.locator('.chat-head strong')).toHaveText('新会话');
    await expect(input()).toHaveValue('');
    await expect(input()).toHaveCount(1);
    await expect(page.locator('.resource-tabs .active')).toHaveText('研究白板');
    await expect(page.locator('.message')).toHaveCount(0);
    await page.getByRole('button', { name: '展开完整对话', exact: true }).click();
    await openPicker();
    await expect(page.getByRole('textbox', { name: '搜索本研究会话', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '关闭选项', exact: true }).click();
    await expect(input()).toHaveCount(1);
  });

  await check('菜单A/B切换各自恢复草稿，新会话为空且原稿/旧消息保留', async () => {
    await reset();
    await input().fill('A 未发送草稿');
    await pickConversation(2);
    await expect(input()).toHaveValue('对照条件还缺哪些？');
    await expect(page.locator('.message')).toHaveCount(0);
    await input().fill('B 未发送草稿');
    await pickConversation(1);
    await expect(input()).toHaveValue('A 未发送草稿');
    await expect(page.locator('.message')).toHaveCount(2);
    await openPicker();
    await page.locator('.picker-new').click();
    await expect(input()).toHaveValue('');
    await expect(page.locator('.chat-side')).toBeVisible();
    await pickConversation(1);
    await expect(input()).toHaveValue('A 未发送草稿');
    await expect(page.locator('.message')).toHaveCount(2);
    await pickConversation(2);
    await expect(input()).toHaveValue('B 未发送草稿');
    await expect(page.locator('.message')).toHaveCount(0);
  });

  await check('选区携带可取消，启用复制快照并去重，不搬运旧消息', async () => {
    await reset();
    await localPDF();
    await expect(page.locator('.material')).toHaveCount(1);
    await pickConversation(2, false);
    await expect(page.locator('.material')).toHaveCount(0);
    await pickConversation(3);
    await expect(page.locator('.material')).toHaveCount(1);
    await pickConversation(2, true);
    await expect(page.locator('.material')).toHaveCount(1);
    await expect(page.locator('.message')).toHaveCount(0);
    await pickConversation(3, true);
    await expect(page.locator('.material')).toHaveCount(1);
    await pickConversation(2, true);
    await expect(page.locator('.material')).toHaveCount(1);
    await pickConversation(1, true);
    await expect(page.locator('.material')).toHaveCount(1);
    await expect(page.locator('.message')).toHaveCount(2);
    await page.locator('.material button').first().click();
    await expect(page.locator('.popover pre')).toHaveText('样例结果：B的召回更高，但同义词扩展也是变化因素，不能只据此推断证据更可靠。');
  });

  await check('在途A通过菜单切B，迟到回答只归A且不覆盖B草稿', async () => {
    await reset();
    await send('A 在途核查任务');
    await pickConversation(2);
    await expect(input()).toHaveValue('对照条件还缺哪些？');
    await input().fill('B 当前草稿');
    await page.waitForTimeout(1600);
    await expect(page.locator('.chat-head strong')).toHaveText('补查证据');
    await expect(page.locator('.message')).toHaveCount(0);
    await expect(input()).toHaveValue('B 当前草稿');
    await expect(page.locator('.sidebar nav button').filter({ hasText: '比较检索条件' }).locator('i')).toHaveCount(1);
    await pickConversation(1);
    await expect(page.locator('.message.user').last()).toContainText('A 在途核查任务');
    await expect(page.locator('.message.assistant').last()).toContainText('示例回答');
    await pickConversation(2);
    await expect(input()).toHaveValue('B 当前草稿');
    await expect(page.locator('.message')).toHaveCount(0);
  });

  await check('推荐阈值/同研究过滤/材料去重键断言，实际相关菜单最多3条且不自动切换', async () => {
    await reset();
    const ranked = await page.evaluate(async () => {
      const { rankConversations, materialKey } = await import('/docs/agent-native-evolution/conversation-redesign/workspace-conversation-picker.jsx');
      const current = { id: 1, researchId: 'r1', title: 'current', draft: '', messages: [] };
      const conversations = [current,
        { id: 2, researchId: 'r1', title: 'unrelated', messages: [{ text: '', context: [{ documentId: 'source-a' }] }] },
        { id: 3, researchId: 'r1', title: 'alpha gamma', messages: [] },
        { id: 4, researchId: 'r1', title: 'alpha beta', messages: [] },
        { id: 5, researchId: 'r2', title: 'alpha beta', messages: [{ text: '', context: [{ documentId: 'source-a' }] }] }];
      const values = rankConversations(conversations, current, [{ title: 'alpha beta', text: '', documentId: 'source-a' }]);
      const sameKey = materialKey({ id: 1, title: '选区', text: '快照', elementIds: ['b', 'a'] }) === materialKey({ id: 2, title: '选区', text: '快照', elementIds: ['a', 'b'] });
      const changedTextDiffers = materialKey({ title: '选区', text: '快照1' }) !== materialKey({ title: '选区', text: '快照2' });
      return { rows: values.map(({ id, related }) => ({ id, related })), sameKey, changedTextDiffers };
    });
    expect(ranked.rows.filter(row => row.related).map(row => row.id)).toEqual([2, 4]);
    expect(ranked.rows.find(row => row.id === 3).related).toBe(false);
    expect(ranked.rows.some(row => row.id === 1 || row.id === 5)).toBe(false);
    expect(ranked.sameKey).toBe(true);
    expect(ranked.changedTextDiffers).toBe(true);
    report.measurements.recommendations = ranked;
    await localPDF();
    await pickConversation(2, true);
    await send('核查这篇论文的检索条件');
    await finished();
    await pickConversation(3);
    const title = await page.locator('.chat-head strong').innerText();
    await openPicker();
    await expect(page.locator('.picker-caption').first()).toHaveText('相关会话');
    await expect(page.locator('[data-conversation-id="2"]')).toBeVisible();
    const relatedCount = await page.locator('.picker-caption').first().evaluate(caption => {
      let node = caption.nextElementSibling, count = 0;
      while (node && !node.classList.contains('picker-caption')) { if (node.classList.contains('conversation-choice')) count++; node = node.nextElementSibling; }
      return count;
    });
    expect(relatedCount).toBeLessThanOrEqual(3);
    expect(relatedCount).toBeGreaterThan(0);
    await expect(page.locator('.chat-head strong')).toHaveText(title);
    await shot('conversation-picker-related');
  });

  await check('连续容器resize后六个原生工具完整可点，原场景选区可继续且无observer错误', async () => {
    await reset();
    await drawRectangle(480, 540, 180, 100);
    await toolbarReady('1440-board-side');
    await page.getByRole('button', { name: '分屏', exact: true }).click();
    await toolbarReady('1440-split-side');
    await shot('final-tabs-responsive-1440');
    await page.setViewportSize({ width: 1157, height: 800 });
    await toolbarReady('1157-split-side');
    await page.setViewportSize({ width: 1024, height: 800 });
    await toolbarReady('1024-split-side');
    await page.getByRole('button', { name: '关闭聊天', exact: true }).click();
    await toolbarReady('1024-split-chat-closed');
    await page.getByRole('button', { name: '聊天', exact: true }).click();
    await toolbarReady('1024-split-side-reopened');
    await page.getByRole('button', { name: '浮窗继续', exact: true }).click();
    await toolbarReady('1024-split-float', false);
    await page.getByRole('button', { name: '关闭聊天', exact: true }).click();
    await toolbarReady('1024-split-float-closed');
    await page.getByRole('button', { name: '聊天', exact: true }).click();
    await toolbarReady('1024-split-side-restored');
    await shot('final-tabs-responsive-1024');
    await page.getByTestId('ask-board-selection').click();
    await expect(page.locator('.material')).toHaveCount(1);
    await page.locator('.material button').first().click();
    const size = await page.locator('.selection-preview').evaluate(async img => { await img.decode(); return { width: img.naturalWidth, height: img.naturalHeight }; });
    expect(size).toEqual({ width: 262, height: 160 });
    report.measurements.resizedSelection = size;
  });
} finally {
  report.summary = { total: report.checks.length, passed: report.checks.filter(check => check.pass).length, failed: report.checks.filter(check => !check.pass).length };
  report.endSourceHashes = await sourceHashes();
  report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(report.endSourceHashes);
  await writeFile(path.join(out, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  console.log(JSON.stringify({ ...report.summary, errors: report.errors.length, blockedRequests: report.blockedRequests.length, sourceStable: report.sourceStable }));
  if (report.summary.failed || report.errors.length || !report.sourceStable) process.exitCode = 1;
}
