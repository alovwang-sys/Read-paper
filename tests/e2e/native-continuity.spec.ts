import { test as base, expect, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { AgentInteraction, NativeTurnItem, NativeUserInput, WorkspaceData } from '../../src/domain/types';
import { fixtureSessionRef, mockProjectService } from './project-fixture';
import { openSource } from './knowledge-helpers';

type Frame = Record<string, unknown>;
type Run = { requestId: string; conversationId: string; researchId: string; managed: boolean; history: unknown[]; prompt: string };
type RecordState = { seq: number; body: string; items: NativeTurnItem[]; interactions: AgentInteraction[]; supplementalInputs: NativeUserInput[]; state: string; delivery: string; nativeSessionId: string; nativeSessionRef: string; nativeTurnId: string; model: string; error?: string };
type Runtime = { url: string; runs: Run[]; observes: Record<string, unknown>[]; replies: Record<string, unknown>[]; controls: Record<string, unknown>[]; rejectControl?: boolean;
  emit(id: string, event: Frame): void; disconnect(id: string): void; finish(id: string, body: string): void };
const ndjson = (event: Frame) => JSON.stringify(event) + '\n';
const test = base.extend<{ runtime: Runtime }>({ runtime: async ({}, use) => {
  const records = new Map<string, RecordState>(), observers = new Map<string, Set<ServerResponse>>();
  const api: Runtime = { url: '', runs: [], observes: [], replies: [], controls: [],
    emit(id, event) {
      const record = records.get(id)!; record.seq++;
      if (event.type === 'delta') record.body += String(event.text);
      if (event.type === 'item') {
        const item = event.item as NativeTurnItem, index = record.items.findIndex(existing => existing.id === item.id);
        if (index < 0) record.items.push(item); else record.items[index] = item;
      }
      if (event.type === 'interaction') { record.interactions.push(event.interaction as AgentInteraction); record.state = 'waiting-input'; }
      if (event.type === 'user-input') record.supplementalInputs.push(event.input as NativeUserInput);
      if (event.type === 'interaction-resolved') { const item = record.interactions.find(item => item.id === event.id); if (item) item.status = 'answered'; }
      if (event.state) record.state = String(event.state);
      if (event.error) record.error = String(event.error);
      if (event.type === 'done') { record.body = String(event.body ?? record.body); record.state = 'completed'; }
      for (const response of observers.get(id) ?? []) response.write(ndjson({ ...event, seq: record.seq }));
      if (['completed', 'failed', 'interrupted'].includes(record.state)) for (const response of [...observers.get(id) ?? []]) response.end();
    },
    disconnect(id) { for (const response of [...observers.get(id) ?? []]) response.destroy(); },
    finish(id, body) { api.emit(id, { type: 'item', item: { id: `${id}-final`, type: 'agentMessage', status: 'done', phase: 'final_answer', text: body } }); api.emit(id, { type: 'done', body, nativeSessionId: 'stable-thread', nativeTurnId: records.get(id)!.nativeTurnId }); },
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()), id = body.requestId as string;
    if (request.url?.endsWith('/control')) {
      api.controls.push(body); const record = records.get(id)!; response.setHeader('Content-Type', 'application/json');
      if (api.rejectControl || body.expectedTurnId !== record.nativeTurnId) { response.statusCode = 409; response.end(JSON.stringify({ code: 'turn_changed', error: '原生回合已经变化，补充未发送。' })); return; }
      api.emit(id, { type: 'user-input', input: { id: body.inputId, text: body.text, createdAt: new Date().toISOString(), afterItemId: record.items.at(-1)?.id } });
      response.end(JSON.stringify({ accepted: true, nativeTurnId: record.nativeTurnId, inputId: body.inputId })); return;
    }
    if (request.url?.endsWith('/respond')) {
      api.replies.push(body); api.emit(id, { type: 'interaction-resolved', id: body.interactionId, status: 'answered' });
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ accepted: true })); return;
    }
    if (request.url?.endsWith('/stop')) { api.emit(id, { type: 'state', state: 'stopping' }); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ stopped: true, state: 'stopping' })); return; }
    if (request.url?.endsWith('/run')) {
      api.runs.push(body); records.set(id, { seq: 1, body: '', items: [], interactions: [], supplementalInputs: [], state: 'running', delivery: 'accepted', nativeSessionId: 'stable-thread', nativeSessionRef: fixtureSessionRef('stable-thread'), nativeTurnId: `turn-${api.runs.length}`, model: 'fixture-model' });
    } else api.observes.push(body);
    const record = records.get(id);
    if (!record) { response.statusCode = 404; response.end(JSON.stringify({ code: 'run_not_found' })); return; }
    response.setHeader('Content-Type', 'application/x-ndjson'); response.flushHeaders();
    response.write(ndjson({ type: 'snapshot', ...record }));
    if (['completed', 'failed', 'interrupted'].includes(record.state)) { response.end(); return; }
    const group = observers.get(id) ?? new Set(); observers.set(id, group); group.add(response); response.on('close', () => group.delete(response));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); api.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await use(api);
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
} });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const input = (page: Page) => panel(page).getByLabel('向 AI 提问');
async function state(page: Page): Promise<WorkspaceData> { return page.evaluate(async () => { const path = '/src/data/storage.ts'; return JSON.parse(localStorage.getItem('papertrail-recovery-v3') || 'null') ?? (await import(path)).loadWorkspace(); }); }
async function start(page: Page, runtime: Runtime) {
  const seed = createSeed(); Object.values(seed.conversations).forEach(conversation => { conversation.connectionId = 'codex'; });
  await mockProjectService(page, { seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: 'fixture-model', mode: 'live' } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [{ id: 'codex', name: 'Codex', state: 'ready', capabilities: { images: false, tools: true, resume: true, permissions: 'read-only' } }] } }));
  await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: { models: [{ id: 'fixture-model', name: 'Fixture', isDefault: true }], skills: [], plan: true, accessModes: ['read-only'] } }));
  for (const action of ['run', 'observe', 'stop', 'respond', 'control']) await page.route(`**/api/ai/agents/${action}`, route => route.continue({ url: `${runtime.url}/${action}` }));
  await page.goto('/'); await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
  await expect(page.getByRole('main').locator('canvas').first()).toBeVisible(); await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
}
async function send(page: Page, runtime: Runtime, text: string) { const count = runtime.runs.length; await input(page).fill(text); await panel(page).getByRole('button', { name: '发送问题', exact: true }).click(); await expect.poll(() => runtime.runs.length).toBe(count + 1); await expect(input(page)).toHaveValue(''); return runtime.runs[count]; }

