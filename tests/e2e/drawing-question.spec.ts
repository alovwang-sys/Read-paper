import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import type { DrawingScene } from '../../src/domain/drawing';
import type { ResearchAgentInput } from '../../src/domain/research-agent';
import type { WorkspaceData } from '../../src/domain/types';
import { mockProjectService } from './project-fixture';
import { openResearchNavigation } from './knowledge-helpers';

// Native drawing/export and persistence are real; these tests simulate Agent events, never vision quality.
const shots = 'docs/agent-native-evolution/implementation/drawing-agent/screenshots';
const A = 'conversation-research-a', B = 'drawing-other-session';
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const drawing = (page: Page) => main(page).getByLabel('白板自由绘图', { exact: true });
const canvas = (page: Page) => drawing(page).locator('canvas.interactive');
const input = (page: Page) => page.getByRole('textbox', { name: '研究目标', exact: true });
const attachment = (page: Page) => page.getByLabel('待发送的绘图选区', { exact: true });
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

async function data(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => { const path = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/services/workspace.ts') ?? '/src/services/workspace.ts'; return (await import(path)).workspace.getState().data; });
}
async function flush(page: Page) {
  await page.evaluate(async () => { const path = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/services/workspace.ts') ?? '/src/services/workspace.ts'; await (await import(path)).workspace.flushSave(); });
}
async function start(page: Page, images = true) {
  await page.routeWebSocket('**', () => {});
  const seed = createSeed();
  seed.agentWorkbench = true;
  const session = seed.sessions['research-a'];
  session.active = { kind: 'board', id: 'board-a' }; session.openItems = [{ kind: 'board', id: 'board-a' }]; session.agentWorkbenchStarted = true; session.activeConversationId = A;
  session.panel = { ...session.panel, open: false, mode: 'ai', aiView: 'history' };
  session.viewports['drawing:board-a'] = { x: 0, y: 0, scale: .65 };
  const conversation = seed.conversations[A];
  conversation.connectionId = 'codex'; conversation.contextIds = []; conversation.input = '这段输入先保留，问图时不能丢。'; conversation.title = '自绘图研究 A';
  // A is this board's thread, so selections beyond one card continue here.
  conversation.anchor = { kind: 'board', id: 'board-a' };
  conversation.researchFocus = { ref: { kind: 'draft', id: 'draft-a' }, title: '旧稿目标', body: '不应被问图覆盖' };
  const createdAt = '2026-10-21T00:00:00.000Z';
  seed.conversations[B] = { id: B, researchId: 'research-a', title: '另一会话 B', connectionId: 'codex', contextIds: [], requestIds: ['other-history'], input: 'OTHER_SESSION_SECRET_INPUT', createdAt };
  seed.requests['other-history'] = { id: 'other-history', researchId: 'research-a', conversationId: B, connectionId: 'codex', prompt: 'OTHER_SESSION_SECRET_QUESTION', body: 'OTHER_SESSION_SECRET_ANSWER', status: 'done', createdAt, context: [], evidenceIds: [], researchRun: {} };
  seed.requests['current-history'] = { id: 'current-history', researchId: 'research-a', conversationId: A, connectionId: 'codex', prompt: '本会话既有问题', body: 'LOCAL_HISTORY_OK', status: 'done', createdAt, context: [], evidenceIds: [], researchRun: {} };
  conversation.requestIds = ['current-history'];
  delete seed.placements['placement-b']; delete seed.placements['placement-c']; delete seed.edges['edge-a'];
  seed.placements['placement-a'].x = 80; seed.placements['placement-a'].y = 200;
  seed.cards['card-a'].body = 'SELECTED_CARD_BODY：这是选中卡片独立保存的完整正文，必须另附。';
  await mockProjectService(page, { seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: '绘图选区验收 · 模拟连接', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/research/capabilities', route => route.fulfill({ json: { connections: [{ id: 'codex', research: true, images, detail: '受控绘图问答测试；模型事件模拟，未调用真实 Agent。' }] } }));
  await page.goto('/'); await expect(input(page)).toBeVisible();
  await main(page).getByRole('button', { name: '绘图', exact: true }).click();
  await expect(canvas(page)).toBeVisible();
  await page.evaluate(async () => {
    const paths = performance.getEntriesByType('resource').map(entry => entry.name);
    const loaded = (path: string) => paths.find(name => new URL(name).pathname === path) ?? path;
    const excalidraw = paths.find(name => new URL(name).pathname.includes('@excalidraw_excalidraw.js'));
    if (!excalidraw) throw new Error('Native Excalidraw module not loaded');
    const { convertToExcalidrawElements } = await import(excalidraw);
    const { workspace } = await import(loaded('/src/services/workspace.ts'));
    const { putAsset, contentHash } = await import(loaded('/src/data/storage.ts'));
    const importedImage = document.createElement('canvas'); importedImage.width = 16; importedImage.height = 16;
    importedImage.getContext('2d')!.fillStyle = '#00cc33'; importedImage.getContext('2d')!.fillRect(0, 0, 16, 16);
    const fileId = 'controlled-imported-image' as BinaryFiles[string]['id'];
    const groupIds = ['selected-research-group'];
    const elements = convertToExcalidrawElements([
      { id: 'resource-placement-a', type: 'rectangle', x: 80, y: 80, width: 260, height: 220, groupIds, roughness: 0, link: 'papertrail://placement/placement-a', customData: { placementId: 'placement-a', resourceRef: { kind: 'card', id: 'card-a' } } },
      { id: 'selected-shape', type: 'rectangle', x: 480, y: 80, width: 160, height: 100, groupIds, roughness: 0 },
      { id: 'selected-label', type: 'text', x: 488, y: 110, text: '条件检查', fontFamily: 2, fontSize: 20, groupIds },
      { id: 'selected-arrow', type: 'arrow', x: 345, y: 165, points: [[0, 0], [125, 0]], groupIds, endArrowhead: 'arrow', roughness: 0 },
      { id: 'selected-handwriting', type: 'line', x: 500, y: 245, points: [[0, 0], [20, -18], [40, 8], [55, -6]], groupIds, roughness: 0 },
      { id: 'selected-outside-arrow', type: 'arrow', x: 650, y: 140, points: [[0, 0], [90, 0]], groupIds, endArrowhead: 'arrow', roughness: 0 },
      { id: 'selected-imported-image', type: 'rectangle', x: 650, y: 210, width: 70, height: 70, groupIds, roughness: 0 },
      { id: 'unselected-sentinel', type: 'rectangle', x: 380, y: 110, width: 50, height: 40, backgroundColor: '#ff00ff', strokeColor: '#ff00ff', fillStyle: 'solid', roughness: 0 },
      { id: 'unselected-outside', type: 'rectangle', x: 770, y: 100, width: 100, height: 80, backgroundColor: '#ff00ff', strokeColor: '#ff00ff', fillStyle: 'solid', roughness: 0 },
      { id: 'outside-secret-label', type: 'text', x: 775, y: 120, text: 'OUTSIDE_SECRET', fontFamily: 2, fontSize: 12 },
    ], { regenerateIds: false });
    const byId = new Map(elements.map((element: { id: string }) => [element.id, element]));
    Object.assign(byId.get('resource-placement-a')!, { type: 'embeddable' });
    Object.assign(byId.get('selected-handwriting')!, { type: 'freedraw', pressures: [], simulatePressure: true, lastCommittedPoint: null });
    Object.assign(byId.get('selected-imported-image')!, { type: 'image', fileId, status: 'pending', scale: [1, 1], crop: null });
    Object.assign(byId.get('selected-arrow')!, { startBinding: { elementId: 'resource-placement-a', focus: 0, gap: 5 }, endBinding: { elementId: 'selected-shape', focus: 0, gap: 10 } });
    Object.assign(byId.get('selected-outside-arrow')!, { startBinding: { elementId: 'selected-shape', focus: 0, gap: 10 }, endBinding: { elementId: 'unselected-outside', focus: 0, gap: 30 } });
    for (const element of elements) element.y += 120;
    const scene: DrawingScene = { type: 'excalidraw', version: 2, source: 'controlled-drawing-question-e2e', elements, files: { [fileId]: { id: fileId, dataURL: importedImage.toDataURL('image/png') as BinaryFiles[string]['dataURL'], mimeType: 'image/png', created: 1, lastRetrieved: 1 } }, appState: { viewBackgroundColor: '#ffffff', scrollX: 0, scrollY: 0, zoom: { value: .65 } } };
    const blob = new Blob([JSON.stringify(scene)], { type: 'application/json' }), hash = await contentHash(await blob.arrayBuffer()), assetId = `drawing-${hash}`;
    await putAsset(assetId, blob);
    workspace.updateData((next: WorkspaceData) => { next.boards['board-a'].drawing = { assetId, hash }; });
    await workspace.flushSave();
  });
  await expect(canvas(page)).toBeVisible();
  await expect(drawing(page).getByRole('article', { name: '白板资料：相关性是检索收益的前提', exact: true })).toBeVisible();
  await mkdir(shots, { recursive: true });
}
async function selectAndAttach(page: Page) {
  const box = (await canvas(page).boundingBox())!;
  const point = (x: number, y: number) => ({ x: box.x + x * .65, y: box.y + y * .65 });
  await drawing(page).getByTestId('toolbar-selection').locator('..').click();
  const from = point(60, 175), to = point(750, 445);
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 16 }); await page.mouse.up();
  // The pink sentinel lies inside the selection bounds but is explicitly removed from the selected set.
  const sentinel = point(405, 250);
  await page.keyboard.down('Shift'); await page.mouse.click(sentinel.x, sentinel.y); await page.keyboard.up('Shift');
  await expect(drawing(page).getByRole('button', { name: '问 Agent', exact: true })).toBeVisible();
  await drawing(page).getByRole('button', { name: '问 Agent', exact: true }).click();
  await expect(attachment(page)).toBeVisible();
  await expect(attachment(page).getByRole('img', { name: '所选绘图的实际快照', exact: true })).toBeVisible();
  return (await data(page)).conversations[A].drawingQuestion!;
}
const response = () => [{ type: 'delta', text: '受控绘图回答：条件检查应先核对输入，所画箭头不是已证实因果。' }, { type: 'done', model: 'controlled-drawing-e2e', nativeSessionId: 'controlled-drawing-session', readPages: [] }].map(event => JSON.stringify(event)).join('\n') + '\n';
// The conversation list lives in the left sidebar; answers stay in the current chat host.
async function openConversation(page: Page, title: string) {
  const sidebar = await openResearchNavigation(page);
  await sidebar.getByRole('region', { name: '研究会话列表', exact: true }).getByRole('button', { name: `打开会话：${title}`, exact: true }).click();
}

test('真实框选与 PNG 导出进入当前会话，范围隔离、卡片正文、三个尺寸和刷新完整', async ({ page }) => {
  const sent: ResearchAgentInput[] = [];
  await page.route('**/api/ai/research/run', async route => { sent.push(route.request().postDataJSON()); await route.fulfill({ contentType: 'application/x-ndjson', body: response() }); });
  await start(page);
  const before = await data(page), question = await selectAndAttach(page);
  expect(question.snapshot.elements.map(element => element.id).sort()).toEqual(['resource-placement-a', 'selected-arrow', 'selected-handwriting', 'selected-label', 'selected-outside-arrow', 'selected-shape', 'selected-imported-image'].sort());
  expect(question.snapshot.elements.find(element => element.id === 'selected-handwriting')?.type).toBe('freedraw');
  expect(question.snapshot.elements.find(element => element.id === 'selected-imported-image')?.type).toBe('image');
  expect(question.snapshot.elements.find(element => element.id === 'resource-placement-a')?.resource?.body).toBe(before.cards['card-a'].body);
  expect(question.snapshot.connections.find(connection => connection.id === 'selected-outside-arrow')).toMatchObject({ endOutside: true });
  expect((await data(page)).conversations[A].researchFocus).toBeUndefined();
  await expect(input(page)).toHaveValue('这段输入先保留，问图时不能丢。');
  await attachment(page).locator('summary').click();
  await expect(attachment(page)).toContainText('SELECTED_CARD_BODY'); await expect(attachment(page)).toContainText('选区外');
  await page.screenshot({ path: `${shots}/selection-expanded-1440.png` });
  await attachment(page).locator('summary').click();
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(input(page)).toHaveCount(1); await expect(input(page)).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: '开始研究', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(attachment(page)).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `${shots}/selection-composer-${width}.png` });
  }
  await flush(page); await page.reload(); await expect(attachment(page)).toBeVisible();
  expect((await data(page)).conversations[A].drawingQuestion).toEqual(question);
  await openConversation(page, '另一会话 B'); await expect(attachment(page)).toHaveCount(0); await expect(input(page)).toHaveValue('OTHER_SESSION_SECRET_INPUT');
  await openConversation(page, '自绘图研究 A'); await expect(attachment(page)).toBeVisible();
  await input(page).fill('解释这段自绘流程有哪些需要核对的条件。');
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  await expect.poll(async () => (await data(page)).requests[sent[0].requestId]?.status).toBe('done');
  expect(sent[0].sources).toEqual([]); expect(sent[0].focus).toBeUndefined();
  expect(sent[0].history).toEqual([{ prompt: '本会话既有问题', body: 'LOCAL_HISTORY_OK' }]);
  expect(JSON.stringify(sent[0])).not.toContain('OTHER_SESSION_SECRET'); expect(JSON.stringify(sent[0])).not.toContain('OUTSIDE_SECRET'); expect(JSON.stringify(sent[0])).not.toContain('unselected-sentinel');
  expect(sent[0].drawing?.snapshot).toEqual(question.snapshot);
  expect(sent[0].drawing?.imageDataUrl).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  const pixels = await page.evaluate(async url => {
    const image = new Image(); image.src = url!; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let magenta = 0, ink = 0, importedGreen = 0;
    for (let index = 0; index < bytes.length; index += 4) { if (bytes[index] > 220 && bytes[index + 1] < 40 && bytes[index + 2] > 220) magenta++; if (bytes[index] < 150 && bytes[index + 1] < 150 && bytes[index + 2] < 150) ink++; if (bytes[index] < 50 && bytes[index + 1] > 170 && bytes[index + 2] < 100) importedGreen++; }
    return { width: image.naturalWidth, height: image.naturalHeight, magenta, ink, importedGreen };
  }, sent[0].drawing?.imageDataUrl);
  expect(pixels.magenta).toBe(0); expect(pixels.ink).toBeGreaterThan(100); expect(pixels.importedGreen).toBeGreaterThan(100); expect(Math.max(pixels.width, pixels.height)).toBeLessThanOrEqual(2048);
  const after = await data(page); expect(after.drafts['draft-a']).toEqual(before.drafts['draft-a']); expect(after.cards).toEqual(before.cards);
  expect(after.requests[sent[0].requestId].conversationId).toBe(A); expect(after.requests[sent[0].requestId].researchRun?.suggestion).toBeUndefined();
  await expect(page.getByLabel('这轮的绘图快照', { exact: true })).toBeVisible(); await expect(attachment(page)).toHaveCount(0);
  await page.screenshot({ path: `${shots}/current-conversation-reply-1024.png` });
  await flush(page); await page.reload(); await expect(page.getByLabel('这轮的绘图快照', { exact: true })).toBeVisible();
});

