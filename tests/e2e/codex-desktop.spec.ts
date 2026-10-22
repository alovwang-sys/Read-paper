import { switchResearch } from './knowledge-helpers';
import { mockProjectService, fixtureSessionRef } from './project-fixture';
import { expect, test as base, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import type { WorkspaceData } from '../../src/domain/types';

type API = { url: string; runs: Record<string, any>[]; replies: Record<string, any>[]; stops: Record<string, any>[] };
const test = base.extend<{ api: API }>({ api: async ({}, use) => {
  const runs: Record<string, any>[] = [], replies: Record<string, any>[] = [], stops: Record<string, any>[] = [];
  const pending = new Map<string, ServerResponse>();
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5173'); res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.end(); return; }
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    const event = (response: ServerResponse, value: object) => response.write(JSON.stringify(value) + '\n');
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path === '/api/ai/config') { json({ configured: false, model: 'test', images: false, mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } }); return; }
    if (path === '/api/ai/agents') { json({ agents: ['codex', 'claude', 'opencode'].map(id => ({ id, name: id, state: 'ready', capabilities: { images: false, tools: id === 'codex', resume: true, permissions: 'read-only' } })) }); return; }
    if (path.endsWith('/codex/capabilities')) { json({ skills: [{ id: 'paper-reader', name: 'paper-read', description: '解释论文所选证据', enabled: true }, ...['evidence-check', 'compare-results', 'outline', 'methods'].map(name => ({ id: name, name, description: `研究技能 ${name}`, enabled: true })), { id: 'write-files', name: 'write-files', description: '写入文件', enabled: false, disabledReason: '当前研究连接未开放写入能力' }], models: [{ id: 'model-default', name: 'Default model', isDefault: true }, { id: 'model-research', name: 'Research model' }], plan: true }); return; }
    let body: Record<string, any> = {}; const chunks = []; for await (const chunk of req) chunks.push(chunk); if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString());
    if (path.endsWith('/run')) {
      runs.push(body); res.setHeader('Content-Type', 'application/x-ndjson'); res.flushHeaders();
      event(res, { type: 'session', nativeSessionId: `native-${runs.length}`, nativeSessionRef: fixtureSessionRef(`native-${runs.length}`) });
      if (/审批|问题/.test(body.prompt)) {
        const interaction = body.prompt.includes('审批') ? { id: `approval-${runs.length}`, kind: 'approval', title: '允许读取这次材料？', detail: 'Codex 正在等待本次工具操作的决定。', command: 'cat materials.md', status: 'pending' } : { id: `question-${runs.length}`, kind: 'question', title: '需要补充研究偏好', questions: [{ id: 'format', header: '输出形式', ...(body.prompt.includes('限定选项') ? { allowOther: false } : {}), question: '希望怎样组织解释？', options: [{ label: '概览', description: '先说明核心结论' }, { label: '比较', description: '对照条件与限制' }] }], status: 'pending' };
        event(res, { type: 'interaction', interaction }); pending.set(body.requestId, res); res.on('close', () => { if (pending.get(body.requestId) === res) pending.delete(body.requestId); });
      } else { event(res, { type: 'delta', text: '保留原文条件，再核对这项结论。' }); event(res, { type: 'done', model: body.codex?.model || 'model-default', nativeSessionId: `native-${runs.length}`, nativeSessionRef: fixtureSessionRef(`native-${runs.length}`) }); res.end(); }
      return;
    }
    if (path.endsWith('/respond')) {
      replies.push(body); const stream = pending.get(body.requestId);
      if (stream) { event(stream, { type: 'interaction-resolved', id: body.interactionId, status: body.reply.decision === 'deny' ? 'denied' : 'answered' }); event(stream, { type: 'delta', text: '已按答复继续完成原研究的问题。' }); event(stream, { type: 'done', model: 'model-default', nativeSessionId: `native-${runs.length}`, nativeSessionRef: fixtureSessionRef(`native-${runs.length}`) }); stream.end(); pending.delete(body.requestId); }
      json({ accepted: true }); return;
    }
    if (path.endsWith('/stop')) { stops.push(body); pending.get(body.requestId)?.end(); pending.delete(body.requestId); json({ stopped: true }); return; }
    res.statusCode = 404; json({ error: 'not found' });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  await use({ url: `http://127.0.0.1:${address.port}`, runs, replies, stops });
  for (const response of pending.values()) response.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
} });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
async function state(page: Page): Promise<WorkspaceData> { return page.evaluate(() => JSON.parse(localStorage.getItem('papertrail-recovery-v3')!)); }
async function start(page: Page, api: API) {
  await page.route('**/api/ai/**', route => route.continue({ url: api.url + new URL(route.request().url()).pathname }));
  await mockProjectService(page);
  await page.goto('/'); await expect(page.getByRole('main')).toBeVisible();
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click(); await panel(page).getByRole('button', { name: 'Codex', exact: true }).click();
}
async function selectedSkills(page: Page, count: number) {
  await panel(page).getByRole('button', { name: 'Codex 对话设置', exact: true }).click();
  if (count) await expect(panel(page).getByLabel('已选 Codex 技能').locator('span')).toHaveCount(count);
  else await expect(panel(page).getByLabel('已选 Codex 技能')).toHaveCount(0);
  await panel(page).getByRole('dialog', { name: 'Codex 操作与技能' }).press('Escape');
}
async function send(page: Page, text: string) { await panel(page).getByLabel('向 AI 提问').fill(text); await panel(page).getByRole('button', { name: '发送问题', exact: true }).click(); }

