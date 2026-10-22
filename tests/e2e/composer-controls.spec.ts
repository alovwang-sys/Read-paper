import { switchResearch } from './knowledge-helpers';
import { test as base, expect, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { CodexCapabilities, CodexSettings, WorkspaceData } from '../../src/domain/types';
import { fixtureSessionRef, mockProjectService } from './project-fixture';

type Run = { requestId: string; researchId: string; conversationId: string; prompt: string; codex?: CodexSettings; context: unknown[] };
type API = { url: string; runs: Run[]; stops: { requestId: string }[]; catalog: CodexCapabilities };
const patch = 'diff --git a/research-note.md b/research-note.md\n--- a/research-note.md\n+++ b/research-note.md\n@@ -1 +1,2 @@\n-old condition\n+verified condition\n+keep source evidence';
const test = base.extend<{ api: API }>({ api: async ({}, use) => {
  const pending = new Map<string, ServerResponse>();
  const api: API = { url: '', runs: [], stops: [], catalog: {
    models: [
      { id: 'research-model', name: 'Research Model · 模拟模型', isDefault: true, reasoningEfforts: [{ effort: 'medium', description: '模型提供的默认档位' }, { effort: 'ultra', description: '模型提供的深入推理档位' }], defaultReasoningEffort: 'medium' },
      { id: 'compact-model', name: 'Compact Model · 模拟模型', reasoningEfforts: [{ effort: 'low', description: '此模型仅提供该档位' }], defaultReasoningEffort: 'low' },
    ], skills: [{ id: 'read-evidence', name: 'read-evidence', description: '模拟研究技能', enabled: true }], plan: true, accessModes: ['read-only', 'full-access'],
  } };
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5173');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Run;
    const path = new URL(request.url!, 'http://localhost').pathname;
    const event = (value: object) => response.write(JSON.stringify(value) + '\n');
    if (path.endsWith('/run')) {
      api.runs.push(body); response.setHeader('Content-Type', 'application/x-ndjson'); response.flushHeaders();
      const session = { nativeSessionId: `composer-native-${api.runs.length}`, nativeSessionRef: fixtureSessionRef(`composer-native-${api.runs.length}`) };
      event({ type: 'session', ...session }); event({ type: 'delta', text: '模拟原生响应：按原文条件核对证据。' });
      if (body.prompt.includes('暂停测试')) { pending.set(body.requestId, response); response.on('close', () => pending.delete(body.requestId)); return; }
      event({ type: 'progress', kind: 'tool', id: 'turn-diff', toolName: 'fileChange', text: '本轮文件变更 · 模拟记录', status: 'done', output: patch });
      event({ type: 'done', model: body.codex?.model || 'research-model', ...session }); response.end(); return;
    }
    if (path.endsWith('/stop')) {
      api.stops.push({ requestId: body.requestId });
      pending.get(body.requestId)?.end(JSON.stringify({ type: 'error', state: 'interrupted', code: 'stopped', error: '原生回合已确认停止。' }) + '\n');
      pending.delete(body.requestId); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ stopped: true, state: 'interrupted' })); return;
    }
    response.writeHead(404); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); api.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await use(api);
  for (const response of pending.values()) response.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
} });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const input = (page: Page) => panel(page).getByLabel('向 AI 提问');
const menu = (page: Page) => panel(page).getByRole('dialog', { name: 'Codex 操作与技能', exact: true });
async function state(page: Page): Promise<WorkspaceData> { return page.evaluate(async () => { const journal = localStorage.getItem('papertrail-recovery-v3'); if (journal) return JSON.parse(journal); const path = '/src/data/storage.ts'; return (await import(path)).loadWorkspace(); }); }
async function start(page: Page, api: API) {
  const seed = createSeed(); for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'codex';
  await mockProjectService(page, { seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: '模拟连接', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: ['codex', 'claude', 'opencode'].map(id => ({ id, name: id, state: 'ready', capabilities: { images: false, tools: true, resume: true, permissions: 'read-only' } })) } }));
  await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: api.catalog }));
  for (const action of ['run', 'stop']) await page.route(`**/api/ai/agents/${action}`, route => route.continue({ url: api.url + new URL(route.request().url()).pathname }));
  await page.goto('/'); await expect(page.getByRole('main')).toBeVisible(); await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Codex 推理强度', exact: true })).toHaveText('Medium');
}
const settings = (page: Page) => panel(page).getByRole('button', { name: 'Codex 对话设置', exact: true });
async function permissions(page: Page) { await settings(page).click(); await menu(page).getByRole('option', { name: 'Codex 访问权限', exact: true }).click(); }
async function fullAccess(page: Page) {
  await permissions(page); await menu(page).getByRole('option', { name: /^完全访问/ }).click();
}
async function setUltra(page: Page) { await panel(page).getByRole('button', { name: 'Codex 推理强度', exact: true }).click(); await menu(page).getByRole('option', { name: /^Ultra/ }).click(); }
async function send(page: Page, prompt: string) { await input(page).fill(prompt); await expect(input(page)).toHaveValue(prompt); await panel(page).getByRole('button', { name: '发送问题', exact: true }).click(); }