test('单张卡片一键进入该卡片讨论：当前会话不可用也不报错，再问同卡片回到同一讨论', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    const paths = performance.getEntriesByType('resource').map(entry => entry.name), loaded = (path: string) => paths.find(name => new URL(name).pathname === path) ?? path;
    const { workspace } = await import(loaded('/src/services/workspace.ts')), { getAsset, putAsset, contentHash } = await import(loaded('/src/data/storage.ts'));
    const ref = workspace.getState().data.boards['board-a'].drawing!;
    const scene: DrawingScene = JSON.parse(await (await getAsset(ref.assetId))!.text());
    scene.elements = scene.elements.filter(element => element.id === 'resource-placement-a').map(element => ({ ...element, groupIds: [] }));
    const blob = new Blob([JSON.stringify(scene)], { type: 'application/json' }), hash = await contentHash(await blob.arrayBuffer()), assetId = `drawing-${hash}`;
    await putAsset(assetId, blob);
    // An imported native thread cannot take board questions; this used to stop with an error.
    workspace.updateData((next: WorkspaceData) => { next.boards['board-a'].drawing = { assetId, hash }; next.conversations['conversation-research-a'].nativeImported = true; });
  });
  await expect(drawing(page).getByRole('article', { name: '白板资料：相关性是检索收益的前提', exact: true })).toBeVisible();
  await drawing(page).getByTestId('toolbar-selection').locator('..').click();
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + 60 * .65, box.y + 175 * .65); await page.mouse.down(); await page.mouse.move(box.x + 365 * .65, box.y + 445 * .65, { steps: 12 }); await page.mouse.up();
  await expect(drawing(page)).toContainText('进入这张卡片的讨论');
  await drawing(page).getByRole('button', { name: '问 Agent', exact: true }).click();
  await expect(attachment(page)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(input(page)).toBeFocused();
  const first = await data(page), id = first.sessions['research-a'].activeConversationId!;
  expect(id).not.toBe(A);
  expect(first.conversations[id]).toMatchObject({ anchor: { kind: 'card', id: 'card-a' }, title: '卡片：相关性是检索收益的前提' });
  expect(first.conversations[id].drawingQuestion?.snapshot.elements.map(element => element.id)).toEqual(['resource-placement-a']);
  expect(first.conversations[A].drawingQuestion).toBeUndefined();
  await page.getByRole('region', { name: '当前会话', exact: true }).getByRole('button', { name: '选择会话', exact: true }).click();
  await page.getByRole('dialog', { name: '选择会话', exact: true }).getByRole('button', { name: '另一会话 B', exact: true }).click();
  await drawing(page).getByRole('button', { name: '问 Agent', exact: true }).click();
  await expect(attachment(page)).toBeVisible();
  const second = await data(page);
  expect(second.sessions['research-a'].activeConversationId).toBe(id);
  expect(Object.values(second.conversations).filter(item => item.anchor?.kind === 'card' && item.anchor.id === 'card-a')).toHaveLength(1);
  await page.screenshot({ path: `${shots}/card-thread-one-click-1440.png` });
});

