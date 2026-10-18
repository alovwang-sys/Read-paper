import { openResearchPage } from './knowledge-helpers';
import { mockProjectService, fixtureSessionRef } from './project-fixture';
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { AgentConnection, WorkspaceData } from '../../src/domain/types';

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const capabilities = { images: false, tools: true, resume: true, permissions: 'read-only' as const };
const agents: AgentConnection[] = [
  { id: 'codex', name: 'Codex', state: 'ready', version: 'codex-cli 0.114.0', capabilities },
  { id: 'claude', name: 'Claude Code', state: 'needs-auth', version: '2.1.0', detail: '请在本机终端登录 Claude Code，再重新连接。', capabilities },
  { id: 'opencode', name: 'OpenCode', state: 'not-installed', detail: '尚未安装 OpenCode。安装后重新检查。', capabilities },
];
async function state(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const journal = localStorage.getItem('papertrail-recovery-v3');
    if (journal) return JSON.parse(journal);
    const modulePath = '/src/data/storage.ts';
    return (await import(modulePath)).loadWorkspace();
  });
}
async function select(page: Page, label: string) {
  await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
  await panel(page).getByRole('button', { name: label, exact: true }).click();
}
async function start(page: Page) {
  await mockProjectService(page);
  await page.route('**/api/ai/config', route => route.fulfill({ json: {
    configured: false, model: '测试模型', provider: '测试', images: true, mode: 'live',
    limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 },
  } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents } }));
  await page.route('**/api/ai/agents/stop', route => route.fulfill({ json: { stopped: true } }));
  await page.goto('/');
  await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible();
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: '切换 AI 助手', exact: true })).toBeVisible();
}
const ndjson = (...events: object[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';

test('助手状态、独立输入、重连、刷新与干净会话', async ({ page }) => {
  let nativeCalls = 0;
  await page.route('**/api/ai/agents/run', route => { nativeCalls++; return route.fulfill({ status: 500, body: '' }); });
  await start(page);
  await panel(page).getByLabel('向 AI 提问').fill('模型直连尚未发送的问题');
  const modelId = Object.values((await state(page)).conversations).find(item => item.researchId === 'research-a')!.id;
  await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
  const picker = panel(page).getByRole('dialog', { name: '选择 AI 助手' });
  await expect(picker.getByRole('button', { name: 'Codex', exact: true })).toContainText('就绪');
  await expect(picker.getByRole('button', { name: 'Codex', exact: true })).toContainText('codex-cli 0.114.0');
  await expect(picker.getByRole('button', { name: 'Codex', exact: true })).toContainText('只读工具');
  await expect(picker.getByRole('button', { name: 'Claude Code', exact: true })).toContainText('需登录');
  await expect(picker.getByRole('button', { name: 'OpenCode', exact: true })).toContainText('未安装');
  await picker.getByRole('button', { name: 'Claude Code', exact: true }).click();
  await panel(page).getByLabel('向 AI 提问').fill('Claude 保留的未发输入');
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
  await expect(panel(page).locator('.ai-connection')).toContainText('本机终端登录');
  await select(page, 'Codex');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('');
  await panel(page).getByLabel('向 AI 提问').fill('Codex 的未发输入');
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeEnabled();
  await select(page, 'Claude Code');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('Claude 保留的未发输入');
  await select(page, '模型直连');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('模型直连尚未发送的问题');
  expect((await state(page)).sessions['research-a'].activeConversationId).toBe(modelId);
  await select(page, 'Codex');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.reload();
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('Codex 的未发输入');
  await page.route('**/api/ai/agents', route => route.abort('connectionrefused'));
  await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
  await panel(page).getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(panel(page).getByRole('dialog')).toContainText('无法连接本机 Agent 服务');
  await page.keyboard.press('Escape');
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents } }));
  await panel(page).getByRole('button', { name: '重新连接助手', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeEnabled();
  const oldId = (await state(page)).sessions['research-a'].activeConversationId!;
  await panel(page).getByRole('button', { name: '新建干净对话', exact: true }).click();
  const data = await state(page), clean = data.conversations[data.sessions['research-a'].activeConversationId!];
  expect(clean).toMatchObject({ connectionId: 'codex', input: '', requestIds: [], contextIds: [] });
  expect(data.conversations[oldId].input).toBe('Codex 的未发输入');
  expect(nativeCalls).toBe(0);
});

