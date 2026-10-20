import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { WorkspaceData } from '../../src/domain/types';
import { openResearchPage, switchResearch } from './knowledge-helpers';
import { state as data } from './workspace-split-helpers';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
function boardSnapshot(state: WorkspaceData, id = 'board-a') {
  return { board: state.boards[id], placements: Object.values(state.placements).filter(item => item.boardId === id), edges: Object.values(state.edges).filter(item => item.boardId === id) };
}
async function start(page: Page, response: 'demo' | 'destructive' | 'addition' = 'demo') {
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: response !== 'demo', model: 'board-test', images: false } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  if (response !== 'demo') await page.route('**/api/ai/chat', async route => {
    const requestId = route.request().postDataJSON().requestId;
    await expect.poll(async () => !!(await data(page)).requests[requestId]).toBe(true);
    const state = await data(page), request = state.requests[requestId];
    const context = request.boardContext!, kept = response === 'addition' ? context.snapshot.placements : context.snapshot.placements.slice(0, 2);
    const plan = { title: context.snapshot.board.title, summary: response === 'addition' ? '受控验证：保持既有布局，摆放一项研究资料。' : '受控验证：保留前两项，移出其余摆放。', layout: response === 'addition' ? 'preserve' : 'groups', nodes: [...kept.map(item => ({ placementId: item.id, resourceRef: item.resourceRef, group: response === 'addition' ? item.group ?? '' : '保留' })), ...(response === 'addition' ? [{ resourceRef: context.resources.find(resource => !kept.some(item => item.resourceRef.kind === resource.ref.kind && item.resourceRef.id === resource.ref.id))!.ref, group: '补充资料' }] : [])], edges: context.snapshot.edges.filter(edge => kept.some(item => item.id === edge.fromPlacementId) && kept.some(item => item.id === edge.toPlacementId)).map(edge => ({ from: kept.findIndex(item => item.id === edge.fromPlacementId), to: kept.findIndex(item => item.id === edge.toPlacementId), label: edge.label })) };
    await route.fulfill({ contentType: 'application/x-ndjson', body: [JSON.stringify({ type: 'delta', text: JSON.stringify(plan) }), JSON.stringify({ type: 'done', model: 'board-test' })].join('\n') + '\n' });
  });
  await page.goto('/');
  await saved(page);
  await openResearchPage(page, '证据与论证');
  await main(page).getByRole('button', { name: '让 Agent 整理', exact: true }).click();
  await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
  await panel(page).getByRole('button', { name: response !== 'demo' ? '模型直连' : '演示模式', exact: true }).click();
  await main(page).getByRole('button', { name: '让 Agent 整理', exact: true }).click();
  await expect(panel(page).getByLabel('整理目标白板')).toHaveValue('board-a');
  await expect(panel(page).getByLabel('白板整理材料范围')).toHaveValue('board');
}
async function propose(page: Page, question = '将这些资料按观点与论文分组，保留已有来源，整理成清楚的研究结构。') {
  await panel(page).getByLabel('向 AI 提问').fill(question);
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  const proposal = panel(page).getByRole('region', { name: '白板整理提案', exact: true }).last();
  await expect(proposal).toBeVisible();
  return proposal;
}

