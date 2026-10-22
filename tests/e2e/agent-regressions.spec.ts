import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test.use({ storageState: { cookies: [], origins: [] } });
const input = (page: Page) => page.getByRole('textbox', { name: '研究目标', exact: true });
const shots = 'docs/verification/agent-regressions/screenshots';
async function start(page: Page) {
  await page.routeWebSocket('**', () => {});
  await page.route('**/api/ai/research/capabilities', route => route.fulfill({ json: { connections: [{ id: 'codex', research: true, images: true, detail: '受控回归连接' }] } }));
  await page.goto('/');
  await expect(input(page)).toBeVisible();
  await page.evaluate(async () => {
    const path = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/services/workspace.ts') ?? '/src/services/workspace.ts';
    const { workspace } = await import(path);
    workspace.updateData((data: { researches: Record<string, { documentIds: string[] }> }) => { data.researches['research-a'].documentIds = []; });
  });
}
function events(items: unknown[]) { return items.map(item => JSON.stringify(item)).join('\n') + '\n'; }
const done = { type: 'done', model: 'controlled-regression', readPages: [] };

test('长问题完整发送，接受请求后立即清空；新草稿不被完成回执覆盖', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let prompt = '';
  await page.route('**/api/ai/research/run', async route => {
    prompt = route.request().postDataJSON().prompt;
    await held;
    await route.fulfill({ contentType: 'application/x-ndjson', body: events([{ type: 'delta', text: '长问题已完整接收。' }, done]) });
  });
  await start(page);
  const long = '请逐项保留研究条件与比较细节。'.repeat(700);
  await input(page).fill(long);
  await expect(input(page)).toHaveValue(long);
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(input(page)).toHaveValue('');
  await expect.poll(() => prompt).toBe(long);
  await input(page).fill('下一轮还未发送的新草稿');
  release();
  await expect(page.getByText('长问题已完整接收。', { exact: true })).toBeVisible();
  await expect(input(page)).toHaveValue('下一轮还未发送的新草稿');
});

test('流式执行开始即清空，失败保留可恢复问题', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/ai/research/run', async route => {
    await held;
    await route.fulfill({ contentType: 'application/x-ndjson', body: events([{ type: 'error', error: '受控网络失败' }]) });
  });
  await start(page);
  await input(page).fill('这个问题应在发送后离开输入框');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(input(page)).toHaveValue('');
  release();
  await expect(page.getByText('受控网络失败', { exact: true })).toBeVisible();
  await expect(input(page)).toHaveValue('这个问题应在发送后离开输入框');
});

test('成果正文直接在会话可读，附件与执行记录不遮住答案', async ({ page }) => {
  const answer = '主要研究结论：检索收益取决于证据质量与适用条件。';
  await page.route('**/api/ai/research/run', route => route.fulfill({ contentType: 'application/x-ndjson', body: events([
    { type: 'progress', text: '正在核对已授权资料', toolName: 'search_sources' },
    { type: 'artifact', artifact: { title: '可编辑比较笔记', body: `## 比较结论\n\n${answer}\n\n${'逐项说明条件、局限与待核查问题。\n\n'.repeat(16)}`, citations: [] } }, done,
  ]) }));
  await start(page);
  await input(page).fill('请给我完整结论并整理成笔记');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(page.getByText(answer, { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '打开成果：可编辑比较笔记', exact: true })).toBeVisible();
  await mkdir(shots, { recursive: true });
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    const bounds = await page.locator('.research-agent-conversation-scroll').boundingBox();
    expect(bounds!.height).toBeGreaterThan(height * .68);
    await expect(input(page)).toBeVisible();
    await page.screenshot({ path: `${shots}/answer-${width}.png` });
  }
});