test('失败与重试继续使用原图快照，即使白板后来改变', async ({ page }) => {
  const sent: ResearchAgentInput[] = [];
  await page.route('**/api/ai/research/run', async route => { sent.push(route.request().postDataJSON()); await route.fulfill({ contentType: 'application/x-ndjson', body: sent.length === 1 ? JSON.stringify({ type: 'error', error: '受控失败，附件不丢失。' }) + '\n' : response() }); });
  await start(page); const question = await selectAndAttach(page);
  await input(page).fill('先问图，失败后用同一图重试。'); await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(async () => (await data(page)).requests[sent[0]?.requestId]?.status).toBe('error');
  await expect(attachment(page)).toBeVisible(); await expect(input(page)).toHaveValue('先问图，失败后用同一图重试。');
  await flush(page); await page.reload(); await expect(attachment(page)).toBeVisible();
  await page.evaluate(async () => {
    const path = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/services/workspace.ts') ?? '/src/services/workspace.ts';
    (await import(path)).workspace.updateData((next: WorkspaceData) => { next.boards['board-a'].title = '之后改过的白板'; next.cards['card-a'].body = '之后改过的卡片'; });
  });
  await page.getByRole('button', { name: '返回会话', exact: true }).first().click();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => sent.length).toBe(2); await expect.poll(async () => (await data(page)).requests[sent[1].requestId]?.status).toBe('done');
  expect(sent[1].drawing).toEqual(sent[0].drawing); expect(sent[1].drawing?.snapshot).toEqual(question.snapshot);
  expect(sent[1].history).toEqual(sent[0].history); expect(sent[1].sources).toEqual([]);
  await page.screenshot({ path: `${shots}/retry-frozen-snapshot-1440.png` });
});

