import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { NativeSessionSnapshot, WorkspaceData } from '../../src/domain/types';
import { createSeed } from '../../src/data/seed';
import { fixtureSessionRef, mockProjectService } from './project-fixture';

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const native = (id: string, agentId: NativeSessionSnapshot['agentId'], title: string, canResume = true, state: NativeSessionSnapshot['state'] = 'idle'): NativeSessionSnapshot => ({
  id, agentId, title: `${title} · 模拟记录`, nativeSessionId: `native-${id}`, updatedAt: '2026-10-17T04:00:00Z', state, canResume, origin: 'native',
  ...(!canResume ? { reason: state === 'busy' ? '正在原生应用中运行，当前输入已保留。' : '本机运行状态无法可靠确认，目前可查看记录。' } : {}),
  messages: [{ id: `${id}-user`, role: 'user', text: '请比较论文的适用条件。' }, { id: `${id}-assistant`, role: 'assistant', text: '模拟原生响应：保留证据条件，并核对引用；此记录没有关联论文来源。' }],
});
async function select(page: Page, name: string) { await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click(); await panel(page).getByRole('button', { name, exact: true }).click(); }
async function setup(page: Page, options: Parameters<typeof mockProjectService>[1] = {}) {
  const api = await mockProjectService(page, options);
  const runs: Record<string, unknown>[] = [];
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, model: 'fixture', images: false, limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: ['codex', 'opencode', 'claude'].map(id => ({ id, name: id, state: 'ready', version: '模拟运行时', capabilities: { images: false, tools: false, resume: true, permissions: 'read-only' } })) } }));
  await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: { models: [], skills: [], plan: false } }));
  await page.route('**/api/ai/agents/run', route => {
    const body = route.request().postDataJSON(); runs.push(body);
    const nativeSessionId = body.sessionRef ? `native-${body.sessionRef}` : 'owned-project-session';
    const nativeSessionRef = body.sessionRef || fixtureSessionRef(nativeSessionId);
    return route.fulfill({ contentType: 'application/x-ndjson', body: [
      { type: 'session', nativeSessionId, nativeSessionRef },
      { type: 'delta', text: body.context.length ? '模拟原生响应：证据需要与适用条件一起核查。 [1]' : '模拟原生响应：已在同一项目会话继续。' },
      { type: 'done', model: '模拟运行时', nativeSessionId, nativeSessionRef },
    ].map(event => JSON.stringify(event)).join('\n') + '\n' });
  });
  await page.goto('/'); await expect(main(page)).toBeVisible();
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  return { ...api, project: api, runs };
}
async function state(page: Page): Promise<WorkspaceData> { return page.evaluate(async () => { const journal = localStorage.getItem('papertrail-recovery-v2'); if (journal) return JSON.parse(journal); const modulePath = '/src/data/storage.ts'; return (await import(modulePath)).loadWorkspace(); }); }
async function history(page: Page) { await panel(page).getByRole('button', { name: '查看会话历史', exact: true }).click(); }
async function closeNotice(page: Page) { const notice = page.getByRole('button', { name: '关闭提示', exact: true }); if (await notice.isVisible()) await notice.click(); }

