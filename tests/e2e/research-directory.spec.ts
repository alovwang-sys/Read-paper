import { openResearchNavigation, switchResearch } from './knowledge-helpers';
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { ResearchDirectory, WorkspaceData } from '../../src/domain/types';
import { createSeed } from '../../src/data/seed';
import { mockProjectService } from './project-fixture';

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const createDialog = (page: Page) => page.getByRole('dialog', { name: '新建研究', exact: true });
const pendingKey = 'papertrail-pending-research-create-v1';
async function data(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const journal = localStorage.getItem('papertrail-recovery-v3');
    if (journal) return JSON.parse(journal);
    const modulePath = '/src/data/storage.ts';
    return (await import(modulePath)).loadWorkspace();
  });
}
async function selectAgent(page: Page, name: string) {
  await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
  await panel(page).getByRole('button', { name, exact: true }).click();
}
async function setup(page: Page, seed = createSeed()) {
  await mockProjectService(page, { seed });
  const state = {
    calls: [] as { action: string; body: Record<string, unknown> }[],
    runs: [] as Record<string, unknown>[],
    bindings: new Map<string, ResearchDirectory>(),
    bindFailures: 0,
    pendingAtBind: [] as boolean[],
  };
  await page.route('**/api/ai/agents/projects/*', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const action = new URL(route.request().url()).pathname.split('/').at(-1)!;
    state.calls.push({ action, body });
    if (action === 'status' && state.bindings.has(String(body.researchId))) return route.fulfill({ json: state.bindings.get(String(body.researchId)) });
    if (action === 'read' && body.sessionRef === 'directory-test-session') return route.fulfill({ json: { id: body.sessionRef, nativeSessionId: 'directory-test-native', agentId: 'codex', title: '目录继承验证', updatedAt: '2026-10-17T12:00:00.000Z', state: 'idle', canResume: true, origin: 'read-paper', messages: [] } });
    if (action !== 'bind') return route.fallback();
    state.pendingAtBind.push(await page.evaluate(key => !!localStorage.getItem(key), pendingKey));
    if (state.bindFailures > 0) {
      state.bindFailures--;
      return route.fulfill({ status: 409, json: { code: 'creation_unconfirmed', error: '模拟响应中断，目录结果待确认；请重试同一次创建。' } });
    }
    const directory = { id: `binding-${body.researchId}`, projectId: `project-${body.researchId}`, path: String(body.path), name: String(body.path).split(/[\\/]/).filter(Boolean).at(-1)! };
    state.bindings.set(String(body.researchId), directory);
    return route.fulfill({ json: directory });
  });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, model: 'fixture', images: false, limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: ['codex', 'opencode', 'claude'].map(id => ({ id, name: id, state: 'ready', version: '模拟运行时', capabilities: { images: false, tools: false, resume: true, permissions: 'read-only' } })) } }));
  await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: { models: [], skills: [], plan: false } }));
  await page.route('**/api/ai/agents/run', route => {
    const body = route.request().postDataJSON(); state.runs.push(body);
    return route.fulfill({ contentType: 'application/x-ndjson', body: [
      { type: 'session', nativeSessionId: 'directory-test-native', nativeSessionRef: 'directory-test-session' },
      { type: 'delta', text: '模拟回复：已沿用研究目录。' },
      { type: 'done', nativeSessionId: 'directory-test-native', nativeSessionRef: 'directory-test-session' },
    ].map(event => JSON.stringify(event)).join('\n') + '\n' });
  });
  await page.goto('/'); await expect(main(page)).toBeVisible();
  return state;
}
async function openNew(page: Page, title: string, question = '哪些条件影响研究结果？') {
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  const dialog = createDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('研究名称', { exact: true }).fill(title);
  await dialog.getByLabel('新研究核心问题').fill(question);
  await expect(dialog.getByRole('button', { name: '创建并关联', exact: true })).toBeEnabled();
  return dialog;
}
async function createNew(page: Page, title: string) {
  const dialog = await openNew(page, title);
  await dialog.getByRole('button', { name: '创建并关联', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(main(page).getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  const workspace = await data(page);
  if (workspace.scope.kind !== 'research') throw new Error('Expected active research');
  return workspace.researches[workspace.scope.researchId];
}

test('新建研究一次确认绑定目录，右侧助手继承且发送同一binding', async ({ page }) => {
  const api = await setup(page); const research = await createNew(page, '可靠检索实验');
  await expect(page.getByRole('main').getByText('写下第一段文稿后，在这里核查引用与出处。')).toBeVisible();
  await expect(page.getByRole('main').getByText('文稿里的每处引用都能回到原文。')).toHaveCount(0);
  expect(research.directory).toMatchObject({ path: '/fixture/可靠检索实验', name: '可靠检索实验' });
  const bindings = api.calls.filter(call => call.action === 'bind');
  expect(bindings).toHaveLength(1);
  expect(bindings[0].body).toMatchObject({ researchId: research.id, path: research.directory!.path, mode: 'new' });
  expect(bindings[0].body.operationId).toBeTruthy(); expect(api.pendingAtBind).toEqual([true]);
  await expect(page.getByRole('button', { name: '切换研究', exact: true })).toContainText(research.title);
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click(); await selectAgent(page, 'Codex');
  await expect(panel(page).locator('.research-directory-trigger')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: '选择研究目录', exact: true })).toHaveCount(0);
  await panel(page).getByLabel('向 AI 提问').fill('请核查当前研究目录。');
  await page.getByRole('complementary', { name: '左侧导航' }).getByRole('button', { name: `项目设置 · ${research.title}`, exact: true }).click();
  const settings = page.getByRole('dialog', { name: '项目设置', exact: true });
  await expect(settings.getByLabel('项目位置')).toHaveValue(research.directory!.path);
  await settings.getByRole('button', { name: '取消', exact: true }).click();
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('请核查当前研究目录。');
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(panel(page).locator('.ai-answer')).toContainText('已沿用研究目录');
  expect(api.runs).toHaveLength(1); expect(api.runs[0]).toMatchObject({ researchId: research.id, bindingId: research.directory!.id });
  const researchSync = () => api.calls.filter(call => call.action === 'sync' && call.body.researchId === research.id).find(call =>
    (call.body.files as { path: string; content?: string }[]).some(file => file.path === 'research.json' && file.content?.includes('directory-test-native')));
  await expect.poll(researchSync).toBeTruthy();
  expect(researchSync()!.body.bindingId).toBe(research.directory!.id);
  const files = researchSync()!.body.files as { path: string; content?: string }[];
  const metadata = JSON.parse(files.find(file => file.path === 'research.json')!.content!);
  expect(metadata.entities.research.id).toBe(research.id);
  expect(files.some(file => file.path.startsWith('sessions/') && file.content?.includes('directory-test-native'))).toBe(true);
  await mkdir('docs/verification/composer-directory', { recursive: true });
  for (const width of [1440, 1280, 1024]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
    await expect(panel(page).locator('.research-directory-trigger')).toHaveCount(0);
    await expect(panel(page).locator('.ai-materials')).not.toHaveAttribute('open', '');
    for (const label of ['添加材料', '发送问题']) {
      const bounds = await panel(page).getByRole('button', { name: label, exact: true }).boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(width === 1440 ? 900 : 800);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    const chat = panel(page).getByRole('log', { name: '对话消息' });
    await expect(chat).toBeVisible();
    const chatBounds = (await chat.boundingBox())!, composerBounds = (await panel(page).locator('.ai-composer-new').boundingBox())!;
    expect(chatBounds.y + chatBounds.height).toBeLessThanOrEqual(composerBounds.y + 1);
    await page.screenshot({ path: `docs/verification/composer-directory/bound-${width}.png` });
  }
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'); await page.reload();
  await openResearchNavigation(page);
  await expect(page.getByRole('button', { name: '切换研究', exact: true })).toHaveAttribute('data-research-id', research.id);
  expect((await data(page)).researches[research.id].directory).toMatchObject(research.directory!);
  await expect(panel(page).locator('.research-directory-trigger')).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), pendingKey)).toBeNull();
});

