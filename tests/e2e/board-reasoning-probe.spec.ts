import { expect, test, type Locator } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createSeed, emptySession } from '../../src/data/seed';
import { parseBoardPlan, previewBoardPlan } from '../../src/domain/board-history';
import type { BoardContext, BoardPlan, BoardSnapshot, ContextSnapshot } from '../../src/domain/types';
import { openResearchPage } from './knowledge-helpers';
import { mockProjectService } from './project-fixture';
import { state } from './workspace-split-helpers';

const directory = 'docs/verification/board-reasoning';
type ProbeFixture = {
  synthetic: true;
  documents: { id: string; title: string; excerpts: string[] }[];
  request: { context: ContextSnapshot[]; boardContext: BoardContext };
};
type ProbeResult = { plan: BoardPlan; preview: BoardSnapshot; turn: { model?: string } };

async function measure(board: Locator, edges: BoardSnapshot['edges']) {
  return board.evaluate((root, expectedEdges) => {
    const canvas = root.querySelector<HTMLElement>('.board-canvas')!;
    const viewport = root.querySelector<HTMLElement>('.board-viewport')!;
    const scale = new DOMMatrix(getComputedStyle(canvas).transform).a;
    const visible = viewport.getBoundingClientRect();
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('.board-node')).map(element => {
      const rect = element.getBoundingClientRect(), heading = element.querySelector('h3')!;
      const body = element.querySelector<HTMLElement>('.board-card-body');
      return {
        id: element.dataset.placementId!, title: heading.textContent,
        x: element.offsetLeft, y: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight,
        titleScreenFontPx: parseFloat(getComputedStyle(heading).fontSize) * scale,
        bodyScreenFontPx: body ? parseFloat(getComputedStyle(body).fontSize) * scale : null,
        bodyClipped: !!body && body.scrollHeight > body.clientHeight + 1,
        fullyVisible: rect.left >= visible.left && rect.top >= visible.top && rect.right <= visible.right && rect.bottom <= visible.bottom,
      };
    });
    const groups = Array.from(root.querySelectorAll<HTMLElement>('.board-group')).map(element => ({
      id: element.textContent ?? '', x: element.offsetLeft, y: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight,
    }));
    const overlaps = (items: { id: string; x: number; y: number; width: number; height: number }[]) => items.flatMap((a, index) => items.slice(index + 1).flatMap(b => {
      const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      return width > 0 && height > 0 ? [{ first: a.id, second: b.id, width, height }] : [];
    }));
    const sampledThirdCardIntersections = expectedEdges.flatMap(edge => {
      const path = root.querySelector<SVGPathElement>(`[data-edge-id="${edge.id}"] .board-connection-stroke`)!;
      const length = path.getTotalLength();
      const points = Array.from({ length: 399 }, (_, index) => path.getPointAtLength(length * (index + 1) / 400));
      return nodes.filter(node => node.id !== edge.fromPlacementId && node.id !== edge.toPlacementId && points.some(point =>
        point.x > node.x + 1 && point.x < node.x + node.width - 1 && point.y > node.y + 1 && point.y < node.y + node.height - 1,
      )).map(node => ({ edgeId: edge.id, label: edge.label, obstructingPlacementId: node.id, obstructingTitle: node.title }));
    });
    return {
      scale, canvas: { width: canvas.offsetWidth, height: canvas.offsetHeight },
      viewport: { width: viewport.clientWidth, height: viewport.clientHeight, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop },
      boardBounds: { left: Math.min(...nodes.map(node => node.x)), top: Math.min(...nodes.map(node => node.y)), right: Math.max(...nodes.map(node => node.x + node.width)), bottom: Math.max(...nodes.map(node => node.y + node.height)) },
      nodes, fullyVisibleNodes: nodes.filter(node => node.fullyVisible).length,
      clippedCardBodies: nodes.filter(node => node.bodyClipped).length,
      cardOverlaps: overlaps(nodes), groupOverlaps: overlaps(groups), sampledThirdCardIntersections,
      edgeCount: root.querySelectorAll('.board-edge').length,
      relationshipLabelCount: root.querySelectorAll('.board-connection-label').length,
    };
  }, edges);
}