test('生成中切换助手、后台归属、停止及权限拒绝不回退', async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: Record<string, unknown>[] = [];
  let deny = false;
  await page.route('**/api/ai/agents/run', async route => {
    const body = route.request().postDataJSON(); calls.push(body);
    if (!deny) await gate;
    await route.fulfill({ contentType: 'application/x-ndjson', body: deny
      ? ndjson({ type: 'progress', kind: 'permission', text: '拒绝写入文件：当前助手为只读模式。' }, { type: 'error', error: '权限拒绝，已保留输入与原始记录。' })
      : ndjson({ type: 'session', nativeSessionId: 'codex-session-test', nativeSessionRef: fixtureSessionRef('codex-session-test') }, { type: 'delta', text: 'Codex 的独立回答。' }, { type: 'done', model: 'Codex', nativeSessionId: 'codex-session-test', nativeSessionRef: fixtureSessionRef('codex-session-test') }),
    }).catch(() => {});
  });
  await start(page);
  await select(page, 'Codex');
  await panel(page).getByLabel('向 AI 提问').fill('请解释研究材料');
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  const codexId = (await state(page)).sessions['research-a'].activeConversationId!;
  await panel(page).getByLabel('向 AI 提问').fill('生成期间写下的下一问');
  await select(page, '演示模式');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('');
  await expect(panel(page).locator('.ai-background-tasks')).toContainText('1 个任务');
  await panel(page).getByRole('button', { name: '查看会话历史', exact: true }).click();
  await expect(panel(page).locator('.ai-history-item').filter({ hasText: 'Codex' })).toContainText('运行中');
  await panel(page).getByRole('button', { name: '返回当前对话', exact: true }).click();
  await select(page, 'Codex');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('生成期间写下的下一问');
  await panel(page).getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(panel(page).getByRole('alert').filter({ hasText: '已停止' })).toBeVisible();
  release();
  await expect.poll(async () => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({ connectionId: 'codex', conversationId: codexId, researchId: 'research-a' });
  expect(Object.values((await state(page)).requests)[0].status).toBe('stopped');
  deny = true;
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(panel(page).getByRole('alert').filter({ hasText: '权限拒绝' })).toBeVisible();
  await panel(page).getByText('执行过程 · 1', { exact: true }).click();
  await expect(panel(page).locator('.ai-agent-events')).toContainText('拒绝写入文件');
  await expect(panel(page).getByRole('button', { name: '切换 AI 助手' })).toContainText('Codex');
  await mkdir('docs/verification/agents', { recursive: true });
  await page.screenshot({ path: 'docs/verification/agents/permission-denied.png' });
});

test('显式材料、原生累计提示与收缩前序范围', async ({ page }) => {
  const calls: { context: { evidenceId: string }[]; history: unknown[]; reset: boolean }[] = [];
  await page.route('**/api/ai/agents/run', route => {
    const body = route.request().postDataJSON(); calls.push(body);
    return route.fulfill({ contentType: 'application/x-ndjson', body: ndjson(
      { type: 'session', nativeSessionId: `session-${calls.length}`, nativeSessionRef: fixtureSessionRef(`session-${calls.length}`) },
      { type: 'progress', kind: 'tool', text: '只读核查所选论文材料。' },
      { type: 'delta', text: body.context.length ? '结论需要结合证据的适用条件核查。 [1]' : '没有直接论文材料，请补充证据后核查。' },
      { type: 'done', model: 'Codex', nativeSessionId: 'codex-session-test', nativeSessionRef: fixtureSessionRef('codex-session-test') },
    ) });
  });
  await start(page);
  const title = (await state(page)).documents['paper-a'].title;
  await page.getByRole('main').getByRole('button', { name: title, exact: true }).click();
  await expect(page.getByRole('main').locator('canvas').first()).toBeVisible();
  await expect(page.getByRole('main').locator('.pdf-page-loading')).toHaveCount(0);
  await panel(page).getByRole('tab', { name: '摘录', exact: true }).click();
  await panel(page).locator('[data-evidence-id="evidence-a"]').getByRole('button', { name: '加入 AI', exact: true }).click();
  await select(page, 'Codex');
  await panel(page).getByLabel('向 AI 提问').fill('解释这条论文证据');
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: '整理为卡片', exact: true })).toBeVisible();
  const original = Object.values((await state(page)).requests)[0];
  await expect(panel(page).locator('.ai-native-scope')).toContainText('1 条已发材料');
  await mkdir('docs/verification/agents', { recursive: true });
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  const closeNotice = page.getByRole('button', { name: '关闭提示', exact: true });
  if (await closeNotice.isVisible()) await closeNotice.click();
  await page.screenshot({ path: 'docs/verification/agents/native-materials.png' });
  await panel(page).getByRole('button', { name: '移除本轮材料 1', exact: true }).click();
  await expect(panel(page).locator('.ai-scope-notice')).toContainText('前序消息仍可能包含');
  await expect(panel(page).locator('.ai-native-scope')).toContainText('1 条已发材料');
  await panel(page).locator('.ai-context-settings > summary').click();
  await panel(page).getByLabel('前序对话范围').selectOption('none');
  await panel(page).locator('.ai-native-scope summary').click();
  await expect(panel(page).locator('.ai-native-scope')).toContainText('新的原生会话');
  await panel(page).getByLabel('向 AI 提问').fill('仅基于这条问题讨论，不引入旧材料');
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(panel(page).locator('.ai-turn')).toHaveCount(2);
  await expect(panel(page).locator('.ai-answer').last()).toContainText('没有直接论文材料');
  expect(calls[1]).toMatchObject({ history: [], context: [], reset: true });
  expect((await state(page)).requests[original.id].context).toEqual(original.context);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.screenshot({ path: 'docs/verification/agents/native-context-scope.png' });
});