test('完全访问需明确确认，权限与推理档位进入请求快照并按研究恢复', async ({ page, api }) => {
  await start(page, api); await input(page).fill('保留权限选择期间的输入'); await permissions(page); await menu(page).press('Escape'); await expect(menu(page)).toContainText('Codex 对话设置'); await expect(menu(page).getByRole('option', { name: 'Codex 访问权限', exact: true })).toBeVisible(); await menu(page).press('Escape'); await expect(settings(page)).toBeFocused(); await expect(panel(page)).toBeVisible(); await fullAccess(page);
  const confirmation = panel(page).getByRole('dialog', { name: '启用完全访问', exact: true });
  await expect(confirmation).toContainText('修改项目外的文件、执行命令及访问网络'); await expect(confirmation).toContainText('/fixture/research-a');
  await confirmation.press('Escape'); await expect(confirmation).not.toBeVisible(); await expect(settings(page)).toBeFocused();
  await expect(settings(page)).toContainText('只读'); await expect(input(page)).toHaveValue('保留权限选择期间的输入'); expect(api.runs).toHaveLength(0);
  await input(page).fill('/permissions'); await input(page).press('Enter'); await menu(page).getByRole('option', { name: /^完全访问/ }).click();
  await confirmation.getByRole('button', { name: '启用完全访问', exact: true }).click(); await setUltra(page); await expect(input(page)).toBeFocused();
  await settings(page).click(); await menu(page).getByRole('option', { name: '切换 Codex Chat/Plan 模式' }).click(); await send(page, '模拟权限快照核查');
  await expect(panel(page).locator('.ai-answer')).toContainText('模拟原生响应'); expect(api.runs[0].codex).toMatchObject({ access: 'full-access', effort: 'ultra', mode: 'plan' });
  expect((await state(page)).requests[api.runs[0].requestId].codex).toEqual(api.runs[0].codex);
  await input(page).fill('/status'); await input(page).press('Enter'); await expect(menu(page).locator('.codex-status')).toContainText('完全访问'); await expect(menu(page).locator('.codex-status')).toContainText('Ultra'); await menu(page).press('Escape');
  await input(page).fill('研究 A 未发送的问题'); await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'); await page.reload();
  await expect(settings(page)).toContainText('完全访问'); await expect(panel(page).getByRole('button', { name: 'Codex 推理强度', exact: true })).toHaveText('Ultra'); await expect(input(page)).toHaveValue('研究 A 未发送的问题');
  await switchResearch(page, 'research-b'); await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(settings(page)).toContainText('只读'); await expect(input(page)).toHaveValue('');
  await switchResearch(page, 'research-a'); await expect(input(page)).toHaveValue('研究 A 未发送的问题'); await expect(settings(page)).toContainText('完全访问');
  expect(api.runs).toHaveLength(1);
});

test('切换模型清理不支持的推理档位，缺少能力时不假造模型或权限', async ({ page, api }) => {
  await start(page, api); await setUltra(page); await panel(page).getByRole('button', { name: '选择 Codex 模型', exact: true }).click(); await menu(page).getByRole('option', { name: /^Compact Model/ }).click();
  await expect(panel(page).getByRole('button', { name: 'Codex 推理强度', exact: true })).toHaveText('Low');
  const current = (await state(page)).conversations['conversation-research-a']; expect(current.codex?.effort).toBeUndefined();
  await input(page).fill('/effort'); await input(page).press('Enter'); await menu(page).getByLabel('搜索 Codex 操作与技能').fill('Ultra'); await expect(menu(page).getByRole('option')).toHaveCount(0); await menu(page).press('Escape');
  await send(page, '模拟模型切换'); await expect(panel(page).locator('.ai-answer')).toContainText('模拟原生响应'); expect(api.runs[0].codex).toMatchObject({ model: 'compact-model' }); expect(api.runs[0].codex?.effort).toBeUndefined();
  api.catalog.models = []; delete api.catalog.accessModes; await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'); await page.reload();
  await expect(panel(page).getByRole('button', { name: 'Codex 推理强度', exact: true })).toHaveCount(0);
  await permissions(page); await expect(menu(page)).toContainText('当前连接未提供可选权限'); await expect(menu(page).getByRole('option')).toHaveCount(1); await expect(menu(page).getByRole('option')).toHaveAttribute('aria-disabled', 'true'); await menu(page).press('Escape'); await menu(page).press('Escape');
  await input(page).fill('/model'); await expect(menu(page).getByRole('option', { name: /^\/model/ })).toHaveAttribute('aria-disabled', 'true'); await input(page).press('Enter'); expect(api.runs).toHaveLength(1);
});