test('真实 Codex 复杂白板输出的隔离渲染回放，不代替真实发送与应用验收', async ({ page }) => {
  test.skip(!existsSync(`${directory}/codex-probe.json`), '真实模型尚未完成；不生成替代答案。');
  const resultText = await readFile(`${directory}/codex-probe.json`, 'utf8');
  const result = JSON.parse(resultText) as ProbeResult;
  expect(result.plan, '需要真实模型输出经过生产解析器生成的 plan').toBeTruthy();
  const fixture = JSON.parse(await readFile(`${directory}/fixture.json`, 'utf8')) as ProbeFixture;
  const context = fixture.request.boardContext;
  const plan = parseBoardPlan(JSON.stringify(result.plan), context);
  const preview = previewBoardPlan(context, plan);
  expect(preview).toEqual(result.preview);
  const seed = createSeed(), researchId = context.researchId, boardId = context.boardId;
  seed.researches[researchId] = { id: researchId, title: '真实 AI 输出 · 隔离回放', question: '演示材料的方法、架构与验证计划', documentIds: fixture.documents.map(item => item.id), cardIds: [], createdAt: '2026-10-20' };
  for (const document of fixture.documents) {
    // These synthetic texts have no PDF asset; keep metadata-only records instead of borrowing an unrelated PDF.
    seed.documents[document.id] = { id: document.id, title: document.title, authors: '虚构演示材料', year: '', readingStatus: 'unread', textStatus: 'pending' };
  }
  for (const source of fixture.request.context) seed.evidence[source.evidenceId] = { id: source.evidenceId, documentId: source.documentId, pageIndex: source.pageIndex, quote: source.quote };
  seed.boards[boardId] = preview.board;
  plan.nodes.forEach((node, index) => {
    expect(node.card, '本实验 create 上下文为空，节点必须由真实输出创建').toBeTruthy();
    const placement = preview.placements[index], id = placement.resourceRef.id;
    seed.cards[id] = { id, ...node.card!, needsReview: true };
    seed.researches[researchId].cardIds.push(id);
    seed.placements[placement.id] = structuredClone(placement);
  });
  preview.edges.forEach(edge => { seed.edges[edge.id] = structuredClone(edge); });
  seed.scope = { kind: 'research', researchId };
  seed.sessions[researchId] = emptySession({ kind: 'board', id: boardId });
  seed.sessions[researchId].panel.open = false;
  seed.sessions[researchId].viewports[boardId] = { x: 0, y: 0, scale: 1 };
  const blockedRequests: string[] = [];
  await page.route('**/api/**', route => {
    blockedRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 503, json: { error: '隔离回放禁止真实后端与模型请求。' } });
  });
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, model: 'render-replay-only', images: false } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await openResearchPage(page, plan.title);
  const board = page.getByRole('main', { name: '主工作区' });
  await expect(board.locator('.board-node')).toHaveCount(plan.nodes.length);
  await expect(board.locator('.board-connection-stroke')).toHaveCount(plan.edges.length);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await mkdir(directory, { recursive: true });
  const captures: { name: string; browserViewport: { width: number; height: number }; measurements: Awaited<ReturnType<typeof measure>> }[] = [];
  async function capture(name: string, width: number, height: number) {
    await page.setViewportSize({ width, height });
    await board.locator('.board-viewport').evaluate(element => element.scrollTo(0, 0));
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    await page.screenshot({ path: `${directory}/render-${name}.png` });
    captures.push({ name, browserViewport: { width, height }, measurements: await measure(board, preview.edges) });
  }
  await capture('1440', 1440, 900);
  await capture('1280', 1280, 800);
  await page.setViewportSize({ width: 1440, height: 900 });
  while (await board.getByRole('button', { name: '缩小白板', exact: true }).isEnabled()) await board.getByRole('button', { name: '缩小白板', exact: true }).click();
  await expect(board.getByRole('button', { name: '重置白板缩放', exact: true })).toHaveText('40%');
  await capture('overview-40', 1440, 900);
  const overview = captures.at(-1)!.measurements;
  if (overview.fullyVisibleNodes < plan.nodes.length) {
    await capture('overview-large-window-40', Math.min(4000, Math.ceil(overview.canvas.width * .4 + 500)), Math.min(4000, Math.ceil(overview.canvas.height * .4 + 250)));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await board.getByRole('button', { name: '重置白板缩放', exact: true }).click();
  const selectedIndex = plan.nodes.findIndex(node => node.card?.body.startsWith('建议：'));
  const selected = plan.nodes[Math.max(0, selectedIndex)].card!;
  await board.getByRole('button', { name: `编辑内容：${selected.title}`, exact: true }).click();
  const panel = page.getByRole('complementary', { name: '参考面板' });
  await expect(panel.getByLabel('卡片标题', { exact: true })).toHaveValue(selected.title);
  await expect(panel.getByLabel('卡片正文', { exact: true })).toHaveValue(selected.body);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  await page.screenshot({ path: `${directory}/render-selected-content.png` });
  await page.reload();
  await expect(board.locator('.board-node')).toHaveCount(plan.nodes.length);
  await expect(board.locator('.board-connection-stroke')).toHaveCount(plan.edges.length);
  await expect(panel.getByLabel('卡片正文', { exact: true })).toHaveValue(selected.body);
  const persisted = await state(page);
  expect(Object.values(persisted.placements).filter(item => item.boardId === boardId)).toEqual(preview.placements);
  expect(Object.values(persisted.edges).filter(item => item.boardId === boardId)).toEqual(preview.edges);
  for (const placement of preview.placements) expect(persisted.cards[placement.resourceRef.id]).toEqual(seed.cards[placement.resourceRef.id]);
  const report = {
    mode: '真实模型输出的 fixture 渲染回放；不是完整真实发送、应用或 PDF 回源验收',
    generatedAt: new Date().toISOString(), source: 'codex-probe.json', sourceSha256: createHash('sha256').update(resultText).digest('hex'), model: result.turn.model,
    plan: { title: plan.title, layout: plan.layout, nodes: plan.nodes.length, edges: plan.edges.length, groups: new Set(plan.nodes.map(node => node.group)).size },
    checks: { productionPreviewMatches: true, renderedCountsMatch: true, fullContentAccessible: true, refreshPreservesAllCardsPlacementsEdges: true },
    captures, blockedRequests, pageErrors,
    limitations: ['虚构材料；不证明研究结论正确。', 'fixture 直接注入共享数据；未覆盖真实请求发送、自动应用、版本历史生成。', '未修改 AI 输出、production preview 坐标或生产 UI。', '未测试 PDF 原文回跳；演示材料没有原始 PDF。', '线穿卡统计为每条路径 399 个采样点的近似检测，未衡量全部线线交叉与标签遮挡。', '树形父子关系、分支折叠、大纲同步仍未实现。', '40% 总览标题约 6px、正文约 4.8px；可见全图不代表内容可读。'],
  };
  await writeFile(`${directory}/render-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  expect(blockedRequests, '回放不应发起其他真实接口请求').toEqual([]);
  expect(pageErrors).toEqual([]);
});
