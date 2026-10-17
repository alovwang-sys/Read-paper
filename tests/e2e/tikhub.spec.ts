import { mockProjectService, fixtureSessionRef } from './project-fixture';
import { expect, test as base, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';

type Identity = { workspaceId: string; requestId: string; researchId: string; conversationId: string; connectionId: string };
type Run = Identity & { prompt: string; skillIds: string[] };
type Reply = Identity & { interactionId: string; reply: { decision: 'allowOnce' | 'deny' } };
type API = { url: string; runs: Run[]; replies: Reply[]; stops: Identity[]; dataCalls: Run[]; hasCredentials: boolean };
const scope = '已接入 TikHub 工具；凭据由本机服务保管，数据调用可能消耗额度';
const checkArgs = JSON.stringify({ action: 'check', platform: 'douyin' });
const callArgs = JSON.stringify({ action: 'call', platform: 'douyin', tool: 'fetch_one_video', args: { video_id: 'test-video' } });
const checkOutput = '模拟目录：douyin 平台共有 319 个接口；本次仅检查目录，没有调用数据接口。';
const checkAnswer = '抖音接口目录已经核对。接下来如需查询具体视频，应先确认数据调用范围。';
const dataAnswer = '这是模拟数据调用后的原始回答，用于验证审批与原请求的归属。';

// This is an actual streaming HTTP fixture. It never invokes a model, TikHub, or a local credential source.
const test = base.extend<{ api: API }>({ api: async ({}, use) => {
  const api: API = { url: '', runs: [], replies: [], stops: [], dataCalls: [], hasCredentials: true };
  const pending = new Map<string, { run: Run; response: ServerResponse; interactionId: string }>();
  const event = (response: ServerResponse, value: object) => response.write(JSON.stringify(value) + '\n');
  const finish = (response: ServerResponse, text: string) => {
    event(response, { type: 'delta', text }); event(response, { type: 'done', model: 'mock-codex', nativeSessionId: 'mock-tikhub-session', nativeSessionRef: fixtureSessionRef('mock-tikhub-session') }); response.end();
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5173'); res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.end(); return; }
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path === '/api/ai/config') { json({ configured: false, model: 'test', images: false, mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } }); return; }
    if (path === '/api/ai/agents') { json({ agents: [{ id: 'codex', name: 'Codex', state: 'ready', capabilities: { images: false, tools: true, resume: true, permissions: 'read-only' } }] }); return; }
    if (path.endsWith('/codex/capabilities')) {
      json({ skills: [
        { id: 'tikhub', name: 'tikhub', description: `${scope}（模拟目录）`, enabled: api.hasCredentials, ...(!api.hasCredentials ? { disabledReason: '本机服务未配置 TikHub 凭据，请完成本机配置后重新读取能力。' } : {}) },
        { id: 'unknown-mcp', name: 'unknown-mcp', description: '依赖尚未接入的 MCP 服务', enabled: false, disabledReason: '依赖的 MCP 服务未接入当前研究连接，不能执行。' },
      ], models: [{ id: 'mock-codex', name: 'Mock Codex', isDefault: true }], plan: true }); return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (path.endsWith('/run')) {
      const run = body as Run; api.runs.push(run); res.setHeader('Content-Type', 'application/x-ndjson'); res.flushHeaders();
      event(res, { type: 'session', nativeSessionId: 'mock-tikhub-session', nativeSessionRef: fixtureSessionRef('mock-tikhub-session') });
      if (run.prompt.includes('目录')) {
        const progress = { type: 'progress', kind: 'tool', id: `check-${run.requestId}`, toolName: 'read_paper_tikhub', command: checkArgs };
        event(res, { ...progress, text: '检查抖音接口目录', status: 'running' });
        event(res, { ...progress, text: '抖音接口目录检查完成', status: 'done', output: checkOutput });
        finish(res, checkAnswer);
      } else {
        const interactionId = `tikhub-call-${run.requestId}`;
        event(res, { type: 'interaction', interaction: { id: interactionId, kind: 'approval', title: '允许本次 TikHub 数据调用？', detail: `${scope}。平台：douyin；工具：fetch_one_video；参数：video_id=test-video。仅批准当前请求。`, command: callArgs, status: 'pending' } });
        pending.set(run.requestId, { run, response: res, interactionId });
        res.on('close', () => { if (pending.get(run.requestId)?.response === res) pending.delete(run.requestId); });
      }
      return;
    }
    if (path.endsWith('/respond')) {
      const reply = body as Reply, original = pending.get(reply.requestId);
      if (!original || original.interactionId !== reply.interactionId || !(['workspaceId', 'researchId', 'conversationId', 'connectionId'] as const).every(key => original.run[key] === reply[key])) { res.statusCode = 409; json({ error: '原请求已结束或身份不匹配。' }); return; }
      api.replies.push(reply);
      event(original.response, { type: 'interaction-resolved', id: reply.interactionId, status: reply.reply.decision === 'deny' ? 'denied' : 'answered' });
      if (reply.reply.decision === 'deny') finish(original.response, '你已拒绝，本次没有调用 TikHub 数据接口。');
      else {
        api.dataCalls.push(original.run);
        const progress = { type: 'progress', kind: 'tool', id: `data-${reply.requestId}`, toolName: 'read_paper_tikhub', command: callArgs };
        event(original.response, { ...progress, text: '执行本次已批准的抖音数据查询', status: 'running' });
        event(original.response, { ...progress, text: '本次数据查询完成', status: 'done', output: '模拟视频数据：test-video。未请求任何真实数据。' });
        finish(original.response, dataAnswer);
      }
      pending.delete(reply.requestId); json({ accepted: true }); return;
    }
    if (path.endsWith('/stop')) { api.stops.push(body as Identity); pending.get(body.requestId)?.response.end(); pending.delete(body.requestId); json({ stopped: true }); return; }
    res.statusCode = 404; json({ error: 'not found' });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); api.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await use(api);
  for (const item of pending.values()) item.response.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
} });

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const approval = (page: Page) => panel(page).getByRole('region', { name: 'Codex 工具审批' }).last();
async function start(page: Page, api: API, pdf = false) {
  await page.route('**/api/ai/**', route => route.continue({ url: api.url + new URL(route.request().url()).pathname }));
  await mockProjectService(page);
  await page.goto('/'); await expect(page.getByRole('main')).toBeVisible();
  if (pdf) {
    await page.getByRole('main').getByRole('button', { name: /Adaptive Retrieval: Evidence & Reliability/ }).click();
    await expect(page.getByRole('main').locator('canvas').first()).toBeVisible(); await expect(page.getByRole('main').locator('.pdf-page-loading')).toHaveCount(0);
  }
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click(); await panel(page).getByRole('button', { name: 'Codex', exact: true }).click();
  const notice = page.getByRole('button', { name: '关闭提示', exact: true }); if (await notice.isVisible()) await notice.click();
}
async function chooseTikHub(page: Page) {
  const input = panel(page).getByLabel('向 AI 提问'); await input.fill('$tikhub');
  const option = panel(page).getByRole('option', { name: /\$tikhub/ }); await expect(option).toHaveAttribute('aria-disabled', 'false'); await expect(option).toContainText(scope); await input.press('Enter');
  await expect(panel(page).getByLabel('已选 Codex 技能')).toContainText('$tikhub');
}
async function send(page: Page, prompt: string) { await panel(page).getByLabel('向 AI 提问').fill(prompt); await panel(page).getByRole('button', { name: '发送问题', exact: true }).click(); }