test('既有白板大范围重排先预览确认，退出单次模式，人工修改后恢复为副本', async ({ page }) => {
  await start(page);
  const before = await data(page), original = boardSnapshot(before);
  const proposal = await propose(page);
  await expect(proposal.getByText('等待确认', { exact: true })).toBeVisible();
  await expect(panel(page).getByLabel('整理目标白板')).toHaveCount(0);
  await proposal.getByRole('button', { name: '预览白板整理', exact: true }).click();
  await expect(proposal.locator('.board-graph-preview')).toBeVisible();
  expect(boardSnapshot(await data(page))).toEqual(original);
  await proposal.getByRole('button', { name: '取消预览', exact: true }).click();
  expect(boardSnapshot(await data(page))).toEqual(original);
  await proposal.getByRole('button', { name: '确认应用此批变更', exact: true }).click();
  await expect(proposal.getByText('已保存', { exact: true })).toBeVisible();
  await saved(page);
  let state = await data(page);
  expect(boardSnapshot(state)).not.toEqual(original);
  expect(state.cards).toEqual(before.cards);
  expect(state.evidence).toEqual(before.evidence);
  const change = Object.values(state.boardChanges ?? {}).find(item => item.requestId)!;
  expect(change).toBeTruthy();
  await mkdir('docs/verification/chat-board', { recursive: true });
  await page.screenshot({ path: 'docs/verification/chat-board/edited-1440.png' });
  await page.reload();
  await expect(main(page).getByRole('button', { name: '白板版本历史', exact: true })).toBeVisible();
  expect((await data(page)).boardChanges?.[change.id]).toEqual(change);
  const card = main(page).locator('[data-placement-id="placement-a"]');
  await card.click();
  await main(page).getByLabel('白板分组名称').fill('人工补充的边界');
  await main(page).getByRole('button', { name: '应用分组', exact: true }).click();
  const manuallyEdited = boardSnapshot(await data(page));
  await main(page).getByRole('button', { name: '白板版本历史', exact: true }).click();
  const history = main(page).getByRole('region', { name: '白板版本历史', exact: true });
  await history.getByRole('button', { name: new RegExp(change.summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
  await expect(history.getByRole('heading', { name: '修改前', exact: true })).toBeVisible();
  await expect(history.getByRole('heading', { name: '修改后', exact: true })).toBeVisible();
  await history.getByRole('button', { name: '恢复此次变更前', exact: true }).click();
  await expect(history.getByRole('alert')).toContainText('冲突');
  await expect(history.getByRole('alert')).toBeInViewport();
  await page.screenshot({ path: 'docs/verification/chat-board/history-conflict-1440.png' });
  expect(boardSnapshot(await data(page))).toEqual(manuallyEdited);
  await history.getByRole('button', { name: '保留当前，恢复为副本', exact: true }).click();
  await saved(page);
  state = await data(page);
  const restored = Object.values(state.boards).find(board => board.title.endsWith('（恢复副本）'))!;
  expect(restored).toBeTruthy();
  expect(boardSnapshot(state)).toEqual(manuallyEdited);
  expect(Object.values(state.boardChanges ?? {}).filter(item => item.restores === change.id)).toHaveLength(1);
  expect(boardSnapshot(state, restored.id).placements.map(item => item.resourceRef)).toEqual(original.placements.map(item => item.resourceRef));
  await page.reload();
  expect((await data(page)).boards[restored.id]).toBeTruthy();
});

test('破坏性提案预览不写数据，过期不覆盖人工修改，保存失败重试不重复应用', async ({ page }) => {
  await start(page, 'destructive');
  const before = boardSnapshot(await data(page));
  const proposal = await propose(page);
  await proposal.getByRole('button', { name: '预览白板整理', exact: true }).click();
  await expect(proposal.getByText('只读预览 · 已有内容的调整等待确认')).toBeVisible();
  expect(boardSnapshot(await data(page))).toEqual(before);
  await main(page).locator('[data-placement-id="placement-a"]').click();
  await main(page).getByLabel('白板分组名称').fill('生成后的人工修改');
  await main(page).getByRole('button', { name: '应用分组', exact: true }).click();
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  const manual = boardSnapshot(await data(page));
  await proposal.getByRole('button', { name: '确认应用此批变更', exact: true }).click();
  await expect(proposal.getByRole('alert')).toContainText('已修改');
  expect(boardSnapshot(await data(page))).toEqual(manual);
  await main(page).getByRole('button', { name: '让 Agent 整理', exact: true }).click();
  const fresh = await propose(page, '依据最新的白板分组重新整理，保留原文来源。');
  await saved(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'workspace') { IDBObjectStore.prototype.put = original; throw new DOMException('board test quota', 'QuotaExceededError'); }
      return original.apply(this, args);
    };
  });
  await fresh.getByRole('button', { name: '确认应用此批变更', exact: true }).click();
  await expect(fresh.getByRole('alert')).toContainText('保存');
  const changes = Object.values((await data(page)).boardChanges ?? {}).filter(change => change.requestId);
  expect(changes).toHaveLength(1);
  await fresh.getByRole('button', { name: '重试保存白板', exact: true }).click();
  await saved(page);
  await expect(fresh.getByRole('alert')).toHaveCount(0);
  expect(Object.values((await data(page)).boardChanges ?? {}).filter(change => change.requestId)).toEqual(changes);
});

