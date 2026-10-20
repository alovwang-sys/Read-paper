import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { NativeSessionSnapshot, WorkspaceData } from '../../src/domain/types';
import { createSeed } from '../../src/data/seed';
import { fixtureSessionRef, mockProjectService } from './project-fixture';
import { openSource } from './knowledge-helpers';

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const navigation = (page: Page) => page.locator('.sidebar');
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
async function state(page: Page): Promise<WorkspaceData> { return page.evaluate(async () => { const journal = localStorage.getItem('papertrail-recovery-v3'); if (journal) return JSON.parse(journal); const modulePath = '/src/data/storage.ts'; return (await import(modulePath)).loadWorkspace(); }); }
async function history(page: Page) { await panel(page).getByRole('button', { name: '查看会话历史', exact: true }).click(); }
async function closeNotice(page: Page) { const notice = page.getByRole('button', { name: '关闭提示', exact: true }); if (await notice.isVisible()) await notice.click(); }

test('目录浏览取消不写入，唯一确认绑定后保留输入并随请求提交归属', async ({ page }) => {
  const api = await setup(page, { bound: false }); const originalName = (await state(page)).researches['research-a'].title; await select(page, 'Codex');
  const input = panel(page).getByLabel('向 AI 提问'); await input.fill('保留绑定前写下的问题');
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
  await panel(page).getByRole('button', { name: '选择研究目录', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '项目设置', exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'research-a', exact: true }).click(); await expect(dialog.locator('.directory-preview')).toContainText('/fixture/research-a');
  await expect(dialog).toContainText('项目将命名为「research-a」');
  await dialog.press('Escape'); await expect(dialog).toHaveCount(0); await expect(panel(page)).toBeVisible(); await expect(input).toHaveValue('保留绑定前写下的问题');
  expect(api.project.calls.filter(call => call.action === 'bind')).toHaveLength(0); expect((await state(page)).researches['research-a'].title).toBe(originalName);
  await expect(page.getByLabel('切换研究').locator('option:checked')).toHaveText(originalName);
  await panel(page).getByRole('button', { name: '选择研究目录', exact: true }).click(); await dialog.getByRole('button', { name: 'research-a', exact: true }).click();
  await dialog.getByRole('button', { name: '使用这个目录', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(input).toHaveValue('保留绑定前写下的问题'); await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeEnabled();
  await expect(page.getByLabel('切换研究').locator('option:checked')).toHaveText('research-a');
  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('research-a');
  await expect(page.locator('.breadcrumb').getByText('research-a', { exact: true }).first()).toBeVisible();
  await expect(navigation(page).locator('.research-project-row')).toHaveCount(1);
  await expect(navigation(page).locator('.research-nav > .research-directory-trigger')).toHaveCount(0);
  await expect(navigation(page).getByRole('button', { name: '项目设置 · research-a', exact: true })).toBeVisible();
  const bindings = api.project.calls.filter(call => call.action === 'bind'); expect(bindings).toHaveLength(1); expect(bindings[0].body).toMatchObject({ path: '/fixture/research-a', researchId: 'research-a' }); expect(bindings[0].body.workspaceId).toBeTruthy();
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click(); await expect(panel(page).locator('.ai-answer')).toContainText('同一项目会话'); expect(api.runs[0]).toMatchObject({ bindingId: 'binding-research-a', researchId: 'research-a' });
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'); await page.reload(); await expect(main(page)).toBeVisible(); expect((await state(page)).researches['research-a'].directory?.path).toBe('/fixture/research-a'); await expect(page.getByLabel('切换研究').locator('option:checked')).toHaveText('research-a');
});

test('首次目录加载锁定路径输入，加载完成后的目标预览与取消保持一致', async ({ page }) => {
  const api = await setup(page, { bound: false }); const originalName = (await state(page)).researches['research-a'].title;
  let releaseBrowse!: () => void; const initialBrowse = new Promise<void>(resolve => { releaseBrowse = resolve; }); let firstBrowse = true;
  await page.route('**/api/ai/agents/projects/browse', async route => {
    if (!firstBrowse || route.request().postDataJSON().path) return route.fallback();
    firstBrowse = false; await initialBrowse;
    return route.fulfill({ json: { path: '/fixture', parent: '/', directories: [] } });
  });
  try {
    const requested = page.waitForRequest(request => request.url().endsWith('/api/ai/agents/projects/browse') && !request.postDataJSON().path);
    await navigation(page).getByRole('button', { name: `项目设置 · ${originalName}`, exact: true }).click();
    await requested;
    const dialog = page.getByRole('dialog', { name: '项目设置', exact: true }), path = dialog.getByLabel('本机目录路径');
    await expect(path).toBeDisabled(); await expect(dialog.getByRole('button', { name: '打开路径', exact: true })).toBeDisabled();
    releaseBrowse(); await expect(path).toBeEditable();
    await path.fill('/fixture/research-a'); await dialog.getByRole('button', { name: '打开路径', exact: true }).click();
    await expect(dialog.locator('.directory-preview')).toContainText('/fixture/research-a'); await expect(path).toHaveValue('/fixture/research-a');
    await expect(dialog).toContainText('项目将命名为「research-a」'); await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(page.getByLabel('切换研究').locator('option:checked')).toHaveText(originalName);
    expect((await state(page)).researches['research-a'].title).toBe(originalName); expect(api.project.calls.filter(call => call.action === 'bind')).toHaveLength(0);
  } finally { releaseBrowse(); }
});

test('旧绑定按文件夹名称恢复项目入口，同目录重连与研究切换保留各自输入', async ({ page }) => {
  const seed = createSeed();
  Object.assign(seed.conversations['conversation-research-a'], { connectionId: 'codex', input: '研究 A 尚未发送的问题' });
  Object.assign(seed.conversations['conversation-research-b'], { connectionId: 'codex', input: '研究 B 独立的问题' });
  const api = await setup(page, { seed, names: { 'research-a': 'research-a', 'research-b': 'research-b' } });
  await expect(page.getByLabel('切换研究').locator('option:checked')).toHaveText('research-a');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('研究 A 尚未发送的问题');
  expect((await state(page)).researches['research-a'].id).toBe('research-a');
  const binding = (await state(page)).researches['research-a'].directory!;
  await navigation(page).getByRole('button', { name: '项目设置 · research-a', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '项目设置', exact: true });
  await expect(dialog).toContainText('已连接'); await expect(dialog.getByLabel('项目位置')).toHaveValue(binding.path);
  await dialog.getByRole('button', { name: '重新连接目录', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const rebound = (await state(page)).researches['research-a'];
  expect(rebound.id).toBe('research-a'); expect(rebound.title).toBe('research-a'); expect(rebound.directory).toMatchObject(binding);
  expect(api.project.calls.filter(call => call.action === 'bind')).toHaveLength(1);
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('研究 A 尚未发送的问题');
  await page.getByLabel('切换研究').selectOption('research-b'); await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(page.getByLabel('切换研究').locator('option:checked')).toHaveText('research-b');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('研究 B 独立的问题');
  await page.getByLabel('切换研究').selectOption('research-a');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('研究 A 尚未发送的问题');
  expect(Object.keys((await state(page)).researches).sort()).toEqual(['research-a', 'research-b']);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'); await page.reload();
  await expect(page.getByLabel('切换研究')).toHaveValue('research-a');
  await expect(page.getByLabel('切换研究').locator('option:checked')).toHaveText('research-a');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('研究 A 尚未发送的问题'); expect(api.runs).toHaveLength(0);
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
  await expect(panel(page).locator('.ai-answer')).toContainText('模拟原生响应'); await expect(panel(page).getByRole('button', { name: '刷新记录', exact: true })).toHaveAttribute('title', '刷新原生记录 · 包含原有对话上下文'); await expect(panel(page).locator('.ai-turn-range')).toContainText('原有材料未关联');
  await expect(panel(page).getByRole('button', { name: '重新生成', exact: true })).toHaveCount(0); await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled(); expect(api.runs).toHaveLength(0);
});

test('外部忙碌不抢发或停止，切换助手恢复各自草稿，刷新新增消息不重复', async ({ page }) => {
  const busy = native('busy-claude', 'claude', '正在原生端核查', false, 'busy');
  const api = await setup(page, { sessions: [busy] }); await history(page); await panel(page).locator('.ai-history-item').filter({ hasText: busy.title }).locator('.ai-history-open').click();
  await panel(page).getByLabel('向 AI 提问').fill('Claude 完成后继续核查'); await expect(panel(page)).toContainText('正在原生应用中运行'); await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled(); await expect(panel(page).getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await select(page, 'Codex'); await panel(page).getByLabel('向 AI 提问').fill('Codex 独立未发输入'); await select(page, 'Claude Code'); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('Claude 完成后继续核查');
  await expect(panel(page).getByRole('button', { name: '刷新记录', exact: true })).toBeEnabled();
  busy.messages.push({ id: 'external-follow-up', role: 'assistant', text: '原生端新增：已核对第二组证据。' });
  let releaseRead!: () => void; const reading = new Promise<void>(resolve => { releaseRead = resolve; });
  await page.route('**/api/ai/agents/projects/read', async route => { await reading; return route.fallback(); }, { times: 1 });
  try {
    const requested = page.waitForRequest(request => request.url().endsWith('/api/ai/agents/projects/read') && request.postDataJSON().sessionRef === busy.id);
    await panel(page).getByRole('button', { name: '刷新记录', exact: true }).click(); await requested; await expect(panel(page).getByRole('button', { name: '刷新记录', exact: true })).toBeDisabled();
    await panel(page).getByLabel('向 AI 提问').fill('原生记录读取期间继续写下的问题'); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('原生记录读取期间继续写下的问题');
    releaseRead(); await expect(panel(page).locator('.ai-answer')).toContainText('已核对第二组证据'); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('原生记录读取期间继续写下的问题');
  } finally { releaseRead(); }
  await panel(page).getByRole('button', { name: '刷新记录', exact: true }).click(); await expect(panel(page).locator('.ai-answer')).toHaveCount(1);
  await history(page); api.project.sessions.push(native('new-open', 'opencode', '原生端刚创建的讨论'));
  await panel(page).getByRole('button', { name: '刷新', exact: true }).click(); await expect(panel(page).locator('.ai-history-item').filter({ hasText: '原生端刚创建的讨论' })).toHaveCount(1); await panel(page).getByRole('button', { name: '刷新', exact: true }).click(); await expect(panel(page).locator('.ai-history-item').filter({ hasText: '原生端刚创建的讨论' })).toHaveCount(1);
  expect(api.runs).toHaveLength(0);
});

test('原生进行中历史自动同步至完成，不误报失败或提供停止和重发', async ({ page }) => {
  const busy = native('history-live', 'codex', '原生长任务', false, 'busy');
  busy.messages = [
    { id: 'live-user', role: 'user', text: '核对这篇论文的训练流程。', turnId: 'live-turn', turnStatus: 'inProgress' },
    { id: 'live-answer', role: 'assistant', text: '正在核对论文材料，后续会补充完整结论。', turnId: 'live-turn', turnStatus: 'inProgress' },
  ];
  const api = await setup(page, { sessions: [busy] });
  const mutations: string[] = [];
  await page.route(/\/api\/ai\/agents\/(run|stop|control|respond)$/, route => { mutations.push(route.request().url()); return route.fulfill({ status: 500, json: { error: '历史查看不得操作原生任务' } }); });
  await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
  await expect(main(page).locator('canvas').first()).toBeVisible();
  await history(page); await panel(page).locator('.ai-history-item').filter({ hasText: busy.title }).locator('.ai-history-open').click();
  const turn = panel(page).locator('.ai-turn');
  await expect(turn.getByRole('status')).toContainText('原生回合正在运行');
  await expect(turn.getByRole('alert')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await expect(turn.getByRole('button', { name: /重试|重新生成/ })).toHaveCount(0);
  await panel(page).getByLabel('向 AI 提问').fill('完成后再核对运行镜像的关系');
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
  const original = await state(page), conversationId = original.sessions['research-a'].activeConversationId!, requestId = original.conversations[conversationId].requestIds[0];
  expect(original.requests[requestId].status).toBe('generating');
  await mkdir('docs/verification/native-history-state', { recursive: true });
  for (const width of [1440, 1280, 1024]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
    await expect(turn.getByRole('status')).toBeVisible();
    await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
    await page.screenshot({ path: `docs/verification/native-history-state/running-${width}.png` });
  }
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'); await page.reload();
  await expect(turn.getByRole('status')).toContainText('原生回合正在运行');
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('完成后再核对运行镜像的关系');
  busy.messages[1].text = '第二份材料已核对，正在完成结论。';
  await expect(turn.locator('.ai-answer')).toContainText('第二份材料已核对', { timeout: 20000 });
  busy.state = 'idle'; busy.canResume = true; delete busy.reason;
  busy.messages = busy.messages.map(message => ({ ...message, turnStatus: 'completed' })); busy.messages[1].text = '已完成训练流程核对，缺少原文的部分保留为建议。';
  await expect(turn.locator('.ai-answer')).toContainText('已完成训练流程核对', { timeout: 20000 });
  await expect(turn.getByRole('status')).toHaveCount(0); await expect(turn.getByRole('alert')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeEnabled();
  const completed = await state(page);
  expect(completed.conversations[conversationId].requestIds).toEqual([requestId]); expect(completed.requests[requestId].status).toBe('done');
  expect(api.project.calls.filter(call => call.action === 'read').length).toBeGreaterThan(2); expect(mutations).toEqual([]); expect(api.runs).toEqual([]);
});

test('原生中断与记录预览使用中性状态，只有确认执行失败才告警', async ({ page }) => {
  const record = native('history-ended', 'codex', '原生结束状态', false, 'unknown');
  record.messages = [
    { id: 'stopped-user', role: 'user', text: '已停止的上一轮', turnId: 'stopped-turn', turnStatus: 'interrupted' },
    { id: 'stopped-answer', role: 'assistant', text: '停止前已收到的进展', turnId: 'stopped-turn', turnStatus: 'interrupted' },
    { id: 'preview-user', role: 'user', text: '读取到的长回答预览', turnId: 'preview-turn', turnStatus: 'completed', answerComplete: false },
    { id: 'preview-answer', role: 'assistant', text: '原生记录中的正文预览', turnId: 'preview-turn', turnStatus: 'completed', answerComplete: false },
    { id: 'unknown-user', role: 'user', text: '结束状态尚待核对的回合', turnId: 'unknown-turn' },
    { id: 'unknown-answer', role: 'assistant', text: '已保存的进展记录', turnId: 'unknown-turn' },
    { id: 'failed-user', role: 'user', text: '真正执行失败的回合', turnId: 'failed-turn', turnStatus: 'failed' },
    { id: 'failed-answer', role: 'assistant', text: '失败前已有内容', turnId: 'failed-turn', turnStatus: 'failed' },
  ];
  const api = await setup(page, { sessions: [record] }); await history(page);
  await panel(page).locator('.ai-history-item').filter({ hasText: record.title }).locator('.ai-history-open').click();
  const stopped = panel(page).locator('.ai-turn').filter({ hasText: '已停止的上一轮' });
  const preview = panel(page).locator('.ai-turn').filter({ hasText: '读取到的长回答预览' });
  const unknown = panel(page).locator('.ai-turn').filter({ hasText: '结束状态尚待核对的回合' });
  const failed = panel(page).locator('.ai-turn').filter({ hasText: '真正执行失败的回合' });
  await expect(stopped.getByRole('status')).toContainText('本轮已中断'); await expect(stopped.getByRole('alert')).toHaveCount(0);
  await expect(preview.getByRole('status')).toContainText('预览'); await expect(preview.getByRole('alert')).toHaveCount(0);
  await expect(unknown.getByRole('status')).toContainText('尚未确认'); await expect(unknown.getByRole('alert')).toHaveCount(0);
  await expect(failed.getByRole('alert')).toContainText('原生回合执行失败'); await expect(panel(page).getByRole('alert')).toHaveCount(1);
  await expect(panel(page).getByRole('button', { name: /按原范围重试|在此对话中重试|重新生成/ })).toHaveCount(0);
  await stopped.scrollIntoViewIfNeeded(); await mkdir('docs/verification/native-history-state', { recursive: true });
  await page.screenshot({ path: 'docs/verification/native-history-state/interrupted-preview-1440.png' });
  await failed.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'docs/verification/native-history-state/confirmed-failure-1440.png' });
  expect(api.runs).toEqual([]);
});

test('Codex 读取后按同一原生身份继续，目录失联保留记录和问题', async ({ page }) => {
  const api = await setup(page, { sessions: [native('codex-resume', 'codex', '可继续的项目讨论')] }); await history(page); await panel(page).locator('.ai-history-item').filter({ hasText: '可继续的项目讨论' }).locator('.ai-history-open').click();
  await expect(panel(page).locator('.ai-answer')).toContainText('模拟原生响应'); await expect(panel(page).getByRole('button', { name: '刷新记录', exact: true })).toBeEnabled();
  await panel(page).getByLabel('向 AI 提问').fill('沿用原会话继续'); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('沿用原会话继续'); await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeEnabled(); await panel(page).getByRole('button', { name: '发送问题', exact: true }).click(); await expect(panel(page).locator('.ai-answer').last()).toContainText('同一项目会话');
  expect(api.runs).toHaveLength(1); expect(api.runs[0]).toMatchObject({ sessionRef: 'codex-resume', bindingId: 'binding-research-a', connectionId: 'codex' });
  await panel(page).getByLabel('向 AI 提问').fill('目录恢复后发送的问题'); api.project.failDirectory = true; await panel(page).getByRole('button', { name: '刷新记录', exact: true }).click(); await expect(panel(page)).toContainText('研究目录暂时不可用'); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('目录恢复后发送的问题'); await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled(); await expect(panel(page).locator('.ai-answer')).toHaveCount(2);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`项目会话与中央原文并列 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport); const seed = createSeed(); seed.panelWidth = 440;
    const api = await setup(page, { seed, names: { 'research-a': 'research-a' }, sessions: [native('reference-open', 'opencode', 'OpenCode 原生端的研究讨论', false)] });
    await main(page).getByRole('button', { name: 'Adaptive Retrieval: Evidence & Reliability', exact: true }).click(); await expect(main(page).locator('canvas').first()).toBeVisible(); await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
    await panel(page).getByRole('tab', { name: '摘录', exact: true }).click(); await panel(page).locator('[data-evidence-id="evidence-a"]').getByRole('button', { name: '加入 AI', exact: true }).click(); await select(page, 'Codex');
    await panel(page).getByLabel('向 AI 提问').fill('解释这条证据并保留原文'); await panel(page).getByRole('button', { name: '发送问题', exact: true }).click(); await expect(panel(page).locator('.ai-answer')).toContainText('模拟原生响应');
    await panel(page).getByLabel('向 AI 提问').fill('保留尚未发送的问题'); await panel(page).getByRole('button', { name: /^引用 1：/ }).click();
    await expect(main(page).getByRole('spinbutton').first()).toHaveValue('3'); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('保留尚未发送的问题');
    await history(page); await expect(panel(page).locator('.ai-history-item').filter({ hasText: 'OpenCode 原生端的研究讨论' })).toBeVisible(); await expect(main(page).locator('canvas').first()).toBeVisible(); await closeNotice(page);
    if (viewport.width === 1024) await page.getByRole('button', { name: '展开左栏', exact: true }).click();
    const settings = navigation(page).getByRole('button', { name: '项目设置 · research-a', exact: true });
    await expect(settings).toBeVisible(); const target = (await settings.boundingBox())!; expect(target.width).toBeGreaterThanOrEqual(36); expect(target.height).toBeGreaterThanOrEqual(36);
    if (viewport.width === 1024) {
      await settings.click(); const dialog = page.getByRole('dialog', { name: '项目设置', exact: true }); await expect(dialog).toContainText('已连接'); await dialog.press('Escape');
      await page.getByRole('button', { name: '关闭导航抽屉', exact: true }).click(); await expect(navigation(page)).not.toBeVisible();
    }
    const right = (await panel(page).boundingBox())!, reader = (await main(page).boundingBox())!; expect(reader.x + reader.width).toBeLessThanOrEqual(right.x + 1); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await mkdir('docs/verification/project-sessions', { recursive: true }); await page.screenshot({ path: `docs/verification/project-sessions/project-entry-${viewport.width}.png` });
    await panel(page).getByRole('button', { name: '返回当前对话', exact: true }).click(); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('保留尚未发送的问题'); expect(api.runs).toHaveLength(1);
  });
}