test('TikHub 技能已接入且未知MCP仍禁用，目录工具过程独立于回答正文', async ({ page, api }) => {
  await start(page, api); await panel(page).getByLabel('向 AI 提问').fill('$');
  await expect(panel(page).getByRole('option', { name: /\$unknown-mcp/ })).toHaveAttribute('aria-disabled', 'true');
  await expect(panel(page).getByRole('option', { name: /\$unknown-mcp/ })).toContainText('MCP 服务未接入');
  await chooseTikHub(page); await send(page, '检查抖音接口目录');
  await expect(panel(page).locator('.ai-answer')).toHaveText(checkAnswer);
  expect(api.runs[0].skillIds).toEqual(['tikhub']); expect(api.replies).toHaveLength(0); expect(api.dataCalls).toHaveLength(0);
  await panel(page).locator('.ai-agent-events > summary').click(); await expect(panel(page).locator('.ai-tool-call')).toHaveCount(1);
  const tool = panel(page).locator('.ai-tool-call'); await expect(tool.locator('summary')).toContainText('read_paper_tikhub'); await expect(tool.locator('summary')).toContainText('已完成');
  await tool.locator('summary').click(); await expect(tool.locator('.ai-tool-output')).toHaveText(checkOutput); await expect(tool.locator('pre').first()).toHaveText(checkArgs);
  await expect(panel(page).locator('.ai-answer')).not.toContainText('319');
});