test('Codex 真实目录菜单、技能chips和模型/Plan快照持久化', async ({ page, api }) => {
  await start(page, api); const input = panel(page).getByLabel('向 AI 提问');
  await input.fill('$paper'); await expect(panel(page).getByRole('option', { name: /\$paper-read/ })).toBeVisible(); await input.press('Enter');
  await selectedSkills(page, 1); await expect(input).toHaveValue('');
  await input.fill('/model'); await input.press('Enter');
  await panel(page).getByLabel('搜索 Codex 操作与技能').fill('Research'); await panel(page).getByRole('option', { name: /Research model/ }).click();
  await panel(page).getByRole('button', { name: 'Codex 对话设置', exact: true }).click(); await panel(page).getByRole('option', { name: '切换 Codex Chat/Plan 模式' }).click();
  await expect(panel(page).getByRole('button', { name: 'Codex 对话设置', exact: true })).toContainText('Plan');
  await input.fill('/'); await expect(panel(page).getByRole('dialog', { name: 'Codex 操作与技能' })).toBeVisible(); await input.press('Escape');
  await expect(panel(page).getByRole('dialog', { name: 'Codex 操作与技能' })).toHaveCount(0); await expect(panel(page)).toBeVisible();
  await input.fill('/compact'); await input.press('Control+Enter'); expect(api.runs).toHaveLength(0); await expect(panel(page)).toContainText('未提供的命令不会被模拟执行'); await input.press('Escape');
  await send(page, '解释所选论文证据'); await expect(panel(page).locator('.ai-answer')).toContainText('保留原文条件');
  expect(api.runs[0]).toMatchObject({ skillIds: ['paper-reader'], codex: { model: 'model-research', mode: 'plan' } });
  await panel(page).locator('.ai-turn-range > summary').click(); await expect(panel(page).locator('.codex-request-settings')).toContainText('Plan · model-research'); await expect(panel(page).locator('.codex-request-settings')).toContainText('paper-read');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'); await page.reload();
  await selectedSkills(page, 1); await expect(panel(page).getByRole('button', { name: 'Codex 对话设置', exact: true })).toContainText('Plan');
  for (const name of ['evidence-check', 'compare-results', 'outline']) {
    await input.fill(`$${name}`); await input.press('Enter');
  }
  await selectedSkills(page, 4);
  await input.fill('$methods'); await expect(panel(page).getByRole('option', { name: /\$methods/ })).toHaveAttribute('aria-disabled', 'true');
  await expect(panel(page).getByRole('option', { name: /\$methods/ })).toContainText('最多选择 4 个技能'); await input.press('Enter');
  await input.press('Escape'); await selectedSkills(page, 4);
  await input.fill('/'); await input.press('ArrowUp');
  const activeBounds = (await panel(page).getByRole('dialog', { name: 'Codex 操作与技能' }).getByRole('option', { selected: true }).boundingBox())!;
  const menuBounds = (await panel(page).getByRole('dialog', { name: 'Codex 操作与技能' }).boundingBox())!;
  expect(activeBounds.y + activeBounds.height).toBeLessThanOrEqual(menuBounds.y + menuBounds.height); await input.press('Escape');
  const conversationId = (await state(page)).sessions['research-a'].activeConversationId!;
  await panel(page).getByLabel('向 AI 提问').fill('/new'); await panel(page).getByLabel('向 AI 提问').press('Enter');
  await selectedSkills(page, 0); expect((await state(page)).conversations[conversationId].skills?.[0].id).toBe('paper-reader');
});