test('回答中的论文保留预览与入库操作', async ({ page }) => {
  await page.route('**/api/ai/research/run', route => route.fulfill({ contentType: 'application/x-ndjson', body: events([
    { type: 'delta', text: '可进一步阅读 [Attention Is All You Need](https://arxiv.org/abs/1706.03762)。' }, done,
  ]) }));
  await start(page);
  await input(page).fill('给我相关论文线索');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  const sources = page.getByRole('region', { name: '回答中的资料' });
  await expect(sources).toBeVisible();
  await expect(sources.getByRole('button', { name: '查看文献', exact: true })).toBeVisible();
  await expect(sources.getByRole('button', { name: '加入本研究', exact: true })).toBeVisible();
});

async function savedData(page: Page) {
  return page.evaluate(async () => {
    const path = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/services/workspace.ts') ?? '/src/services/workspace.ts';
    return (await import(path)).workspace.getState().data;
  });
}

test('在当前会话检索文献、去重入库、刷新恢复并带摘要继续问', async ({ page }) => {
  const candidate = { id: 'openalex-W123', provider: 'openalex', providerId: 'W123', title: 'Controlled Research Discovery', authors: ['Test Author'], year: 2024, doi: '10.1234/controlled-discovery', url: 'https://doi.org/10.1234/controlled-discovery', abstract: 'This source abstract is metadata, not PDF evidence.', retrievedAt: '2026-10-21T00:00:00Z' };
  const search = { id: 'literature-1', query: 'evidence retrieval', createdAt: '2026-10-21T00:00:00Z', candidates: [candidate] };
  const sent: Array<{ history: unknown[]; sources: Array<{ title: string; abstract?: string; pages: unknown[] }> }> = [];
  await page.route('**/api/ai/research/run', route => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/x-ndjson', body: events(sent.length === 1 ? [
      { type: 'literature', search: { ...search, status: 'searching', candidates: [] } },
      { type: 'literature', search: { ...search, status: 'done' } },
      { type: 'delta', text: '找到一篇 [Controlled Research Discovery](https://doi.org/10.1234/controlled-discovery)，题录与摘要可在下方查看。' }, done,
    ] : [{ type: 'delta', text: '我可以讨论已收录的来源摘要，但没有读取 PDF。' }, done]) });
  });
  await page.route('**/api/sources/resolve', route => route.fulfill({ json: { url: candidate.url, title: candidate.title, kind: 'paper', identifiers: { doi: candidate.doi }, warning: '受控测试：未获取全文。' } }));
  await page.route('**/api/sources/pdf', route => route.fulfill({ status: 404, json: { error: '受控测试：没有 PDF。' } }));
  await start(page);
  await input(page).fill('帮我找与证据检索相关的新论文');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  const results = page.getByRole('region', { name: '文献检索：evidence retrieval', exact: true });
  await expect(results.getByText(candidate.title, { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '回答中的资料', exact: true })).toHaveCount(0);
  await results.getByRole('button', { name: '加入本研究', exact: true }).click();
  await expect(results.getByText('已在本研究', { exact: true })).toBeVisible();
  await expect.poll(async () => Object.values((await savedData(page)).documents).filter((document: unknown) => (document as { identifiers?: { doi?: string } }).identifiers?.doi === candidate.doi).length).toBe(1);
  await page.screenshot({ path: `${shots}/literature-collected-1440.png` });
  await page.reload();
  await expect(results.getByText('已在本研究', { exact: true })).toBeVisible();
  await results.getByRole('button', { name: '围绕这篇追问', exact: true }).click();
  await input(page).fill('这篇论文摘要里说的条件是什么？');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].history).toHaveLength(1);
  expect(sent[1].sources).toEqual([expect.objectContaining({ title: candidate.title, abstract: candidate.abstract, pages: [] })]);
  await expect(page.getByText('我可以讨论已收录的来源摘要，但没有读取 PDF。', { exact: true })).toBeVisible();
});