test('演示模式经历史返回 Codex 后，显式选材解释仍使用原助手', async ({ page }) => {
  const calls: Record<string, unknown>[] = [];
  await page.route('**/api/ai/agents/run', route => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/x-ndjson', body: ndjson(
      { type: 'session', nativeSessionId: 'reader-native', nativeSessionRef: fixtureSessionRef('reader-native') },
      { type: 'delta', text: 'Codex 对所选原文的解释，需结合上下文核查。 [1]' },
      { type: 'done', model: 'Codex', nativeSessionId: 'reader-native', nativeSessionRef: fixtureSessionRef('reader-native') },
    ) });
  });
  await start(page);
  await select(page, 'Codex');
  const codexId = (await state(page)).sessions['research-a'].activeConversationId!;
  await select(page, '演示模式');
  await panel(page).getByRole('button', { name: '查看会话历史', exact: true }).click();
  await panel(page).locator('.ai-history-item').filter({ hasText: 'Codex' }).locator('.ai-history-open').click();
  const title = (await state(page)).documents['paper-a'].title;
  const main = page.getByRole('main', { name: '主工作区' });
  await main.getByRole('button', { name: title, exact: true }).click();
  const selected = main.locator('.pdf-text-layer').getByText('Abstract', { exact: true });
  await expect(selected).toBeVisible();
  await selected.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
  });
  const selectionActions = page.getByLabel('原文选区操作');
  await selectionActions.getByRole('button', { name: '摘录', exact: true }).click();
  await selectionActions.getByRole('button', { name: '提问', exact: true }).click();
  await page.getByRole('dialog', { name: '原文旁提问' }).getByRole('button', { name: '在右侧继续', exact: true }).click();
  await select(page, 'Codex');
  await panel(page).getByRole('button', { name: '添加材料', exact: true }).click();
  const materials = panel(page).getByRole('dialog', { name: '添加对话材料' });
  await materials.getByRole('button', { name: /PDF 第 1 页.*Abstract/ }).click();
  await materials.getByRole('button', { name: '完成', exact: true }).click();
  await panel(page).getByLabel('向 AI 提问').fill('请解释所选原文，并说明适用条件与限制。');
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(panel(page).locator('.ai-answer')).toContainText('Codex 对所选原文的解释');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ connectionId: 'codex', researchId: 'research-a', conversationId: codexId });
  const request = Object.values((await state(page)).requests)[0];
  expect(request).toMatchObject({ connectionId: 'codex', mode: 'live', status: 'done' });
  expect(request.body).not.toContain('演示');
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`助手选择与结论工作台 ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await start(page);
    await select(page, 'Codex');
    await openResearchPage(page, '检索增强的适用条件');
    await expect(page.getByRole('main').getByLabel('结论正文')).toBeVisible();
    await panel(page).getByLabel('向 AI 提问').fill('比较这些材料的适用条件，并保留可以回查的出处。');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    const closeNotice = page.getByRole('button', { name: '关闭提示', exact: true });
    if (await closeNotice.isVisible()) await closeNotice.click();
    await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
    const menu = panel(page).getByRole('dialog', { name: '选择 AI 助手' });
    await expect(menu).toBeVisible();
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await mkdir('docs/verification/agents', { recursive: true });
    await page.screenshot({ path: `docs/verification/agents/assistant-picker-${viewport.width}.png` });
    await page.keyboard.press('Escape');
    await expect(panel(page).getByRole('button', { name: '切换 AI 助手' })).toBeFocused();
  });
}
