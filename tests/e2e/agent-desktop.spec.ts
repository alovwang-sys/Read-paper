import { mockProjectService, fixtureSessionRef } from './project-fixture';
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { AgentConnection } from '../../src/domain/types';

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const capabilities = { images: false, tools: true, resume: true, permissions: 'read-only' as const };
const agents: AgentConnection[] = [
  { id: 'codex', name: 'Codex', state: 'ready', version: 'test-runtime', capabilities },
  { id: 'claude', name: 'Claude Code', state: 'needs-auth', detail: '请在本机完成 Claude Code 登录，再重新检测。', capabilities: { ...capabilities, tools: false } },
  { id: 'opencode', name: 'OpenCode', state: 'not-installed', detail: '未找到 OpenCode 本机连接组件。', capabilities: { ...capabilities, tools: false }, installation: { url: 'https://opencode.ai/v2/docs/', label: 'OpenCode 官方安装说明', command: 'npm install -g @opencode/cli' } },
];
const answer = '## 适用条件需要一起核查\n\n检索增强的效果取决于证据与当前问题的相关性。保留原文条件，才能判断结论是否适用于新的场景。 [1]\n\n- **论文依据**：本轮只使用明确加入的摘录。\n- **需要核查**：实验设置、语料范围与失败案例。\n\n| 核查项 | 本轮处理 |\n| --- | --- |\n| 直接依据 | 保留摘录与页码 |\n| 额外推断 | 单独说明适用限制 |\n\n这一回答的最后一句也完整保留，便于继续阅读和回查。';
const ndjson = (...events: object[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';
async function select(page: Page, label: string) {
  await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
  await panel(page).getByRole('button', { name: label, exact: true }).click();
}
async function setup(page: Page, withEvidence = false) {
  await mockProjectService(page);
  const calls: Record<string, unknown>[] = [];
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: true, model: 'test-model', provider: '测试', images: false, mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents } }));
  await page.route('**/api/ai/agents/run', route => {
    const request = route.request().postDataJSON(); calls.push(request);
    return route.fulfill({ contentType: 'application/x-ndjson', body: ndjson(
      { type: 'session', nativeSessionId: 'desktop-test-session', nativeSessionRef: fixtureSessionRef('desktop-test-session') },
      { type: 'progress', kind: 'tool', id: 'read-materials', toolName: 'exec_command', command: 'cat materials.md', text: '读取本次论文材料', status: 'running' },
      { type: 'progress', kind: 'tool', id: 'read-materials', toolName: 'exec_command', command: 'cat materials.md', text: '已读取本次材料', status: 'done', exitCode: 0, output: 'Selected evidence\nPDF page 3\nKeep experimental conditions and limitations.' },
      { type: 'progress', kind: 'tool', id: 'search-materials', toolName: 'exec_command', command: 'rg "baseline" materials.md', text: '当前摘录没有该关键词', status: 'error', exitCode: 1, output: 'No matching lines. Exit code: 1' },
      { type: 'progress', kind: 'permission', text: '材料以外的写入请求已拒绝；继续使用当前只读材料。' },
      { type: 'delta', text: withEvidence ? answer : answer.replace(' [1]', '') },
      { type: 'done', model: 'test-research-model', nativeSessionId: 'desktop-test-session', nativeSessionRef: fixtureSessionRef('desktop-test-session') },
    ) });
  });
  await page.goto('/'); await expect(main(page)).toBeVisible();
  if (withEvidence) {
    await main(page).getByRole('button', { name: /Adaptive Retrieval: Evidence & Reliability/ }).click();
    await expect(main(page).locator('canvas')).toBeVisible(); await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
    await panel(page).getByRole('tab', { name: '证据', exact: true }).click();
    await panel(page).locator('[data-evidence-id="evidence-a"]').getByRole('button', { name: '加入 AI', exact: true }).click();
    await page.getByRole('button', { name: '主区返回', exact: true }).click();
    await main(page).getByRole('button', { name: /检索增强的适用条件 写下结论/ }).click();
    await main(page).getByLabel('结论正文').fill('尚未完成的研究结论，等待核查原文。');
  } else await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await select(page, 'Codex');
  return calls;
}
async function ask(page: Page) {
  await panel(page).getByLabel('向 AI 提问').fill('请读取所选材料，说明这项结论成立的条件，并保留引用。');
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: '整理为卡片', exact: true })).toBeVisible();
}