test('纯新增自动保存，单次目标与范围按会话恢复，迟到编辑不跨研究', async ({ page }) => {
  await start(page, 'addition');
  const originalPlacements = boardSnapshot(await data(page)).placements;
  await panel(page).getByLabel('白板整理材料范围').selectOption('research');
  await panel(page).getByLabel('向 AI 提问').fill('按研究资料与卡片组织成论证结构，保留已有关系。');
  await switchResearch(page, 'research-b'); await switchResearch(page, 'research-a');
  await expect(panel(page).getByLabel('白板整理材料范围')).toHaveValue('research');
  await expect(panel(page).getByLabel('整理目标白板')).toHaveValue('board-a');
  await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
  await switchResearch(page, 'research-b');
  await expect(panel(page).getByRole('region', { name: '白板整理提案', exact: true })).toHaveCount(0);
  const other = boardSnapshot(await data(page), 'board-b');
  await expect.poll(async () => Object.values((await data(page)).requests).filter(request => request.researchId === 'research-a' && request.status === 'done').length).toBe(1);
  expect(boardSnapshot(await data(page), 'board-b')).toEqual(other);
  await expect.poll(async () => Object.values((await data(page)).boardChanges ?? {}).filter(change => change.requestId).length).toBe(1);
  await switchResearch(page, 'research-a');
  expect(boardSnapshot(await data(page)).placements.filter(item => originalPlacements.some(original => original.id === item.id))).toEqual(originalPlacements);
  await expect(panel(page).getByLabel('整理目标白板')).toHaveCount(0);
  const proposal = panel(page).getByRole('region', { name: '白板整理提案', exact: true });
  await proposal.getByRole('button', { name: '预览白板整理', exact: true }).click();
  await panel(page).getByLabel('向 AI 提问').fill('继续保留的未发送内容');
  await panel(page).getByRole('tab', { name: '卡片', exact: true }).click();
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('继续保留的未发送内容');
  await saved(page); await page.reload();
  await expect(panel(page).getByLabel('整理目标白板')).toHaveCount(0);
  await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('继续保留的未发送内容');
});

test('Agent 应用后旧移出撤销失效，最新整理可从历史安全恢复', async ({ page }) => {
  await start(page);
  await main(page).locator('[data-placement-id="placement-c"]').click();
  await main(page).getByRole('button', { name: '移出白板', exact: true }).click();
  await expect(main(page).getByRole('button', { name: '撤销移出', exact: true })).toBeEnabled();
  const removed = boardSnapshot(await data(page));
  await main(page).getByRole('button', { name: '让 Agent 整理', exact: true }).click();
  const proposal = await propose(page);
  await proposal.getByRole('button', { name: '确认应用此批变更', exact: true }).click();
  await expect(proposal.getByText('已保存', { exact: true })).toBeVisible();
  await expect(main(page).getByRole('button', { name: '撤销移出', exact: true })).toBeDisabled();
  await main(page).getByRole('button', { name: '白板版本历史', exact: true }).click();
  const history = main(page).getByRole('region', { name: '白板版本历史', exact: true });
  await history.locator('.board-history-item').first().click();
  await history.getByRole('button', { name: '恢复此次变更前', exact: true }).click();
  await saved(page);
  await expect(history.getByRole('alert')).toHaveCount(0);
  expect(boardSnapshot(await data(page))).toEqual(removed);
  expect(Object.values((await data(page)).boardChanges ?? {}).some(change => change.restores)).toBe(true);
  await expect(main(page).getByRole('button', { name: '撤销移出', exact: true })).toBeDisabled();
});
