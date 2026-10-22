import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { WorkspaceData } from '../../src/domain/types';
import type { ResearchAgentInput } from '../../src/domain/research-agent';

test.use({ storageState: { cookies: [], origins: [] } });

// These isolated browser contexts contain controlled conversations and local sample PDFs, not user data or live model replies.
const shots = 'docs/agent-native-evolution/implementation/session-fix/screenshots';
const A = 'controlled-session-a', B = 'controlled-session-b';
const titleA = '受控会话 A：证据条件', titleB = '受控会话 B：性能边界';
const resultTitle = '受控共享成果：两种条件';
const input = (page: Page) => page.getByRole('textbox', { name: '研究目标', exact: true });
const thread = (page: Page) => page.getByLabel('当前研究会话', { exact: true });
const scroll = (page: Page) => page.locator('.research-agent-conversation-scroll');
const list = (page: Page) => page.getByLabel('研究会话列表', { exact: true });
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const messages: string[] = []; errors.set(page, messages); page.on('pageerror', error => messages.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

async function data(page: Page): Promise<WorkspaceData> {
  // Vite keeps timestamped module URLs after source edits; import the same singleton the UI loaded.
  return page.evaluate(async () => { const path = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/services/workspace.ts') ?? '/src/services/workspace.ts'; return (await import(path)).workspace.getState().data; });
}
async function start(page: Page, { active = A, focusA = true }: { active?: string; focusA?: boolean } = {}) {
  await page.routeWebSocket('**', () => {});
  await page.route('**/api/ai/research/capabilities', route => route.fulfill({ json: { connections: [
    { id: 'codex', research: true, detail: '受控集成测试：Codex 研究工具' },
    { id: 'claude', research: false, detail: '受控集成测试：仅保留经典文字会话' },
    { id: 'opencode', research: false, detail: '受控集成测试：研究工具尚未接入' },
    { id: 'model', research: false, detail: '受控集成测试：模型直连' },
    { id: 'demo', research: false, detail: '受控集成测试：固定演示' },
  ] } }));
  await page.goto('/');
  await expect(input(page)).toBeVisible();
  await page.evaluate(async ({ A, B, titleA, titleB, resultTitle, active, focusA }) => {
    const path = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/services/workspace.ts') ?? '/src/services/workspace.ts'; const { workspace } = await import(path);
    workspace.updateData((next: WorkspaceData) => {
      const createdAt = '2026-10-21T00:00:00.000Z';
      next.agentWorkbench = true;
      next.conversations[A] = { id: A, researchId: 'research-a', title: titleA, connectionId: 'codex', contextIds: [], requestIds: [], input: 'A 尚未发送的想法', createdAt, updatedAt: createdAt, historyRange: 'all', ...(focusA ? { researchFocus: { ref: { kind: 'draft', id: 'controlled-shared-draft' }, title: resultTitle, body: 'A 的局部研究目标' } } : {}) };
      next.conversations[B] = { id: B, researchId: 'research-a', title: titleB, connectionId: 'codex', contextIds: [], requestIds: [], input: 'B 尚未发送的想法', createdAt, updatedAt: createdAt, historyRange: 'all' };
      next.drafts['controlled-shared-draft'] = { id: 'controlled-shared-draft', researchId: 'research-a', title: resultTitle, body: '这是受控会话共同引用的成果，论文依据仍需阅读核对。[1]', evidenceIds: ['evidence-a'], updatedAt: createdAt };
      const add = (conversationId: string, index: number, prompt: string, body: string, result = false) => {
        const id = `${conversationId}-turn-${index}`;
        const evidence = next.evidence['evidence-a'], doc = next.documents[evidence.documentId];
        next.requests[id] = { id, researchId: 'research-a', conversationId, connectionId: 'codex', prompt, body: result ? '已整理为可编辑成果。' : body, context: result ? [{ evidenceId: evidence.id, documentId: doc.id, documentHash: doc.hash!, title: doc.title, pageIndex: evidence.pageIndex, quote: evidence.quote }] : [], evidenceIds: result ? ['evidence-a'] : [], createdAt, status: 'done', purpose: 'chat', mode: 'live', history: [], researchRun: result ? { draftId: 'controlled-shared-draft', sourceSummary: '受控既有记录，引用本地样例论文。', readPages: [{ documentId: doc.id, pageIndex: evidence.pageIndex }] } : {}, ...(result ? { result: { title: resultTitle, body, evidenceIds: ['evidence-a'] } } : {}) };
        next.conversations[conversationId].requestIds.push(id);
      };
      add(A, 1, 'A 第一问：先明确哪些条件？', `A 第一轮完整回答：应先核对语料相关性。\n\n${'受控旧回答的条件说明，不能只展示最新一句。\n\n'.repeat(12)}`);
      add(A, 2, 'A 第二问：还需要哪些证据？', 'A 第二轮完整回答：需要对照设置与失败案例。');
      add(A, 3, 'A 第三问：整理成完整成果。', `A 第三轮完整成果正文，不能只显示完成回执。[1]\n\n${'受控成果说明：保留原文条件和不能推断的范围。\n\n'.repeat(12)}`, true);
      add(B, 1, 'B 第一问：性能能直接排名吗？', 'B 第一轮独立回答：基准不同，不能直接排名。');
      const session = next.sessions['research-a'];
      session.activeConversationId = active; session.agentWorkbenchStarted = true;
      session.active = { kind: 'researchView', id: 'home' }; session.researchView = 'home';
      session.panel.open = false; session.panel.mode = 'ai'; session.panel.aiView = 'history';
    });
    await workspace.flushSave();
  }, { A, B, titleA, titleB, resultTitle, active, focusA });
  await expect(thread(page)).toBeVisible();
  await mkdir(shots, { recursive: true });
}
async function openList(page: Page) {
  if (!await list(page).isVisible()) await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await expect(list(page)).toBeVisible();
}
async function openConversation(page: Page, title: string) {
  await openList(page);
  await list(page).getByRole('button', { name: `打开会话：${title}`, exact: true }).click();
  await expect(input(page)).toBeVisible();
}
async function flush(page: Page) { await page.evaluate(async () => { const path = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/services/workspace.ts') ?? '/src/services/workspace.ts'; await (await import(path)).workspace.flushSave(); }); }
function controlledResult(payload: ResearchAgentInput) {
  const source = payload.sources.find(item => item.pages.length)!;
  expect(source).toBeTruthy();
  const page = source.pages[0];
  return [
    { type: 'progress', text: '受控响应：已阅读原文', toolName: 'read_page' },
    { type: 'delta', text: '受控迟到研究已完成。' },
    { type: 'artifact', artifact: { title: '受控迟到成果 A', body: '受控迟到成果正文，只属于 A 的这一轮。[1]', citations: [{ documentId: source.id, documentHash: source.hash, pageIndex: page.pageIndex, quote: page.text.slice(0, 80).trim() }] } },
    { type: 'done', model: 'controlled-session-e2e', nativeSessionId: 'controlled-ephemeral-a', readPages: [{ documentId: source.id, pageIndex: page.pageIndex }] },
  ].map(event => JSON.stringify(event)).join('\n') + '\n';
}

test('多轮完整呈现，新会话不继承旧输入和焦点，切回原会话不落入经典模式', async ({ page }) => {
  await start(page);
  await expect(thread(page).getByLabel('第 1 轮', { exact: true })).toContainText('A 第一轮完整回答');
  await expect(thread(page).getByLabel('第 2 轮', { exact: true })).toContainText('A 第二轮完整回答');
  const resultReply = thread(page).getByLabel('第 3 轮', { exact: true }).getByLabel('Agent 的回复', { exact: true });
  await expect(resultReply.locator('.ai-markdown > p')).toHaveText([
    'A 第三轮完整成果正文，不能只显示完成回执。[1]',
    ...Array<string>(12).fill('受控成果说明：保留原文条件和不能推断的范围。'),
  ]);
  await expect(resultReply).not.toContainText('已整理为可编辑成果');
  await expect(thread(page).getByLabel('第 3 轮', { exact: true }).getByRole('button', { name: `打开成果：${resultTitle}`, exact: true })).toBeVisible();
  await expect(input(page)).toHaveValue('A 尚未发送的想法');
  await openConversation(page, titleB);
  await expect(thread(page)).toContainText('B 第一轮独立回答');
  await expect(thread(page)).not.toContainText('A 第一轮完整回答');
  await expect(input(page)).toHaveValue('B 尚未发送的想法');
  await openConversation(page, titleA);
  await openList(page);
  await list(page).getByRole('button', { name: '新建会话', exact: true }).click();
  const fresh = await data(page), freshId = fresh.sessions['research-a'].activeConversationId!;
  expect([A, B]).not.toContain(freshId);
  expect(fresh.conversations[freshId]).toMatchObject({ input: '', requestIds: [], contextIds: [] });
  expect(fresh.conversations[freshId].researchFocus).toBeUndefined();
  await expect(input(page)).toHaveValue('');
  await openConversation(page, titleA);
  await expect(input(page)).toHaveValue('A 尚未发送的想法');
  expect((await data(page)).conversations[A].researchFocus?.ref.id).toBe('controlled-shared-draft');
  expect((await data(page)).agentWorkbench).toBe(true);
  await expect(page.getByRole('button', { name: '经典工作台', exact: true })).toBeVisible();
  const saved = await data(page), sourceEvidence = saved.evidence['evidence-a'];
  const sourcePageLabel = `${saved.documents[sourceEvidence.documentId].title} PDF 第 ${sourceEvidence.pageIndex + 1} 页`;
  await resultReply.getByRole('button', { name: '[1]', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '参考面板' }).getByLabel(sourcePageLabel, { exact: true })).toBeVisible();
  expect((await data(page)).sessions['research-a'].activeConversationId).toBe(A);
  await expect(input(page)).toHaveValue('A 尚未发送的想法');
  await page.getByRole('button', { name: '关闭右侧面板', exact: true }).click();
  await resultReply.getByRole('button', { name: `打开成果：${resultTitle}`, exact: true }).click();
  await expect(page.getByRole('textbox', { name: '结论标题', exact: true })).toHaveValue(resultTitle);
  await expect(page.getByRole('textbox', { name: '结论正文', exact: true })).toHaveValue(saved.drafts['controlled-shared-draft'].body);
  expect((await data(page)).sessions['research-a'].activeConversationId).toBe(A);
  await expect(input(page)).toHaveValue('A 尚未发送的想法');
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await expect(resultReply.locator('.ai-markdown > p')).toHaveCount(13);
  await page.screenshot({ path: `${shots}/multiple-sessions-1440.png` });
});

test('刷新恢复当前会话、未发送输入、局部焦点和该会话滚动位置', async ({ page }) => {
  await start(page);
  await input(page).fill('A 刷新后也必须保留的输入');
  await scroll(page).evaluate(element => { element.scrollTop = Math.min(350, element.scrollHeight - element.clientHeight); });
  await expect.poll(async () => (await data(page)).conversations[A].researchScrollTop ?? 0).toBeGreaterThan(0);
  const top = (await data(page)).conversations[A].researchScrollTop!;
  await openConversation(page, titleB);
  await expect(input(page)).toHaveValue('B 尚未发送的想法');
  await openConversation(page, titleA);
  await expect.poll(() => scroll(page).evaluate(element => element.scrollTop)).toBeCloseTo(top, 0);
  await flush(page);
  await page.reload();
  await expect(input(page)).toHaveValue('A 刷新后也必须保留的输入');
  await expect.poll(() => scroll(page).evaluate(element => element.scrollTop)).toBeCloseTo(top, 0);
  const restored = await data(page);
  expect(restored.sessions['research-a'].activeConversationId).toBe(A);
  expect(restored.conversations[A].researchFocus?.ref.id).toBe('controlled-shared-draft');
  expect(restored.conversations[B].researchFocus).toBeUndefined();
  expect(restored.agentWorkbench).toBe(true);
  await page.screenshot({ path: `${shots}/restored-session-1440.png` });
});

test('查看共享成果和引用保持发送目标，三个窗口尺寸均无横向溢出且输入可用', async ({ page }) => {
  await start(page, { active: B });
  const saved = await data(page), sourceEvidence = saved.evidence['evidence-a'];
  const sourcePageLabel = `${saved.documents[sourceEvidence.documentId].title} PDF 第 ${sourceEvidence.pageIndex + 1} 页`;
  await page.getByRole('button', { name: '全局搜索', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索全部资料' }).fill(resultTitle);
  await page.locator('.search-results .search-result-open').filter({ hasText: resultTitle }).click();
  await expect(page.getByRole('textbox', { name: '结论标题', exact: true })).toHaveValue(resultTitle);
  await expect(input(page)).toHaveValue('B 尚未发送的想法');
  expect((await data(page)).sessions['research-a'].activeConversationId).toBe(B);
  await page.getByRole('button', { name: '查看原文', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '参考面板' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '参考面板' }).getByLabel(sourcePageLabel, { exact: true })).toBeVisible();
  await expect(page.locator('.pdf-page-loading')).toHaveCount(0);
  await page.evaluate(async () => {
    const path = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/services/workspace.ts') ?? '/src/services/workspace.ts';
    (await import(path)).workspace.updateData((next: WorkspaceData) => { next.sessions['research-a'].panel.aiView = 'chat'; });
  });
  await page.getByRole('tab', { name: '会话', exact: true }).click();
  await expect(list(page)).toBeVisible();
  expect((await data(page)).agentWorkbench).toBe(true);
  expect((await data(page)).sessions['research-a'].activeConversationId).toBe(B);
  await expect(input(page)).toHaveValue('B 尚未发送的想法');
  await page.getByRole('button', { name: '查看原文', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '参考面板' }).getByLabel(sourcePageLabel, { exact: true })).toBeVisible();
  await expect(page.locator('.pdf-page-loading')).toHaveCount(0);
  await page.locator('.writing-scroll').evaluate(element => { element.scrollTop = 0; });
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toBeEditable();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.getByRole('button', { name: '开始研究', exact: true }).evaluate(element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === element; })).toBe(true);
    await expect(input(page)).toHaveValue('B 尚未发送的想法');
    const current = await data(page);
    expect(current.sessions['research-a'].activeConversationId).toBe(B);
    expect(current.conversations[B].researchFocus).toBeUndefined();
    await page.screenshot({ path: `${shots}/shared-source-${width}.png` });
  }
  await expect(page.getByRole('button', { name: '返回会话', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await expect(thread(page)).toContainText('B 第一轮独立回答');
  await expect(input(page)).toHaveValue('B 尚未发送的想法');
});

test('同研究内 A 的迟到成果仍归 A，不抢 B 的当前视图、输入和历史', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let payload: ResearchAgentInput | undefined;
  await page.route('**/api/ai/research/run', async route => {
    payload = route.request().postDataJSON() as ResearchAgentInput;
    await held;
    await route.fulfill({ contentType: 'application/x-ndjson', body: controlledResult(payload) });
  });
  await start(page, { focusA: false });
  await input(page).fill('A 这一轮受控延迟生成成果');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(() => !!payload).toBe(true);
  await openConversation(page, titleB);
  await expect(thread(page)).toContainText('B 第一轮独立回答');
  release();
  await expect.poll(async () => Object.values((await data(page)).requests).find(request => request.prompt === 'A 这一轮受控延迟生成成果')?.status).toBe('done');
  const after = await data(page), run = Object.values(after.requests).find(request => request.prompt === 'A 这一轮受控延迟生成成果')!;
  expect(run.conversationId).toBe(A);
  expect(after.conversations[B].requestIds).toHaveLength(1);
  expect(after.sessions['research-a'].activeConversationId).toBe(B);
  expect(after.sessions['research-a'].active).toEqual({ kind: 'researchView', id: 'home' });
  await expect(input(page)).toHaveValue('B 尚未发送的想法');
  await expect(thread(page)).not.toContainText('受控迟到成果正文');
  await page.screenshot({ path: `${shots}/late-result-stays-b-1440.png` });
  await openConversation(page, titleA);
  const resultLink = thread(page).getByLabel('第 4 轮', { exact: true }).getByRole('button', { name: '打开成果：受控迟到成果 A', exact: true });
  await expect(resultLink).toBeVisible();
  await resultLink.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/late-result-owner-1440.png` });
});