test('断流只恢复观察，连续下一轮仍使用同一原生线程且不发送历史正文', async ({ page, runtime }) => {
  await start(page, runtime); const first = await send(page, runtime, '解释当前论文的适用条件');
  runtime.emit(first.requestId, { type: 'item', item: { id: 'first-answer', type: 'agentMessage', status: 'running', phase: 'final_answer', text: '正在核对原文的条件。' } });
  runtime.emit(first.requestId, { type: 'delta', text: '正在核对原文的条件。' });
  await expect(panel(page).locator('.ai-native-message')).toContainText('正在核对原文的条件。');
  await input(page).fill('补充：不要忽略前提条件'); await panel(page).getByRole('button', { name: '补充本轮', exact: true }).click();
  await expect.poll(() => runtime.controls.length).toBe(1); await expect(input(page)).toHaveValue('');
  expect(runtime.controls[0]).toMatchObject({ requestId: first.requestId, expectedTurnId: 'turn-1', text: '补充：不要忽略前提条件' });
  await expect(panel(page).locator('.ai-native-timeline')).toContainText('补充：不要忽略前提条件');
  await input(page).fill('保留这条下一轮草稿'); runtime.disconnect(first.requestId);
  await expect.poll(() => runtime.observes.length).toBeGreaterThan(0);
  await expect(input(page)).toHaveValue('保留这条下一轮草稿'); expect(runtime.runs).toHaveLength(1);
  runtime.emit(first.requestId, { type: 'item', item: { id: 'first-answer', type: 'agentMessage', status: 'done', phase: 'final_answer', text: '已完整核对原文的条件。' } });
  runtime.emit(first.requestId, { type: 'done', body: '已完整核对原文的条件。' });
  await expect.poll(async () => (await state(page)).requests[first.requestId].status).toBe('done');
  await expect(panel(page).locator('.ai-native-message')).toHaveCount(1);
  const second = await send(page, runtime, '保留这条下一轮草稿'); runtime.finish(second.requestId, '同一个线程中的第二轮回答。');
  await expect.poll(async () => (await state(page)).requests[second.requestId].status).toBe('done');
  const current = await state(page); expect(current.requests[first.requestId].nativeSessionId).toBe('stable-thread'); expect(current.requests[second.requestId].nativeSessionId).toBe('stable-thread');
  expect(current.requests[first.requestId].nativeTurnId).not.toBe(current.requests[second.requestId].nativeTurnId);
  expect(second).toMatchObject({ managed: true, history: [] }); expect(current.requests[second.requestId].history).toEqual([]); expect(current.requests[second.requestId].historyRequestIds).toEqual([first.requestId]);
});

