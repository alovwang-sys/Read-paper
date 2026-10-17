import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { ContextSnapshot, WorkspaceData } from '../../src/domain/types';
import { fixtureSessionRef, mockProjectService } from './project-fixture';
import { openSource, switchResearch } from './knowledge-helpers';

const conversationId = 'conversation-research-a';
const oldSessionId = 'codex-retained-session';
const newSessionId = 'codex-independent-session';
const oldRef = fixtureSessionRef(oldSessionId);
const newRef = fixtureSessionRef(newSessionId);
const recoveryText = '原会话由 Codex 后台保留，已保留历史并在独立会话继续。原会话不受影响。';
const failureText = '原会话由 Codex 后台保留，暂时无法建立独立会话。已有记录和输入已保留，请稍后重试。';
const oldAnswer = '旧回答：证据相关性是检索收益的前提。 [1]';
const answer = '模拟恢复回答：核对适用条件，并保留原文引用。 [1]';
type Run = { requestId: string; researchId: string; conversationId: string; sessionRef: string; prompt: string; context: ContextSnapshot[] };
type Outcome = 'recover' | 'resume' | 'error';
type API = { runs: Run[]; modelCalls: number; finish: (run: Run, outcome?: Outcome) => void };

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const input = (page: Page) => panel(page).getByLabel('向 AI 提问');
const turn = (page: Page, id: string) => panel(page).locator(`[data-request-id="${id}"]`);
const notice = (page: Page) => panel(page).getByRole('status').filter({ hasText: recoveryText });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');

async function state(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const recovery = localStorage.getItem('papertrail-recovery-v3');
    if (recovery) return JSON.parse(recovery);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const data = await new Promise<WorkspaceData>((resolve, reject) => {
      const request = db.transaction('workspace').objectStore('workspace').get('current');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close(); return data;
  });
}

async function start(page: Page): Promise<API> {
  const seed = createSeed(); seed.panelWidth = 440;
  for (const document of Object.values(seed.documents)) if (document.sampleUrl) {
    document.hash = createHash('sha256').update(await readFile(`public${document.sampleUrl}`)).digest('hex');
  }
  const snapshot = (id: string): ContextSnapshot => {
    const evidence = seed.evidence[id], document = seed.documents[evidence.documentId];
    return { evidenceId: id, documentId: document.id, documentHash: document.hash!, title: document.title, pageIndex: evidence.pageIndex, quote: evidence.quote };
  };
  const oldContext = [snapshot('evidence-a'), snapshot('evidence-b')];
  Object.assign(seed.conversations[conversationId], {
    connectionId: 'codex', nativeSessionId: oldSessionId, nativeSessionRef: oldRef,
    nativeState: 'idle', nativeCanResume: true, title: '检索适用条件的持续讨论',
    requestIds: ['old-request'], contextIds: ['evidence-c'], sentContext: oldContext,
  });
  seed.conversations['conversation-research-b'].connectionId = 'codex';
  seed.requests['old-request'] = {
    id: 'old-request', researchId: 'research-a', conversationId, connectionId: 'codex',
    nativeSessionId: oldSessionId, prompt: '先前问题：什么决定检索收益？', body: oldAnswer,
    context: oldContext, evidenceIds: ['evidence-a'], status: 'done', purpose: 'chat', mode: 'live',
    createdAt: '2026-10-17T01:00:00.000Z', history: [],
  };
  await mockProjectService(page, { seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: 'fixture', provider: 'fixture', mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [{ id: 'codex', name: 'Codex', state: 'ready', capabilities: { images: false, tools: true, resume: true, permissions: 'read-only' } }] } }));
  await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: { models: [{ id: 'fixture-model', name: '模拟运行时', isDefault: true, reasoningEfforts: [], defaultReasoningEffort: 'medium' }], skills: [], plan: true, accessModes: ['read-only'] } }));
  const pending = new Map<string, (outcome: Outcome) => void>();
  const api: API = { runs: [], modelCalls: 0, finish(run, outcome = 'recover') {
    const resolve = pending.get(run.requestId);
    if (!resolve) throw new Error(`No pending request: ${run.requestId}`);
    pending.delete(run.requestId); resolve(outcome);
  } };
  await page.route('**/api/ai/chat', route => { api.modelCalls++; return route.fulfill({ status: 500, body: 'Unexpected model fallback' }); });
  await page.route('**/api/ai/agents/run', async route => {
    const run = route.request().postDataJSON() as Run; api.runs.push(run);
    const outcome = await new Promise<Outcome>(resolve => pending.set(run.requestId, resolve));
    const nativeSessionId = outcome === 'recover' ? newSessionId : run.sessionRef.replace(/^fixture-/, '');
    const nativeSessionRef = fixtureSessionRef(nativeSessionId);
    const events = outcome === 'error' ? [{ type: 'error', code: 'session_recovery_failed', error: failureText }] : [
      ...(outcome === 'recover' ? [{ type: 'progress', kind: 'status', id: 'session-fork', text: recoveryText }] : []),
      { type: 'session', nativeSessionId, nativeSessionRef, ...(outcome === 'recover' ? { forkedFromId: oldSessionId } : {}) },
      { type: 'delta', text: answer },
      { type: 'done', model: '模拟运行时', nativeSessionId, nativeSessionRef },
    ];
    await route.fulfill({ contentType: 'application/x-ndjson', body: events.map(event => JSON.stringify(event)).join('\n') + '\n' }).catch(() => {});
  });
  await page.goto('/');
  await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible();
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
  await expect(page.getByRole('main').locator('canvas')).toBeVisible();
  await expect(page.getByRole('main').locator('.pdf-page-loading')).toHaveCount(0);
  await expect(turn(page, 'old-request').locator('.ai-answer')).toContainText('旧回答');
  return api;
}