test('桌面式对话完整保留Markdown，工具卡呈现真实命令、状态及输出', async ({ page }) => {
  const calls = await setup(page); await ask(page);
  const turn = panel(page).locator('.ai-turn');
  await expect(turn.getByRole('heading', { name: '适用条件需要一起核查' })).toBeVisible();
  await expect(turn.locator('.ai-answer')).toContainText('这一回答的最后一句也完整保留');
  await expect(turn.locator('.ai-answer table')).toHaveCount(1);
  await expect(panel(page).getByRole('button', { name: '切换 AI 助手', exact: true })).toHaveCount(1);
  await expect(page.locator('.xterm')).toHaveCount(0);
  await expect(panel(page).getByRole('tab', { name: '原生终端', exact: true })).toHaveCount(0);
  await turn.locator('.ai-agent-events > summary').click();
  await expect(turn.locator('.ai-tool-call')).toHaveCount(2);
  const read = turn.locator('.ai-tool-call').first();
  await expect(read.locator('summary')).toContainText('已完成');
  await read.locator('summary').click();
  await expect(read.locator('.ai-tool-exit')).toHaveText('退出码 0');
  await expect(read.locator('.ai-tool-output')).toHaveText('Selected evidence\nPDF page 3\nKeep experimental conditions and limitations.');
  await expect(turn.locator('.ai-tool-call').last().locator('summary')).toContainText('失败');
  await expect(turn.locator('.ai-execution-note.is-permission')).toContainText('写入请求已拒绝');
  expect(calls).toHaveLength(1); expect(calls[0].connectionId).toBe('codex');
  const question = (await turn.locator('.ai-user-message').boundingBox())!; const reply = (await turn.locator('.ai-answer').boundingBox())!;
  expect(question.x).toBeGreaterThan(reply.x);
  await panel(page).getByRole('log', { name: '对话消息' }).evaluate(element => { element.scrollTop = 0; });
  const notice = page.getByRole('button', { name: '关闭提示', exact: true }); if (await notice.isVisible()) await notice.click();
  await mkdir('docs/verification/agents', { recursive: true });
  await page.screenshot({ path: 'docs/verification/agents/desktop-chat-tools.png' });
});

test('未安装助手提供官方安装入口与命令复制，需登录状态保留真实说明', async ({ page }) => {
  const calls = await setup(page); await select(page, 'OpenCode');
  const connection = panel(page).locator('.ai-connection');
  await expect(connection).toContainText('本机运行时连接组件');
  const link = connection.getByRole('link', { name: 'OpenCode 官方安装说明', exact: true });
  await expect(link).toHaveAttribute('href', 'https://opencode.ai/v2/docs/');
  await expect(link).toHaveAttribute('target', '_blank'); await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await connection.getByRole('button', { name: '复制安装命令', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('npm install -g @opencode/cli');
  expect(calls).toHaveLength(0);
  await mkdir('docs/verification/agents', { recursive: true });
  const notice = page.getByRole('button', { name: '关闭提示', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.screenshot({ path: 'docs/verification/agents/desktop-chat-install.png' });
  await select(page, 'Claude Code'); await expect(connection).toContainText('本机完成 Claude Code 登录');
  await expect(connection.getByRole('link')).toHaveCount(0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`桌面对话引用打开中央PDF，保留消息和输入 ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport); await setup(page, true); await ask(page);
    await panel(page).getByLabel('向 AI 提问').fill('下一条尚未发送的问题');
    const settings = panel(page).locator('.ai-context-settings');
    await expect(settings).not.toHaveAttribute('open', '');
    await expect(settings.locator(':scope > summary')).toHaveText('对话范围 · 前序 1 轮 · Agent 已发 1 条材料');
    const turn = panel(page).locator('.ai-turn');
    await turn.getByRole('button', { name: /^引用 1：/ }).click();
    await expect(main(page).getByRole('region', { name: 'PDF 阅读器 主区' })).toBeVisible();
    await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
    await expect(turn.locator('.ai-answer')).toContainText('检索增强的效果取决于证据');
    await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('下一条尚未发送的问题');
    await panel(page).getByRole('log', { name: '对话消息' }).evaluate(element => { element.scrollTop = 0; });
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    const pdf = (await main(page).locator('canvas').boundingBox())!; const right = (await panel(page).boundingBox())!;
    expect(pdf.x + pdf.width).toBeLessThanOrEqual(right.x + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await mkdir('docs/verification/agents', { recursive: true });
    const notice = page.getByRole('button', { name: '关闭提示', exact: true }); if (await notice.isVisible()) await notice.click();
    await page.screenshot({ path: `docs/verification/agents/desktop-chat-${viewport.width}.png` });
    await page.reload();
    await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('下一条尚未发送的问题');
    await expect(panel(page).locator('.ai-answer')).toContainText('这一回答的最后一句也完整保留');
  });
}