test('原生回合变化时补充明确失败，草稿保留且不创建另一轮', async ({ page, runtime }) => {
  await start(page, runtime); const first = await send(page, runtime, '核对回合身份'); runtime.rejectControl = true;
  await input(page).fill('只发给原来回合的补充'); await panel(page).getByRole('button', { name: '补充本轮', exact: true }).click();
  await expect(panel(page).getByRole('alert').filter({ hasText: '原生回合已经变化' })).toBeVisible();
  await expect(input(page)).toHaveValue('只发给原来回合的补充'); expect(runtime.runs).toHaveLength(1);
  expect((await state(page)).requests[first.requestId].supplementalInputs ?? []).toEqual([]);
  runtime.finish(first.requestId, '原回合完成。'); await expect.poll(async () => (await state(page)).requests[first.requestId].status).toBe('done');
});

test('等待用户时刷新恢复同一回合，工具顺序和草稿保持，压缩与停止按原生状态显示', async ({ page, runtime }) => {
  await start(page, runtime); const first = await send(page, runtime, '核对来源后向我确认');
  runtime.emit(first.requestId, { type: 'item', item: { id: 'commentary', type: 'agentMessage', status: 'done', phase: 'commentary', text: '先核对当前研究材料。' } });
  runtime.emit(first.requestId, { type: 'item', item: { id: 'read-source', type: 'commandExecution', status: 'done', toolName: '读取论文', command: 'cat Papertrail/来源.md', output: '来源存在且页码有效', exitCode: 0 } });
  runtime.emit(first.requestId, { type: 'interaction', interaction: { id: 'confirm-scope', kind: 'question', title: '核对范围', status: 'pending', afterItemId: 'read-source', questions: [{ id: 'scope', header: '范围', question: '还需要核对哪些条件？', options: [{ label: '当前论文', description: '继续同一论文' }], allowOther: true }] } });
  await panel(page).getByLabel('补充回答：范围').fill('保留用户选择的核对范围'); await input(page).fill('尚未发送的下一问');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'); await page.reload();
  await expect(page.getByRole('main').locator('canvas').first()).toBeVisible();
  await expect(page.getByRole('main').locator('.pdf-page-loading')).toHaveCount(0);
  await expect(panel(page).getByLabel('补充回答：范围')).toHaveValue('保留用户选择的核对范围'); await expect(input(page)).toHaveValue('尚未发送的下一问');
  await expect.poll(() => runtime.observes.length).toBeGreaterThan(0); expect(runtime.runs).toHaveLength(1);
  await expect(panel(page).locator('.ai-native-timeline').locator('> .ai-native-message')).toContainText('先核对当前研究材料。');
  await mkdir('docs/verification/native-continuity', { recursive: true });
  for (const width of [1440, 1280, 1024]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 }); await expect(input(page)).toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole('main').locator('.pdf-page-loading')).toHaveCount(0);
    await panel(page).locator('.agent-interaction-card').evaluate(element => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `docs/verification/native-continuity/waiting-restored-${width}.png` });
  }
  await panel(page).getByRole('button', { name: '提交答复', exact: true }).click(); await expect.poll(() => runtime.replies.length).toBe(1);
  expect(runtime.replies[0]).toMatchObject({ requestId: first.requestId, reply: { answers: { scope: ['保留用户选择的核对范围'] } } });
  runtime.emit(first.requestId, { type: 'state', state: 'compacting' }); await expect(panel(page).getByRole('status').filter({ hasText: '正在整理上下文' })).toBeVisible();
  runtime.emit(first.requestId, { type: 'state', state: 'running' }); await panel(page).getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(panel(page).getByRole('status').filter({ hasText: '正在停止' })).toBeVisible(); expect((await state(page)).requests[first.requestId].status).toBe('generating');
  runtime.emit(first.requestId, { type: 'error', state: 'interrupted', code: 'stopped', error: '已停止，原生回合已确认。' });
  await expect.poll(async () => (await state(page)).requests[first.requestId].status).toBe('stopped');
  await expect(input(page)).toHaveValue('尚未发送的下一问'); expect(runtime.runs).toHaveLength(1);
});