test('TikHub 数据调用逐次审批，拒绝不查询、允许绑定原研究、停止使审批失效', async ({ page, api }) => {
  await start(page, api); await chooseTikHub(page); await send(page, '查询这条抖音视频');
  await expect(approval(page)).toContainText('可能消耗额度'); await expect(approval(page)).toContainText('douyin'); await expect(approval(page)).toContainText('fetch_one_video'); await expect(approval(page).locator('pre')).toHaveText(callArgs);
  expect(api.replies).toHaveLength(0); expect(api.dataCalls).toHaveLength(0);
  await approval(page).getByRole('button', { name: '拒绝', exact: true }).click(); await expect(panel(page).locator('.ai-answer')).toHaveText('你已拒绝，本次没有调用 TikHub 数据接口。');
  expect(api.replies[0].reply).toEqual({ decision: 'deny' }); expect(api.dataCalls).toHaveLength(0); await expect(panel(page).locator('.ai-tool-call')).toHaveCount(0);
  await send(page, '再次查询这条抖音视频'); await expect(approval(page).getByRole('button', { name: '允许本次', exact: true })).toBeEnabled();
  expect(api.replies).toHaveLength(1); expect(api.dataCalls).toHaveLength(0);
  await page.getByLabel('切换研究').selectOption('research-b'); await panel(page).getByRole('tab', { name: 'AI', exact: true }).click(); await expect(approval(page)).toHaveCount(0);
  await page.getByLabel('切换研究').selectOption('research-a'); await approval(page).getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(panel(page).locator('.ai-answer').last()).toHaveText(dataAnswer);
  expect(api.replies[1]).toMatchObject({ ...Object.fromEntries((['workspaceId', 'requestId', 'researchId', 'conversationId', 'connectionId'] as const).map(key => [key, api.runs[1][key]])), reply: { decision: 'allowOnce' } });
  expect(api.dataCalls.map(run => run.requestId)).toEqual([api.runs[1].requestId]);
  await send(page, '第三次查询这条抖音视频'); await expect(approval(page).getByRole('button', { name: '允许本次', exact: true })).toBeEnabled(); expect(api.replies).toHaveLength(2);
  await panel(page).getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(approval(page).getByRole('button', { name: '允许本次', exact: true })).toBeDisabled(); await expect(approval(page).getByRole('button', { name: '拒绝', exact: true })).toBeDisabled();
  expect(api.replies).toHaveLength(2); expect(api.dataCalls).toHaveLength(1); await expect.poll(() => api.stops.at(-1)?.requestId).toBe(api.runs[2].requestId);
});

test('TikHub 缺少本机凭据时说明原因，刷新能力后原会话可选择', async ({ page, api }) => {
  api.hasCredentials = false; await start(page, api); await panel(page).getByLabel('向 AI 提问').fill('$tikhub');
  const option = panel(page).getByRole('option', { name: /\$tikhub/ }); await expect(option).toHaveAttribute('aria-disabled', 'true'); await expect(option).toContainText('本机服务未配置 TikHub 凭据');
  await panel(page).getByLabel('向 AI 提问').press('Enter'); await expect(panel(page).getByLabel('已选 Codex 技能')).toHaveCount(0); expect(api.runs).toHaveLength(0);
  api.hasCredentials = true;
  await panel(page).getByRole('button', { name: '刷新 Codex 能力', exact: true }).click();
  await expect(option).toHaveAttribute('aria-disabled', 'false'); await expect(option).toContainText(scope);
  await option.click(); await expect(panel(page).getByLabel('已选 Codex 技能')).toContainText('$tikhub'); expect(api.runs).toHaveLength(0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`中央PDF与TikHub目录说明并列 ${viewport.width}×${viewport.height}`, async ({ page, api }) => {
    await page.setViewportSize(viewport); await start(page, api, true); await chooseTikHub(page); await send(page, '检查抖音接口目录');
    await expect(panel(page).locator('.ai-answer')).toHaveText(checkAnswer); await panel(page).locator('.ai-agent-events > summary').click();
    await panel(page).getByRole('log', { name: '对话消息' }).evaluate(element => { element.scrollTop = 0; });
    await panel(page).getByLabel('向 AI 提问').fill('$'); await expect(panel(page).getByRole('option', { name: /\$tikhub/ })).toContainText(scope);
    const right = (await panel(page).boundingBox())!, pdf = (await page.getByRole('main').locator('canvas').first().boundingBox())!;
    expect(pdf.x + pdf.width).toBeLessThanOrEqual(right.x + 1); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const menu = (await panel(page).getByRole('dialog', { name: 'Codex 操作与技能' }).boundingBox())!; expect(menu.y).toBeGreaterThanOrEqual(0); expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width);
    await mkdir('docs/verification/agents', { recursive: true }); await page.screenshot({ path: `docs/verification/agents/tikhub-${viewport.width}.png` });
    expect(api.dataCalls).toHaveLength(0);
  });
}