test('使用已有目录在确认前采用目录名，最终只关联该位置', async ({ page }) => {
  const api = await setup(page); const dialog = await openNew(page, '未采用的名称');
  await dialog.getByRole('tab', { name: '使用已有目录', exact: true }).click();
  await expect(dialog.getByLabel('研究名称', { exact: true })).toHaveAttribute('readonly', '');
  await dialog.getByRole('button', { name: '选择目录', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择已有目录', exact: true });
  await expect(picker.getByRole('button', { name: '使用此位置', exact: true })).toBeEnabled();
  await expect(picker.getByLabel('本机目录路径')).toBeEditable();
  await picker.getByLabel('本机目录路径').fill('/fixture/已有研究目录');
  await picker.getByRole('button', { name: '打开路径', exact: true }).click();
  await expect(picker.getByLabel('本机目录路径')).toHaveValue('/fixture/已有研究目录');
  await picker.getByRole('button', { name: '使用此位置', exact: true }).click();
  await expect(picker).toHaveCount(0); await expect(dialog.getByLabel('研究名称', { exact: true })).toHaveValue('已有研究目录');
  expect(api.calls.filter(call => call.action === 'bind')).toHaveLength(0);
  await dialog.getByRole('button', { name: '创建并关联', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const result = await data(page); if (result.scope.kind !== 'research') throw new Error('Expected research');
  expect(result.researches[result.scope.researchId]).toMatchObject({ title: '已有研究目录', directory: { path: '/fixture/已有研究目录' } });
  expect(api.calls.filter(call => call.action === 'bind')).toHaveLength(1);
  expect(api.calls.find(call => call.action === 'bind')!.body.mode).toBe('existing');
});

test('取消创建和子层目录选择不绑定、不留下业务研究并保留表单', async ({ page }) => {
  const api = await setup(page); const before = await data(page); const dialog = await openNew(page, '取消的研究', '仍需保留的问题');
  await dialog.getByRole('button', { name: '更改', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择父位置', exact: true }); await expect(picker).toBeVisible();
  await picker.press('Escape'); await expect(picker).toHaveCount(0);
  await expect(dialog.getByLabel('研究名称', { exact: true })).toHaveValue('取消的研究');
  await expect(dialog.getByLabel('新研究核心问题')).toHaveValue('仍需保留的问题');
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(Object.keys((await data(page)).researches)).toEqual(Object.keys(before.researches));
  expect(api.calls.filter(call => call.action === 'bind')).toHaveLength(0);
  expect(await page.evaluate(key => localStorage.getItem(key), pendingKey)).toBeNull();
  await expect(page.getByRole('button', { name: '新建研究', exact: true })).toBeFocused();
});

test('稍后设置沿用人工阅读创建路径，不调用bind且保存问题', async ({ page }) => {
  const api = await setup(page); const dialog = await openNew(page, '先阅读再关联', '人工阅读的问题');
  await dialog.getByRole('button', { name: '稍后设置目录', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(main(page).getByRole('heading', { level: 1, name: '先阅读再关联', exact: true })).toBeVisible();
  const result = await data(page); if (result.scope.kind !== 'research') throw new Error('Expected research');
  expect(result.researches[result.scope.researchId]).toMatchObject({ title: '先阅读再关联', question: '人工阅读的问题' });
  expect(result.researches[result.scope.researchId].directory).toBeUndefined();
  expect(api.calls.filter(call => call.action === 'bind')).toHaveLength(0);
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click(); await selectAgent(page, 'Codex');
  await expect(panel(page).getByRole('button', { name: '选择研究目录', exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
});

test('绑定结果待确认保留表单与稳定身份，重试完成唯一研究', async ({ page }) => {
  const api = await setup(page); api.bindFailures = 1; const before = await data(page);
  const dialog = await openNew(page, '重试恢复研究', '失败后应保留的问题');
  await dialog.getByRole('button', { name: '创建并关联', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('目录结果待确认');
  await expect(dialog.getByLabel('研究名称', { exact: true })).toHaveValue('重试恢复研究');
  await expect(dialog.getByLabel('新研究核心问题')).toHaveValue('失败后应保留的问题');
  expect(Object.keys((await data(page)).researches)).toHaveLength(Object.keys(before.researches).length);
  expect(await page.evaluate(key => localStorage.getItem(key), pendingKey)).toBeTruthy();
  await dialog.getByRole('button', { name: '重试', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const bindings = api.calls.filter(call => call.action === 'bind'); expect(bindings).toHaveLength(2);
  expect(bindings[1].body).toEqual(bindings[0].body); expect(api.pendingAtBind).toEqual([true, true]);
  expect(Object.keys((await data(page)).researches)).toHaveLength(Object.keys(before.researches).length + 1);
  expect(await page.evaluate(key => localStorage.getItem(key), pendingKey)).toBeNull();
});

test('新建目录后切换研究与助手分别恢复目录和未发送输入', async ({ page }) => {
  const seed = createSeed(); Object.assign(seed.conversations['conversation-research-a'], { connectionId: 'codex', input: '原研究的未发问题' });
  const api = await setup(page, seed); const created = await createNew(page, '新目录输入隔离');
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click(); await selectAgent(page, 'Codex');
  await panel(page).getByLabel('向 AI 提问').fill('新研究 Codex 输入');
  await selectAgent(page, 'Claude Code'); await panel(page).getByLabel('向 AI 提问').fill('新研究 Claude 输入');
  await selectAgent(page, 'Codex'); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('新研究 Codex 输入');
  await switchResearch(page, 'research-a');
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('原研究的未发问题');
  await switchResearch(page, created.id);
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('新研究 Codex 输入');
  expect((await data(page)).researches[created.id].directory?.path).toBe(created.directory!.path);
  expect((await data(page)).researches['research-a'].directory?.path).toBe('/fixture/research-a');
  expect(api.calls.filter(call => call.action === 'bind')).toHaveLength(1); expect(api.runs).toHaveLength(0);
});