test('原文小窗继承Codex，接收工具和问题并移交右侧时继续同一原生会话', async ({ page, runtime }) => {
  await start(page, runtime);
  const original = (await state(page)).sessions['research-a'].activeConversationId;
  const main = page.getByRole('main', { name: '主工作区' });
  const selected = main.locator('.pdf-text-layer').getByText('Abstract', { exact: true }); await expect(selected).toBeVisible();
  await selected.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
  });
  await page.getByLabel('原文选区操作').getByRole('button', { name: '提问', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '原文旁提问' }); await dialog.getByLabel('向原文旁助手提问').fill('解释选中的原文并核对来源');
  await dialog.getByRole('button', { name: '发送就地问题', exact: true }).click(); await expect.poll(() => runtime.runs.length).toBe(1);
  const run = runtime.runs[0]; expect(run).toMatchObject({ managed: true, history: [] }); expect(run.conversationId).not.toBe(original);
  runtime.emit(run.requestId, { type: 'item', item: { id: 'inline-read', type: 'commandExecution', status: 'done', toolName: '核对选区', output: '选区来源已核实' } });
  runtime.emit(run.requestId, { type: 'interaction', interaction: { id: 'inline-question', kind: 'question', title: '继续核对', status: 'pending', afterItemId: 'inline-read', questions: [{ id: 'scope', question: '继续当前选区吗？', options: [{ label: '继续选区', description: '保持原始来源' }], allowOther: false }] } });
  await dialog.getByRole('checkbox', { name: /继续选区/ }).check();
  await mkdir('docs/verification/native-continuity', { recursive: true }); await page.screenshot({ path: 'docs/verification/native-continuity/inline-managed-1440.png' });
  await dialog.getByRole('button', { name: '提交答复', exact: true }).click(); await expect.poll(() => runtime.replies.length).toBe(1);
  await dialog.getByLabel('向原文旁助手提问').fill('小窗补充：先保留原文的限制条件');
  await dialog.getByRole('button', { name: '补充就地本轮', exact: true }).click(); await expect.poll(() => runtime.controls.length).toBe(1);
  expect(runtime.controls[0]).toMatchObject({ requestId: run.requestId, expectedTurnId: 'turn-1', text: '小窗补充：先保留原文的限制条件' });
  await expect(dialog.getByLabel('向原文旁助手提问')).toHaveValue(''); expect(runtime.runs).toHaveLength(1);
  await dialog.getByLabel('向原文旁助手提问').fill('小窗中的下一条未发送草稿');
  await dialog.getByRole('button', { name: '在右侧继续', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(input(page)).toHaveValue('小窗中的下一条未发送草稿');
  expect((await state(page)).sessions['research-a'].activeConversationId).toBe(run.conversationId);
  runtime.finish(run.requestId, '原文选区已在同一原生会话中核查完成。'); await expect.poll(async () => (await state(page)).requests[run.requestId].status).toBe('done');
  expect((await state(page)).requests[run.requestId].nativeSessionId).toBe('stable-thread'); expect(runtime.runs).toHaveLength(1);
  await expect(panel(page).locator('.ai-native-timeline')).toContainText('原文选区已在同一原生会话中核查完成。');
});
