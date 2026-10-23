import { expect, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../../src/data/seed';
import type { WorkspaceData } from '../../../src/domain/types';
import type { ResearchAgentInput } from '../../../src/domain/research-agent';
import type { DrawingScene } from '../../../src/domain/drawing';
import { mockProjectService } from '../../../tests/e2e/project-fixture';

export const evidenceDirectory = 'docs/verification/continuous-workspace';
export const primaryId = 'conversation-research-a';
export const secondaryId = 'continuous-secondary';
export const paperTitle = 'Adaptive Retrieval: Evidence & Reliability';
export const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
export const chat = (page: Page) => page.getByRole('region', { name: '当前会话', exact: true });
export const composer = (page: Page) => chat(page).getByRole('textbox', { name: '研究目标', exact: true });
export const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
export const selectionMenu = (page: Page) => page.getByLabel('原文选区操作', { exact: true });
export const inline = (page: Page, operation = '提问') => page.getByRole('dialog', { name: `原文旁${operation}`, exact: true });
export const ndjson = (events: object[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';

export function controlledSeed() {
  const seed = createSeed();
  seed.agentWorkbench = true;
  const session = seed.sessions['research-a'];
  session.active = { kind: 'document', id: 'paper-a' };
  session.openItems = [{ kind: 'document', id: 'paper-a' }];
  session.activeConversationId = primaryId;
  session.agentChat = { mode: 'side' };
  seed.conversations[primaryId] = { ...seed.conversations[primaryId], title: '条件比较 A', connectionId: 'codex', input: '' };
  seed.conversations[secondaryId] = { id: secondaryId, researchId: 'research-a', title: '补查证据 B',
    contextIds: [], requestIds: [], connectionId: 'codex', input: '另一个会话的私有草稿' };
  return seed;
}

// All model/project routes are synthetic; no user documents, credentials or CLI histories are used.
export async function installControlledServices(page: Page, options: { seed?: WorkspaceData; initialize?: boolean } = {}) {
  const researchCalls: ResearchAgentInput[] = [], localCalls: Record<string, unknown>[] = [], unexpected: string[] = [], errors: string[] = [], hotUpdates: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/\[vite\].*(?:hot updated:|page reload)/.test(message.text())) hotUpdates.push(message.text()); });
  await page.route('**/api/ai/**', route => {
    unexpected.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 501, json: { error: 'Continuous workspace fixture did not authorize this endpoint' } });
  });
  await mockProjectService(page, { seed: options.seed ?? controlledSeed(), initializeWorkspace: options.initialize !== false });
  await page.route('**/api/ai/config', route => route.fulfill({ json: {
    configured: true, runtime: 'pi', model: 'controlled-continuous', provider: '确定性验收', images: true, mode: 'live',
    limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 },
  } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [
    { id: 'codex', name: 'Codex', state: 'ready', version: 'fixture-only', capabilities: { tools: true, images: true, resume: true, permissions: 'read-only' } },
    { id: 'claude', name: 'Claude Code', state: 'ready', version: 'fixture-only', capabilities: { tools: false, images: false, resume: true, permissions: 'none' } },
  ] } }));
  await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: {
    models: [{ id: 'controlled-continuous', name: '受控验收模型', isDefault: true, inputModalities: ['text', 'image'] }], skills: [], plan: true, accessModes: ['read-only', 'full-access'],
  } }));
  await page.route('**/api/ai/research/capabilities', route => route.fulfill({ json: { connections: [
    { id: 'codex', research: true, images: true, detail: '受控验收连接，未调用真实模型' },
    { id: 'claude', research: false, images: false, detail: '仅文字；未接研究工具' },
  ] } }));
  await page.route('**/api/ai/research/run', route => {
    researchCalls.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/x-ndjson', body: ndjson([
      { type: 'delta', text: `受控研究回答 ${researchCalls.length}：先对齐检索条件，再核查相关性。回答在当前会话完整保留。` },
      { type: 'done', model: 'controlled-continuous', readPages: [] },
    ]) });
  });
  for (const endpoint of ['chat', 'agents/run']) await page.route(`**/api/ai/${endpoint}`, route => {
    const payload = route.request().postDataJSON(); localCalls.push(payload);
    const text = JSON.stringify(payload);
    const isBrief = payload.purpose === 'card' && text.includes('文章简要');
    const body = isBrief ? JSON.stringify({ title: '文章简要', body: '受控文章简要：本篇研究证据选择与可靠性，覆盖范围以提取记录为准；这里只是 AI 背景。', evidenceIds: [] })
      : text.includes('翻译') ? '受控翻译：这份样例比较了固定检索与自适应证据选择。[1]'
      : text.includes('摘要') ? '受控摘要：检索收益依赖证据与问题的相关性，需要保留适用条件。[1]'
      : `受控局部回答 ${localCalls.length}：相关证据需要覆盖当前问题，并保留原文条件。[1]`;
    return route.fulfill({ contentType: 'application/x-ndjson', body: ndjson([
      { type: 'delta', text: body }, { type: 'done', model: 'controlled-continuous' },
    ]) });
  });
  return { researchCalls, localCalls, unexpected, errors, hotUpdates, assertClean() { expect(errors).toEqual([]); expect(unexpected).toEqual([]); expect(hotUpdates, '验收过程不能混入热更新').toEqual([]); } };
}

export async function readData(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const journal = localStorage.getItem('papertrail-recovery-v3');
    if (journal) return JSON.parse(journal);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { return await new Promise<WorkspaceData>((resolve, reject) => {
      const request = db.transaction('workspace').objectStore('workspace').get('current');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  });
}

export async function readDrawing(page: Page, boardId = 'board-a'): Promise<DrawingScene | undefined> {
  const ref = (await readData(page)).boards[boardId].drawing;
  if (!ref) return undefined;
  return page.evaluate(async assetId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        const request = db.transaction('assets').objectStore('assets').get(assetId);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      return JSON.parse(await blob.text());
    } finally { db.close(); }
  }, ref.assetId);
}

export async function openSeedPaper(page: Page) {
  await expect(main(page)).toBeVisible();
  await expect(main(page).locator('.pdf-text-layer span').filter({ hasText: 'This self-authored fixture describes' }).first()).toBeVisible();
  await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
  await saved(page);
}

export async function selectPassage(page: Page, text = 'This self-authored fixture describes', reader?: Locator) {
  const span = (reader ?? main(page)).locator('.pdf-text-layer span').filter({ hasText: text }).first();
  await span.scrollIntoViewIfNeeded();
  const points = await span.evaluate(element => {
    const node = element.firstChild!;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(58, node.textContent!.length));
    const rect = range.getBoundingClientRect();
    return { x: rect.x + 1, endX: rect.right - 1, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(points.x, points.y); await page.mouse.down();
  await page.mouse.move(points.endX, points.y, { steps: 15 }); await page.mouse.up();
  await expect(selectionMenu(page)).toBeVisible();
}

export async function screenshot(page: Page, name: string) {
  await mkdir(`${evidenceDirectory}/screenshots`, { recursive: true });
  await saved(page); await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${evidenceDirectory}/screenshots/${name}`, fullPage: false });
}
