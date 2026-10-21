import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { WorkspaceData } from '../../src/domain/types';
import type { ResearchAgentInput } from '../../src/domain/research-agent';

test.use({ storageState: { cookies: [], origins: [] } });

const shots = 'docs/agent-native-evolution/implementation/session-fix/screenshots/regression';
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });
const input = (page: Page) => page.getByRole('textbox', { name: '研究目标', exact: true });
const activeConversation = (saved: WorkspaceData) => saved.conversations[saved.sessions['research-a'].activeConversationId!] ?? Object.values(saved.conversations).find(item => item.researchId === 'research-a' && !item.archived)!;
async function data(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => { const path = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/services/workspace.ts') ?? '/src/services/workspace.ts'; return (await import(path)).workspace.getState().data; });
}
async function start(page: Page) {
  await page.routeWebSocket('**', () => {});
  await page.route('**/api/ai/research/capabilities', route => route.fulfill({ json: { connections: [
    { id: 'codex', research: true, detail: '测试连接：Codex 研究工具已接入' },
    { id: 'claude', research: false, detail: '原生文字会话仍可用；本版尚未接入应用研究工具。' },
    { id: 'opencode', research: false, detail: '应用工具尚未接入。' },
    { id: 'model', research: false, detail: '模型直连保留。' },
    { id: 'demo', research: false, detail: '演示不是实际研究。' },
  ] } }));
  await page.goto('/');
  await expect(input(page)).toBeVisible();
  await expect(page.getByRole('complementary', { name: '参考面板' })).toHaveCount(0);
}
function response(payload: ResearchAgentInput, version = 1) {
  const source = payload.sources.find(source => source.pages.length)!;
  expect(source).toBeTruthy();
  const page = source.pages[0];
  const quote = page.text.slice(0, 90).trim();
  return [
    { type: 'progress', text: '已查阅资料目录', toolName: 'search_sources' },
    { type: 'progress', text: '已读取原文', toolName: 'read_page' },
    { type: 'delta', text: '已形成草稿，可继续核查。' },
    { type: 'artifact', artifact: { title: `比较研究 ${version}`, body: `## 条件与证据\n\n这是一份使用真实 PDF 提取文字的受控测试草稿。[1]\n\n${'保留条件和局限，逐项核查原文。\n\n'.repeat(25)}`, citations: [{ documentId: source.id, documentHash: source.hash, pageIndex: page.pageIndex, quote }] } },
    { type: 'done', model: 'controlled-e2e', nativeSessionId: 'controlled-session', readPages: [{ documentId: source.id, pageIndex: page.pageIndex }] },
  ].map(event => JSON.stringify(event)).join('\n') + '\n';
}

test('一句委托形成真实持久草稿，局部修订保护人工修改，来源深读可以返回', async ({ page }) => {
  let count = 0;
  const sent: ResearchAgentInput[] = [];
  await page.route('**/api/ai/research/run', async route => {
    const payload = route.request().postDataJSON() as ResearchAgentInput;
    sent.push(payload);
    await route.fulfill({ contentType: 'application/x-ndjson', body: response(payload, ++count) });
  });
  await start(page);
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/welcome-1440.png` });
  await input(page).fill('比较本研究的论文，写一份带引用的研究笔记。');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  const body = page.getByRole('textbox', { name: '结论正文', exact: true });
  await page.getByRole('button', { name: '打开成果：比较研究 1', exact: true }).click({ timeout: 45000 });
  await expect(page.getByRole('textbox', { name: '结论标题' })).toHaveValue('比较研究 1');
  expect(sent[0].sources.filter(source => source.pages.length)).toHaveLength(2);
  expect(sent[0].sources.find(source => source.id === 'paper-c')?.unavailable).toContain('OCR');
  expect(sent[0].sources.every(source => !source.pages.length || source.hash.length === 64)).toBe(true);
  const saved = await data(page);
  const draftId = (saved.sessions['research-a'].active as { id: string }).id;
  expect(saved.drafts[draftId].evidenceIds).toHaveLength(1);
  expect(saved.evidence[saved.drafts[draftId].evidenceIds[0]].quote).toBeTruthy();
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(input(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${shots}/result-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await body.fill('用户自己改写的判断，需要保留。[1]');
  await page.getByRole('button', { name: '围绕这里追问' }).click();
  await input(page).fill('修改这份成果，补上适用条件。');
  const focus = activeConversation(await data(page)).researchFocus;
  expect(focus?.ref.id).toBe(draftId);
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(async () => Object.values((await data(page)).requests).filter(request => request.researchRun).at(-1)?.status).toBe('done');
  await expect(body).toHaveValue('用户自己改写的判断，需要保留。[1]');
  await page.getByRole('button', { name: '返回会话', exact: true }).first().click();
  await expect(page.getByRole('button', { name: '采用建议', exact: true })).toBeVisible();
  expect(sent[1].focus?.ref.id).toBe(draftId);
  await page.screenshot({ path: `${shots}/revision-review-1440.png` });
  await page.getByRole('button', { name: '采用建议', exact: true }).click();
  await page.getByRole('button', { name: '打开成果：比较研究 2', exact: true }).last().click();
  await expect(body).toHaveValue(/条件与证据/);
  await expect(page.getByRole('textbox', { name: '结论标题' })).toHaveValue('比较研究 2');
  await body.fill('采用后我又继续编辑，不能被撤销覆盖。[1]');
  await page.getByRole('button', { name: '返回会话', exact: true }).first().click();
  await page.getByRole('button', { name: '撤销本次修改', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('不能撤销');
  await page.getByRole('button', { name: '打开成果：比较研究 2', exact: true }).last().click();
  await expect(body).toHaveValue('采用后我又继续编辑，不能被撤销覆盖。[1]');
  await input(page).fill('尚未发送的问题');
  await page.getByRole('button', { name: '围绕这里追问' }).click();
  await page.getByRole('button', { name: '查看原文', exact: true }).click();
  await expect(input(page)).toHaveValue('尚未发送的问题');
  expect(activeConversation(await data(page)).researchFocus?.ref.id).toBe(draftId);
  const sourceEvidence = saved.evidence[saved.drafts[draftId].evidenceIds[0]];
  await expect(page.getByRole('complementary', { name: '参考面板' }).getByLabel(`${saved.documents[sourceEvidence.documentId].title} PDF 第 ${sourceEvidence.pageIndex + 1} 页`, { exact: true })).toBeVisible();
  await expect(page.locator('.pdf-page-loading')).toHaveCount(0);
  await page.screenshot({ path: `${shots}/source-reference-1440.png` });
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(input(page)).toBeVisible();
  expect(await page.locator('.research-agent-send').evaluate(element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === element; })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${shots}/source-reference-1024.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  const scrollBeforeReading = await page.locator('.writing-scroll').evaluate(element => element.scrollTop);
  await page.getByRole('button', { name: '在当前窗格打开', exact: true }).click();
  await expect(page.getByRole('main').locator('.pdf-reader')).toBeVisible();
  await page.getByRole('button', { name: '主区返回', exact: true }).click();
  await expect(body).toHaveValue('采用后我又继续编辑，不能被撤销覆盖。[1]');
  await expect.poll(() => page.locator('.writing-scroll').evaluate(element => element.scrollTop)).toBe(scrollBeforeReading);
  await page.getByRole('button', { name: '关闭右侧面板' }).click();
  await page.reload();
  await expect(input(page)).toHaveValue('尚未发送的问题');
  await expect(body).toHaveValue('采用后我又继续编辑，不能被撤销覆盖。[1]');
});

test('全部旧功能可达，经典模式和Agent模式共享数据，连接能力不冒充', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: '选择研究助手' }).click();
  await page.getByRole('combobox', { name: '研究 Agent 连接' }).selectOption('claude');
  await expect(page.locator('.research-agent-config')).toContainText('尚未接入应用研究工具');
  await page.getByRole('button', { name: '关闭 Agent 配置' }).click();
  const before = await data(page);
  await page.getByRole('button', { name: '经典工作台', exact: true }).click();
  await expect(input(page)).toHaveCount(0);
  for (const name of ['资料', '摘录', '卡片', '白板', '文稿']) await expect(page.getByRole('navigation', { name: '研究内导航' }).getByRole('button', { name, exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '研究内导航' }).getByRole('button', { name: '白板', exact: true }).click();
  const boardTitle = Object.values(before.boards).find(board => board.researchId === 'research-a')!.title;
  await page.getByRole('main').getByRole('button', { name: boardTitle, exact: true }).click();
  await expect(page.getByRole('button', { name: /^(绘图|卡片布局)$/ })).toBeVisible();
  await page.screenshot({ path: `${shots}/legacy-board-1440.png` });
  await page.getByRole('button', { name: 'Agent 工作台', exact: true }).click();
  await expect(input(page)).toBeVisible();
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await expect(input(page)).toBeVisible();
  await expect(page.getByRole('region', { name: '研究会话列表' })).toBeVisible();
  await page.getByRole('button', { name: '关闭右侧面板' }).click();
  await page.getByRole('button', { name: /^(让 Agent 整理|整理资料关系)$/ }).click();
  await expect(input(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Agent 工作台', exact: true })).toBeVisible();
  expect(Object.values((await data(page)).conversations).some(conversation => conversation.boardSkill?.boardId === Object.values(before.boards).find(board => board.researchId === 'research-a')!.id)).toBe(true);
  await page.getByRole('button', { name: 'Agent 工作台', exact: true }).click();
  await expect(input(page)).toBeVisible();
  const after = await data(page);
  for (const key of ['documents', 'cards', 'evidence', 'boards', 'placements', 'drafts'] as const) expect(after[key]).toEqual(before[key]);
  await page.getByRole('button', { name: '全局搜索', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索全部资料' }).fill(Object.values(after.boards)[0].title);
  await expect(page.locator('.search-results').getByRole('button').first()).toBeVisible();
});

test('迟到结果归原研究，不打断另一个研究；停止保留输入', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let captured: ResearchAgentInput | undefined;
  await page.route('**/api/ai/research/run', async route => {
    captured = route.request().postDataJSON();
    await held;
    await route.fulfill({ contentType: 'application/x-ndjson', body: response(captured!) }).catch(() => {});
  });
  await start(page);
  await input(page).fill('比较这些论文并保留出处。');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(() => !!captured).toBe(true);
  await page.getByRole('combobox', { name: '切换研究' }).selectOption('research-b');
  release();
  await expect.poll(async () => Object.values((await data(page)).requests).find(request => request.researchRun)?.status).toBe('done');
  const saved = await data(page);
  expect(saved.scope).toEqual({ kind: 'research', researchId: 'research-b' });
  expect(Object.values(saved.drafts).find(draft => draft.title === '比较研究 1')?.researchId).toBe('research-a');
  await expect(input(page)).toHaveValue('');
  await page.getByRole('combobox', { name: '切换研究' }).selectOption('research-a');
  await page.unroute('**/api/ai/research/run');
  let secondReached = false;
  await page.route('**/api/ai/research/run', route => new Promise<void>(resolve => { secondReached = true; setTimeout(() => { void route.abort().catch(() => {}).finally(resolve); }, 10000); }));
  await input(page).fill('这条停止后要保留');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(() => secondReached).toBe(true);
  await page.getByRole('button', { name: '停止研究', exact: true }).click();
  await expect(input(page)).toHaveValue('这条停止后要保留');
  await expect.poll(async () => Object.values((await data(page)).requests).filter(request => request.researchRun).at(-1)?.status).toBe('stopped');
});