test('目录浏览取消不写入，唯一确认绑定后保留输入并随请求提交归属', async ({ page }) => {
  const api = await setup(page, { bound: false }); await select(page, 'Codex');
  const input = panel(page).getByLabel('向 AI 提问'); await input.fill('保留绑定前写下的问题');
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
  await panel(page).getByRole('button', { name: /研究目录 · 待选择/ }).click();
  const dialog = page.getByRole('dialog', { name: '研究目录', exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'research-a', exact: true }).click(); await expect(dialog.locator('.directory-preview')).toContainText('/fixture/research-a');
  await dialog.press('Escape'); await expect(dialog).toHaveCount(0); await expect(panel(page)).toBeVisible(); await expect(input).toHaveValue('保留绑定前写下的问题');
  expect(api.project.calls.filter(call => call.action === 'bind')).toHaveLength(0);
  await panel(page).getByRole('button', { name: /研究目录 · 待选择/ }).click(); await dialog.getByRole('button', { name: 'research-a', exact: true }).click();
  await dialog.getByRole('button', { name: '使用这个目录', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(input).toHaveValue('保留绑定前写下的问题'); await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeEnabled();
  const bindings = api.project.calls.filter(call => call.action === 'bind'); expect(bindings).toHaveLength(1); expect(bindings[0].body).toMatchObject({ path: '/fixture/research-a', researchId: 'research-a' }); expect(bindings[0].body.workspaceId).toBeTruthy();
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click(); await expect(panel(page).locator('.ai-answer')).toContainText('同一项目会话'); expect(api.runs[0]).toMatchObject({ bindingId: 'binding-research-a', researchId: 'research-a' });
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'); await page.reload(); await expect(main(page)).toBeVisible(); expect((await state(page)).researches['research-a'].directory?.path).toBe('/fixture/research-a');
});

test('三助手按身份合并与筛选；读取不发送；部分失败保留旧列表', async ({ page }) => {
  const seed = createSeed(); Object.assign(seed.conversations['conversation-research-a'], { connectionId: 'codex', nativeSessionRef: 'ref-codex', nativeSessionId: 'native-ref-codex', nativeCanResume: true, nativeState: 'idle', title: '本软件自定义名称' });
  const sessions = [native('ref-codex', 'codex', '原生同一记录'), native('ref-open', 'opencode', 'OpenCode 的研究方法'), native('ref-claude', 'claude', 'Claude 的引用核查', false)];
  const api = await setup(page, { seed, sessions }); await history(page);
  await expect(panel(page).locator('.ai-history-item')).toHaveCount(3); await expect(panel(page).locator('.ai-history-item').filter({ hasText: '本软件自定义名称' })).toHaveCount(1);
  await panel(page).getByRole('button', { name: 'Codex', exact: true }).click(); await expect(panel(page).locator('.ai-history-item')).toHaveCount(1);
  await panel(page).getByRole('button', { name: '全部', exact: true }).click(); await panel(page).getByLabel('搜索会话').fill('引用核查'); await expect(panel(page).locator('.ai-history-item')).toHaveCount(1);
  await panel(page).getByLabel('搜索会话').fill(''); api.project.failList = true; await panel(page).getByRole('button', { name: '刷新', exact: true }).click(); await expect(panel(page).locator('.ai-history-error')).toContainText('暂时无法更新'); await expect(panel(page).locator('.ai-history-item')).toHaveCount(3);
  api.project.failList = false; await panel(page).locator('.ai-history-item').filter({ hasText: 'Claude 的引用核查' }).locator('.ai-history-open').click();
  await expect(panel(page).locator('.ai-answer')).toContainText('模拟原生响应'); await expect(panel(page).locator('.ai-native-record')).toContainText('包含原有对话上下文'); await expect(panel(page).locator('.ai-turn-range')).toContainText('原有材料未关联');
  await expect(panel(page).getByRole('button', { name: '重新生成', exact: true })).toHaveCount(0); await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled(); expect(api.runs).toHaveLength(0);
});

test('外部忙碌不抢发或停止，切换助手恢复各自草稿，刷新新增消息不重复', async ({ page }) => {
  const busy = native('busy-claude', 'claude', '正在原生端核查', false, 'busy');
  const api = await setup(page, { sessions: [busy] }); await history(page); await panel(page).locator('.ai-history-item').filter({ hasText: busy.title }).locator('.ai-history-open').click();
  await panel(page).getByLabel('向 AI 提问').fill('Claude 完成后继续核查'); await expect(panel(page)).toContainText('正在原生应用中运行'); await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled(); await expect(panel(page).getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await select(page, 'Codex'); await panel(page).getByLabel('向 AI 提问').fill('Codex 独立未发输入'); await select(page, 'Claude Code'); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('Claude 完成后继续核查');
  busy.messages.push({ id: 'external-follow-up', role: 'assistant', text: '原生端新增：已核对第二组证据。' });
  await panel(page).getByRole('button', { name: '刷新记录', exact: true }).click(); await expect(panel(page).locator('.ai-answer')).toContainText('已核对第二组证据'); await panel(page).getByRole('button', { name: '刷新记录', exact: true }).click(); await expect(panel(page).locator('.ai-answer')).toHaveCount(1);
  await history(page); api.project.sessions.push(native('new-open', 'opencode', '原生端刚创建的讨论'));
  await panel(page).getByRole('button', { name: '刷新', exact: true }).click(); await expect(panel(page).locator('.ai-history-item').filter({ hasText: '原生端刚创建的讨论' })).toHaveCount(1); await panel(page).getByRole('button', { name: '刷新', exact: true }).click(); await expect(panel(page).locator('.ai-history-item').filter({ hasText: '原生端刚创建的讨论' })).toHaveCount(1);
  expect(api.runs).toHaveLength(0);
});

test('Codex 读取后按同一原生身份继续，目录失联保留记录和问题', async ({ page }) => {
  const api = await setup(page, { sessions: [native('codex-resume', 'codex', '可继续的项目讨论')] }); await history(page); await panel(page).locator('.ai-history-item').filter({ hasText: '可继续的项目讨论' }).locator('.ai-history-open').click();
  await panel(page).getByLabel('向 AI 提问').fill('沿用原会话继续'); await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeEnabled(); await panel(page).getByRole('button', { name: '发送问题', exact: true }).click(); await expect(panel(page).locator('.ai-answer').last()).toContainText('同一项目会话');
  expect(api.runs).toHaveLength(1); expect(api.runs[0]).toMatchObject({ sessionRef: 'codex-resume', bindingId: 'binding-research-a', connectionId: 'codex' });
  await panel(page).getByLabel('向 AI 提问').fill('目录恢复后发送的问题'); api.project.failDirectory = true; await panel(page).getByRole('button', { name: '刷新记录', exact: true }).click(); await expect(panel(page)).toContainText('研究目录暂时不可用'); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('目录恢复后发送的问题'); await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled(); await expect(panel(page).locator('.ai-answer')).toHaveCount(2);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`项目会话与中央原文并列 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport); const seed = createSeed(); seed.panelWidth = 440;
    const api = await setup(page, { seed, sessions: [native('reference-open', 'opencode', 'OpenCode 原生端的研究讨论', false)] });
    await main(page).getByRole('button', { name: /Adaptive Retrieval: Evidence & Reliability/ }).click(); await expect(main(page).locator('canvas')).toBeVisible(); await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
    await panel(page).getByRole('tab', { name: '证据', exact: true }).click(); await panel(page).locator('[data-evidence-id="evidence-a"]').getByRole('button', { name: '加入 AI', exact: true }).click(); await select(page, 'Codex');
    await panel(page).getByLabel('向 AI 提问').fill('解释这条证据并保留原文'); await panel(page).getByRole('button', { name: '发送问题', exact: true }).click(); await expect(panel(page).locator('.ai-answer')).toContainText('模拟原生响应');
    await panel(page).getByLabel('向 AI 提问').fill('保留尚未发送的问题'); await panel(page).getByRole('button', { name: /^引用 1：/ }).click();
    await expect(main(page).getByRole('spinbutton').first()).toHaveValue('3'); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('保留尚未发送的问题');
    await history(page); await expect(panel(page).locator('.ai-history-item').filter({ hasText: 'OpenCode 原生端的研究讨论' })).toBeVisible(); await expect(main(page).locator('canvas')).toBeVisible(); await closeNotice(page);
    const right = (await panel(page).boundingBox())!, reader = (await main(page).boundingBox())!; expect(reader.x + reader.width).toBeLessThanOrEqual(right.x + 1); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await mkdir('docs/verification/project-sessions', { recursive: true }); await page.screenshot({ path: `docs/verification/project-sessions/implemented-${viewport.width}.png` });
    await panel(page).getByRole('button', { name: '返回当前对话', exact: true }).click(); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('保留尚未发送的问题'); expect(api.runs).toHaveLength(1);
  });
}