test('未支持图片时保留附件，只在明确选择后发送文字，不冒充看图', async ({ page }) => {
  const sent: ResearchAgentInput[] = [];
  await page.route('**/api/ai/research/run', async route => { sent.push(route.request().postDataJSON()); await route.fulfill({ contentType: 'application/x-ndjson', body: response() }); });
  await start(page, false); const question = await selectAndAttach(page);
  await expect(page.getByRole('button', { name: '开始研究', exact: true })).toBeDisabled();
  await expect(attachment(page)).toBeVisible(); await expect(input(page)).toHaveValue('这段输入先保留，问图时不能丢。');
  expect(sent).toHaveLength(0);
  await page.getByRole('button', { name: '仅发送文字和结构', exact: true }).click();
  await expect(attachment(page)).toContainText('Agent 未看图');
  await page.screenshot({ path: `${shots}/explicit-text-fallback-1440.png` });
  await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1); await expect.poll(async () => (await data(page)).requests[sent[0].requestId]?.status).toBe('done');
  expect(sent[0].drawing?.mode).toBe('text'); expect(sent[0].drawing?.snapshot).toEqual(question.snapshot); expect(sent[0].drawing?.imageDataUrl).toBeUndefined(); expect(sent[0].sources).toEqual([]);
  await page.getByRole('button', { name: '返回会话', exact: true }).first().click();
  await expect(page.getByLabel('这轮的绘图快照', { exact: true })).toContainText('Agent 未看图');
});