async function send(page: Page, api: API, prompt: string) {
  const count = api.runs.length;
  await input(page).fill(prompt);
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await expect.poll(() => api.runs.length).toBe(count + 1);
  await expect(input(page)).toHaveValue('');
  return api.runs[count];
}

async function ended(page: Page, run: Run, status: 'done' | 'error') {
  await expect.poll(async () => (await state(page)).requests[run.requestId]?.status).toBe(status);
  await expect(panel(page).getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`Codex 后台占用自动恢复，原文、历史与新续接身份保持 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport); const api = await start(page);
    const original = (await state(page)).requests['old-request'];
    const run = await send(page, api, '继续核对：可靠性需要满足什么条件？');
    expect(run.sessionRef).toBe(oldRef);
    expect(run.context.map(item => item.evidenceId)).toEqual(['evidence-a', 'evidence-c']);
    await input(page).fill('下一条未发送草稿：请比较不同任务下的结果。');
    api.finish(run); await ended(page, run, 'done');
    await expect(notice(page)).toBeVisible(); await expect(notice(page)).toContainText('已恢复对话');
    await expect(input(page)).toHaveValue('下一条未发送草稿：请比较不同任务下的结果。');
    const data = await state(page), conversation = data.conversations[conversationId];
    expect(conversation).toMatchObject({ nativeSessionId: newSessionId, nativeSessionRef: newRef });
    expect(conversation.sentContext?.map(item => item.evidenceId).sort()).toEqual(['evidence-a', 'evidence-b', 'evidence-c']);
    expect(data.requests['old-request']).toEqual(original);
    expect(data.requests[run.requestId].nativeSessionId).toBe(newSessionId);
    expect(Object.keys(data.conversations)).toHaveLength(2);
    expect(api.runs).toHaveLength(1); expect(api.modelCalls).toBe(0);
    await expect(turn(page, 'old-request').getByRole('button', { name: /引用 1：/ })).toBeVisible();
    const closeNotice = page.getByRole('button', { name: '关闭提示', exact: true });
    if (await closeNotice.isVisible()) await closeNotice.click();
    await notice(page).scrollIntoViewIfNeeded();
    const bounds = (await input(page).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await saved(page); await page.evaluate(() => document.fonts.ready);
    await mkdir('docs/verification/native-session-recovery', { recursive: true });
    await page.screenshot({ path: `docs/verification/native-session-recovery/browser-${viewport.width}.png` });
    await page.reload(); await expect(notice(page)).toBeVisible();
    await expect(input(page)).toHaveValue('下一条未发送草稿：请比较不同任务下的结果。');
    const restored = await state(page);
    expect(restored.conversations[conversationId].nativeSessionRef).toBe(newRef);
    expect(restored.requests['old-request']).toEqual(original);
    expect(restored.requests[run.requestId].evidenceIds).toEqual(['evidence-a']);
    const next = await send(page, api, '刷新后沿保留历史的独立会话继续。');
    expect(next.sessionRef).toBe(newRef); api.finish(next, 'resume'); await ended(page, next, 'done');
    expect(api.runs).toHaveLength(2); expect(api.modelCalls).toBe(0);
  });
}

for (const nextDraft of ['', '恢复失败时保留正在写的下一条草稿。']) {
  test(`恢复失败保留原连接和${nextDraft ? '下一条草稿' : '原输入'}，允许原范围重试`, async ({ page }) => {
    const api = await start(page), prompt = '需要恢复原输入的研究问题。';
    const original = (await state(page)).conversations[conversationId];
    const run = await send(page, api, prompt);
    if (nextDraft) await input(page).fill(nextDraft);
    api.finish(run, 'error'); await ended(page, run, 'error');
    await expect(turn(page, run.requestId).getByRole('alert')).toContainText(failureText);
    await expect(turn(page, run.requestId).getByRole('button', { name: '按原范围重试', exact: true })).toBeVisible();
    await expect(input(page)).toHaveValue(nextDraft || prompt); await expect(notice(page)).toHaveCount(0);
    const failed = (await state(page)).conversations[conversationId];
    expect(failed.nativeSessionId).toBe(oldSessionId); expect(failed.nativeSessionRef).toBe(oldRef);
    expect(failed.sentContext).toEqual(original.sentContext); expect(api.runs).toHaveLength(1);
    await saved(page); await page.reload(); await expect(input(page)).toHaveValue(nextDraft || prompt);
    await turn(page, run.requestId).getByRole('button', { name: '按原范围重试', exact: true }).click();
    await expect.poll(() => api.runs.length).toBe(2);
    const retry = api.runs[1]; expect(retry.sessionRef).toBe(oldRef); expect(retry.prompt).toBe(prompt);
    expect(retry.context).toEqual(run.context); api.finish(retry, 'resume'); await ended(page, retry, 'done');
    await expect(input(page)).toHaveValue(nextDraft || prompt); expect(api.modelCalls).toBe(0);
  });
}

test('研究切换后迟到的恢复只更新原研究会话，另一研究草稿保留', async ({ page }) => {
  const api = await start(page), run = await send(page, api, '研究 A 等待后台会话恢复。');
  await switchResearch(page, 'research-b'); await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await input(page).fill('研究 B 的独立草稿。'); api.finish(run); await ended(page, run, 'done');
  await expect(input(page)).toHaveValue('研究 B 的独立草稿。'); await expect(notice(page)).toHaveCount(0);
  const data = await state(page);
  expect(data.conversations[conversationId].nativeSessionRef).toBe(newRef);
  expect(data.conversations['conversation-research-b'].nativeSessionRef).toBeUndefined();
  expect(data.requests['old-request'].nativeSessionId).toBe(oldSessionId);
  await switchResearch(page, 'research-a'); await expect(notice(page)).toBeVisible();
  expect(api.runs).toHaveLength(1); expect(api.modelCalls).toBe(0);
});