test('加号从当前研究加入原文证据，保留输入且不发送', async ({ page, api }) => {
  await start(page, api); await input(page).fill('带着原文再提问'); await panel(page).getByRole('button', { name: '添加材料', exact: true }).click();
  const dialog = panel(page).getByRole('dialog', { name: '添加对话材料', exact: true }); await dialog.getByLabel('搜索研究证据').fill('Retrieval improves');
  const evidence = dialog.getByRole('button', { name: /Adaptive Retrieval.*PDF 第 3 页/ }); await evidence.click(); await expect(evidence).toContainText('已加入本轮');
  await expect(dialog.getByRole('button', { name: '添加资料', exact: true })).toBeVisible(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(input(page)).toHaveValue('带着原文再提问'); expect((await state(page)).conversations['conversation-research-a'].contextIds).toContain('evidence-a'); expect(api.runs).toHaveLength(0);
});

test('麦克风说明聚焦输入，Escape只关闭局部说明并保留草稿', async ({ page, api }) => {
  await start(page, api); await input(page).fill('先保留听写前的草稿'); await panel(page).getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(panel(page).locator('.ai-voice-hint')).toContainText('使用系统听写'); await expect(panel(page).locator('.ai-voice-hint')).toContainText('识别文字留在草稿，不自动发送'); await expect(input(page)).toBeFocused();
  const hint = panel(page).locator('.ai-voice-hint');
  await expect(hint).toBeInViewport({ ratio: 1 });
  const hintBounds = (await hint.boundingBox())!, composer = (await panel(page).locator('.codex-composer-tools').boundingBox())!; expect(hintBounds.width).toBeGreaterThan(composer.width * .85);
  await expect.poll(() => hint.evaluate(element => {
    const box = element.getBoundingClientRect();
    return [[box.left + 10, box.top + 10], [box.right - 10, box.top + 10], [box.left + 10, box.bottom - 10], [box.right - 10, box.bottom - 10]]
      .every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
  })).toBe(true);
  const close = hint.getByRole('button', { name: '关闭语音输入说明', exact: true });
  await expect(close).toBeInViewport({ ratio: 1 }); await close.click();
  await expect(hint).toHaveCount(0); await expect(input(page)).toBeFocused(); await expect(input(page)).toHaveValue('先保留听写前的草稿');
  await panel(page).getByRole('button', { name: '语音输入', exact: true }).click();
  await input(page).press('Escape'); await expect(panel(page).locator('.ai-voice-hint')).toHaveCount(0); await expect(panel(page)).toBeVisible(); await expect(input(page)).toHaveValue('先保留听写前的草稿'); expect(api.runs).toHaveLength(0);
});

test('生成时锁定设置，圆形停止按钮只停止原请求', async ({ page, api }) => {
  await start(page, api); await send(page, '暂停测试：保留尚未完成的模拟回复');
  const stop = panel(page).getByRole('button', { name: '停止生成', exact: true }); await expect(stop).toBeVisible(); await expect(stop).toHaveCSS('border-radius', '50%');
  for (const name of ['Codex 对话设置', '选择 Codex 模型', 'Codex 推理强度']) await expect(panel(page).getByRole('button', { name, exact: true })).toBeDisabled();
  await stop.click(); await expect.poll(() => api.stops.length).toBe(1); expect(api.stops[0].requestId).toBe(api.runs[0].requestId); expect(api.runs).toHaveLength(1); await expect(stop).toHaveCount(0); await expect(panel(page).locator('.ai-answer')).toContainText('模拟原生响应');
});

test('只展示本轮Codex报告的文件变更节选，展开可核对加减行', async ({ page, api }) => {
  await start(page, api); await send(page, '模拟本轮文件变更'); await expect(panel(page).locator('.ai-answer')).toContainText('模拟原生响应');
  const changes = panel(page).locator('.ai-reported-changes'); await expect(changes.getByText('1 个文件已更改')).toBeVisible(); await expect(changes.locator('ins')).toHaveText('+2'); await expect(changes.locator('del')).toHaveText('−1');
  await changes.locator('summary').click(); await expect(changes).toContainText('未扫描整个项目工作树'); await expect(changes.getByLabel('本轮文件变更')).toHaveText(patch);
});

test('320px侧栏中完全访问、Plan及已选技能仍只占一行，技能可在设置中移除', async ({ page, api }) => {
  api.catalog.skills.push(...['second', 'third', 'fourth'].map(id => ({ id, name: id, description: '模拟技能', enabled: true })));
  await page.setViewportSize({ width: 900, height: 800 }); await start(page, api);
  const resize = panel(page).getByRole('separator', { name: '调整右侧宽度', exact: true });
  await resize.focus(); for (let i = 0; i < 5; i++) await resize.press('ArrowRight');
  await expect.poll(async () => (await panel(page).boundingBox())!.width).toBe(320);
  await fullAccess(page); await panel(page).getByRole('dialog', { name: '启用完全访问', exact: true }).getByRole('button', { name: '启用完全访问', exact: true }).click();
  await settings(page).click(); await menu(page).getByRole('option', { name: '切换 Codex Chat/Plan 模式' }).click();
  for (const name of ['read-evidence', 'second', 'third', 'fourth']) { await input(page).fill(`$${name}`); await input(page).press('Enter'); }
  await expect(settings(page)).toContainText('完全访问'); await expect(settings(page)).toContainText('Plan'); await expect(settings(page).locator('.codex-skill-count')).toHaveText('4');
  await expect(input(page)).toHaveValue(''); expect(api.runs).toHaveLength(0);
  const toolbar = panel(page).locator('.codex-composer-toolbar'); expect((await toolbar.boundingBox())!.height).toBeLessThanOrEqual(40);
  expect(await toolbar.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual((await toolbar.boundingBox())!.width + 1);
  for (const name of ['Codex 对话设置', '选择 Codex 模型', 'Codex 推理强度', '语音输入', '发送问题', '添加材料']) {
    const bounds = (await panel(page).getByRole('button', { name, exact: true }).boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(36); expect(bounds.width).toBeGreaterThanOrEqual(36);
  }
  await page.screenshot({ path: test.info().outputPath('codex-footer-320.png') });
  await input(page).fill('保留窄侧栏草稿'); await settings(page).click(); await expect(menu(page).getByLabel('已选 Codex 技能').locator('span')).toHaveCount(4);
  await menu(page).getByRole('button', { name: '移除技能 fourth', exact: true }).click(); await expect(menu(page).getByLabel('已选 Codex 技能').locator('span')).toHaveCount(3);
  await menu(page).press('Escape'); await expect(settings(page)).toBeFocused(); await expect(input(page)).toHaveValue('保留窄侧栏草稿');
  await expect(settings(page).locator('.codex-skill-count')).toHaveText('3'); expect(api.runs).toHaveLength(0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`原生输入区与中央PDF并列 ${viewport.width}`, async ({ page, api }) => {
    await page.setViewportSize(viewport); await start(page, api); await page.getByRole('main').getByRole('button', { name: 'Adaptive Retrieval: Evidence & Reliability', exact: true }).click();
    await expect(page.getByRole('main').locator('canvas').first()).toBeVisible(); await expect(page.getByRole('main').locator('.pdf-page-loading')).toHaveCount(0);
    await setUltra(page); await send(page, '模拟记录：比较研究条件'); await expect(panel(page).locator('.ai-answer')).toContainText('模拟原生响应'); await input(page).fill('在原文旁继续写下问题');
    const notice = page.getByRole('button', { name: '关闭提示', exact: true }); if (await notice.isVisible()) await notice.click();
    for (const name of ['Codex 对话设置', '选择 Codex 模型', 'Codex 推理强度', '语音输入', '发送问题', '添加材料']) { const bounds = (await panel(page).getByRole('button', { name, exact: true }).boundingBox())!; expect(bounds.height).toBeGreaterThanOrEqual(36); expect(bounds.width).toBeGreaterThanOrEqual(36); }
    const toolbar = panel(page).locator('.codex-composer-toolbar'); expect((await toolbar.boundingBox())!.height).toBeLessThanOrEqual(40);
    const composer = panel(page).locator('.codex-composer-tools'); expect(await composer.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual((await composer.boundingBox())!.width + 1); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await mkdir('docs/verification/native-composer', { recursive: true }); await page.screenshot({ path: `docs/verification/native-composer/composer-${viewport.width}.png` }); expect(api.runs).toHaveLength(1);
  });
}