test('纯笔迹缺少图片能力时不提供假看图的文字降级', async ({ page }) => {
  await start(page, false);
  await page.evaluate(async () => {
    const paths = performance.getEntriesByType('resource').map(entry => entry.name), loaded = (path: string) => paths.find(name => new URL(name).pathname === path) ?? path;
    const { workspace } = await import(loaded('/src/services/workspace.ts')), { getAsset, putAsset, contentHash } = await import(loaded('/src/data/storage.ts'));
    const ref = workspace.getState().data.boards['board-a'].drawing!;
    const scene: DrawingScene = JSON.parse(await (await getAsset(ref.assetId))!.text());
    scene.elements = scene.elements.filter(element => element.id === 'selected-handwriting').map(element => ({ ...element, groupIds: [] }));
    const blob = new Blob([JSON.stringify(scene)], { type: 'application/json' }), hash = await contentHash(await blob.arrayBuffer()), assetId = `drawing-${hash}`;
    await putAsset(assetId, blob); workspace.updateData((next: WorkspaceData) => { next.boards['board-a'].drawing = { assetId, hash }; });
  });
  await expect(drawing(page).getByRole('article', { name: '白板资料：相关性是检索收益的前提', exact: true })).toBeVisible();
  await drawing(page).getByTestId('toolbar-selection').locator('..').click();
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.click(box.x + 520 * .65, box.y + 347 * .65);
  await drawing(page).getByRole('button', { name: '问 Agent', exact: true }).click();
  await expect(attachment(page)).toBeVisible();
  expect((await data(page)).conversations[A].drawingQuestion?.snapshot.elements.map(element => element.type)).toEqual(['freedraw']);
  await expect(page.getByRole('button', { name: '仅发送文字和结构', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始研究', exact: true })).toBeDisabled();
  await expect(page.getByLabel('研究 Agent', { exact: true })).toContainText('没有可发送的文字');
  await expect(input(page)).toHaveValue('这段输入先保留，问图时不能丢。');
  await page.screenshot({ path: `${shots}/handwriting-image-unavailable-1440.png` });
});

test('看图迟到答复仍归原会话，停止及刷新保留图片和输入', async ({ page }) => {
  const sent: ResearchAgentInput[] = [], releases: (() => void)[] = [];
  await page.route('**/api/ai/research/run', async route => {
    sent.push(route.request().postDataJSON());
    await new Promise<void>(resolve => { releases.push(resolve); });
    await route.fulfill({ contentType: 'application/x-ndjson', body: response() }).catch(() => {});
  });
  await start(page); await selectAndAttach(page);
  await input(page).fill('图的迟到回答应当留在 A。'); await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1); await openConversation(page, '另一会话 B');
  releases[0](); await expect.poll(async () => (await data(page)).requests[sent[0].requestId]?.status).toBe('done');
  await expect(input(page)).toHaveValue('OTHER_SESSION_SECRET_INPUT'); await expect(attachment(page)).toHaveCount(0);
  expect((await data(page)).sessions['research-a'].activeConversationId).toBe(B);
  expect((await data(page)).requests[sent[0].requestId].conversationId).toBe(A);
  await openConversation(page, '自绘图研究 A');
  await expect(page.getByLabel('这轮的绘图快照', { exact: true })).toBeVisible();
  await (await openResearchNavigation(page)).getByRole('button', { name: '证据与论证', exact: true }).first().click();
  await expect(canvas(page)).toBeVisible(); const second = await selectAndAttach(page);
  await input(page).fill('停止后这个问题和图片都要保留。'); await page.getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(() => sent.length).toBe(2); await page.getByRole('button', { name: '停止研究', exact: true }).click();
  releases[1](); await expect.poll(async () => (await data(page)).requests[sent[1].requestId]?.status).toBe('stopped');
  await expect(attachment(page)).toBeVisible(); await expect(input(page)).toHaveValue('停止后这个问题和图片都要保留。');
  expect((await data(page)).conversations[A].drawingQuestion).toEqual(second);
  await flush(page); await page.reload(); await expect(attachment(page)).toBeVisible(); await expect(input(page)).toHaveValue('停止后这个问题和图片都要保留。');
  await page.screenshot({ path: `${shots}/stopped-attachment-restored-1440.png` });
});