test('自己发送时定位新轮，上滚阅读时新回复不抢位置并可一键找到', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let count = 0;
  await page.route('**/api/ai/research/run', async route => {
    const turn = ++count;
    if (turn === 2) await held;
    await route.fulfill({ contentType: 'application/x-ndjson', body: events([{ type: 'delta', text: turn === 1 ? `第一轮完整回复\n\n${'保留研究条件和局限。\n\n'.repeat(60)}` : '第二轮最新回复' }, done]) });
  });
  await start(page);
  await input(page).fill('第一轮问题');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(page.getByText('第一轮完整回复', { exact: true })).toBeVisible();
  await page.locator('.research-agent-conversation-scroll').evaluate(element => { element.scrollTop = 0; });
  await input(page).fill('我在上面阅读后，发出第二轮问题');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(() => count).toBe(2);
  await expect(page.locator('.research-agent-assistant-message').last()).toBeInViewport();
  await page.locator('.research-agent-conversation-scroll').evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => page.locator('.research-agent-conversation-scroll').evaluate(element => element.scrollTop)).toBe(0);
  release();
  await expect(page.getByRole('button', { name: '查看最新回复' })).toBeVisible();
  expect(await page.locator('.research-agent-conversation-scroll').evaluate(element => element.scrollTop)).toBe(0);
  await page.getByRole('button', { name: '查看最新回复' }).click();
  await expect(page.getByText('第二轮最新回复', { exact: true })).toBeInViewport();
});

for (const status of ['empty', 'error'] as const) test(`检索${status === 'empty' ? '无结果' : '失败'}留在原会话并可继续问`, async ({ page }) => {
  await page.route('**/api/ai/research/run', route => route.fulfill({ contentType: 'application/x-ndjson', body: events([
    { type: 'literature', search: { id: 'literature-1', query: 'controlled empty', createdAt: '2026-10-21T00:00:00Z', candidates: [], status: status === 'empty' ? 'done' : 'error', ...(status === 'error' ? { error: 'OpenAlex 额度受限，请稍后重试。', errorCode: 'rate_limited' } : {}) } },
    { type: 'delta', text: '可以调整关键词继续检索。' }, done,
  ]) }));
  await start(page);
  await input(page).fill('帮我找论文');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(page.getByText(status === 'empty' ? '未找到文献，可以在当前会话调整关键词继续。' : 'OpenAlex 额度受限，请稍后重试。', { exact: true })).toBeVisible();
  await expect(input(page)).toHaveValue('');
  await expect(input(page)).toBeEnabled();
});

test('未收录的候选也按原顺序进入追问历史，摘要不冒充PDF', async ({ page }) => {
  const candidates = [1, 2].map(index => ({ id: `openalex-W${index}`, provider: 'openalex', providerId: `W${index}`, title: `候选论文 ${index}`, authors: ['Fixture Author'], url: `https://openalex.org/W${index}`, abstract: `第${index}篇真实返回的来源摘要。`, retrievedAt: '2026-10-21T00:00:00Z' }));
  const sent: Array<{ sources: unknown[]; history: Array<{ body: string }> }> = [];
  await page.route('**/api/ai/research/run', route => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/x-ndjson', body: events(sent.length === 1 ? [
      { type: 'literature', search: { id: 'literature-1', query: 'controlled metadata', createdAt: '2026-10-21T00:00:00Z', status: 'done', candidates } },
      { type: 'delta', text: '找到两条，详见下方候选。' }, done,
    ] : [{ type: 'delta', text: '第二篇摘要可以讨论，尚未读取 PDF。' }, done]) });
  });
  await start(page);
  await input(page).fill('找两篇文献，先不要加入资料库');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(page.getByText('候选论文 2', { exact: true })).toBeVisible();
  await input(page).fill('第二篇的摘要是什么，先别入库');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].sources).toEqual([]);
  expect(sent[1].history).toHaveLength(1);
  expect(sent[1].history[0].body).toContain(candidates[1].abstract);
  expect(sent[1].history[0].body.indexOf(candidates[0].title)).toBeLessThan(sent[1].history[0].body.indexOf(candidates[1].title));
  expect(Object.values((await savedData(page)).documents).filter((document: unknown) => (document as { title: string }).title.startsWith('候选论文 '))).toHaveLength(0);
});