test('原生问题草稿按原研究保存，答复继续原请求，停止后交互失效', async ({ page, api }) => {
  await start(page, api); await send(page, '原生问题：请确认输出形式');
  const question = panel(page).getByRole('region', { name: 'Codex 问题答复' }); await expect(question).toBeVisible();
  await question.getByRole('checkbox', { name: /比较/ }).check(); await question.getByLabel('补充回答：输出形式').fill('保留实验条件与限制');
  await switchResearch(page, 'research-b'); await panel(page).getByRole('tab', { name: 'AI', exact: true }).click(); await expect(panel(page).getByRole('region', { name: 'Codex 问题答复' })).toHaveCount(0);
  await switchResearch(page, 'research-a'); await expect(question.getByLabel('补充回答：输出形式')).toHaveValue('保留实验条件与限制');
  await question.getByRole('button', { name: '提交答复', exact: true }).click(); await expect(panel(page).locator('.ai-answer')).toContainText('继续完成原研究');
  expect(api.replies[0]).toMatchObject({ researchId: 'research-a', requestId: api.runs[0].requestId, conversationId: api.runs[0].conversationId, reply: { answers: { format: ['比较', '保留实验条件与限制'] } } });
  await send(page, '限定选项问题'); await expect(panel(page).getByRole('region', { name: 'Codex 问题答复' }).last()).toBeVisible();
  await expect(panel(page).getByRole('region', { name: 'Codex 问题答复' }).last().getByLabel('补充回答：输出形式')).toHaveCount(0);
  await panel(page).getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(panel(page).getByRole('region', { name: 'Codex 问题答复' }).last().getByRole('button', { name: '提交答复', exact: true })).toBeDisabled(); expect(api.replies).toHaveLength(1);
});

test('工具审批只允许本次或拒绝，不自动改变其他请求', async ({ page, api }) => {
  await start(page, api); await send(page, '审批：只读检查材料');
  await panel(page).getByRole('region', { name: 'Codex 工具审批' }).getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(panel(page).locator('.ai-answer')).toContainText('继续完成原研究'); expect(api.replies[0].reply).toEqual({ decision: 'deny' });
  await send(page, '审批：本次允许读取'); await expect.poll(() => api.runs.length).toBe(2);
  const secondTurn = panel(page).locator(`[data-request-id="${api.runs[1].requestId}"]`);
  const allow = secondTurn.getByRole('region', { name: 'Codex 工具审批' }).getByRole('button', { name: '允许本次', exact: true });
  await expect(allow).toBeEnabled(); await allow.click();
  await expect(secondTurn.locator('.ai-answer')).toContainText('继续完成原研究'); expect(api.replies[1]).toMatchObject({ requestId: api.runs[1].requestId, reply: { decision: 'allowOnce' } });
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`Codex 桌面交互 ${viewport.width}×${viewport.height}`, async ({ page, api }) => {
    await page.setViewportSize(viewport); await start(page, api);
    await page.getByRole('main').getByRole('button', { name: 'Adaptive Retrieval: Evidence & Reliability', exact: true }).click();
    await expect(page.getByRole('main').locator('canvas').first()).toBeVisible(); await expect(page.getByRole('main').locator('.pdf-page-loading')).toHaveCount(0);
    const notice = page.getByRole('button', { name: '关闭提示', exact: true }); if (await notice.isVisible()) await notice.click();
    await panel(page).getByLabel('向 AI 提问').fill('$');
    await expect(panel(page).getByRole('option', { name: /\$write-files/ })).toHaveAttribute('aria-disabled', 'true');
    await expect(panel(page).getByRole('option', { name: /\$write-files/ })).toContainText('未开放写入');
    const menu = (await panel(page).getByRole('dialog', { name: 'Codex 操作与技能' }).boundingBox())!;
    expect(menu.x).toBeGreaterThanOrEqual(0); expect(menu.y).toBeGreaterThanOrEqual(0); expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width);
    await mkdir('docs/verification/agents', { recursive: true });
    await page.screenshot({ path: `docs/verification/agents/codex-desktop-menu-${viewport.width}.png` });
    await panel(page).getByLabel('向 AI 提问').press('Escape'); await send(page, '原生问题：补充研究偏好');
    await expect(panel(page).getByRole('region', { name: 'Codex 问题答复' })).toBeVisible();
    await panel(page).getByRole('log', { name: '对话消息' }).evaluate(element => { element.scrollTop = 0; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: `docs/verification/agents/codex-desktop-question-${viewport.width}.png` });
    await panel(page).getByRole('button', { name: '停止生成', exact: true }).click();
  });
}
