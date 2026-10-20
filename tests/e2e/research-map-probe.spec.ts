import { expect, test, type Locator } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createSeed, emptySession } from '../../src/data/seed';
import { parseBoardPlan, previewBoardPlan } from '../../src/domain/board-history';
import type { BoardContext, BoardPlan, BoardSnapshot, ContextSnapshot } from '../../src/domain/types';
import { openResearchPage } from './knowledge-helpers';
import { mockProjectService } from './project-fixture';
import { main, panel, saved, state } from './workspace-split-helpers';

const sourceDirectory = 'docs/verification/research-map/ai-existing-map';
const outputDirectory = 'docs/verification/tree-board';
type Fixture = { synthetic: true; documents: { id: string; title: string }[]; request: { context: ContextSnapshot[]; boardContext: BoardContext } };
type Result = { plan: BoardPlan; preview: BoardSnapshot; turn: { model: string; rawBody: string } };

async function measure(board: Locator, edges: BoardSnapshot['edges']) {
  return board.evaluate((root, relationships) => {
    const canvas = root.querySelector<HTMLElement>('.board-canvas')!, viewport = root.querySelector<HTMLElement>('.board-viewport')!;
    const scale = new DOMMatrix(getComputedStyle(canvas).transform).a, visible = viewport.getBoundingClientRect();
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('.board-node')).map(element => {
      const heading = element.querySelector<HTMLElement>('h3')!, rect = element.getBoundingClientRect(), body = element.querySelector<HTMLElement>('.board-card-body');
      return { id: element.dataset.placementId!, title: heading.textContent, x: element.offsetLeft, y: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight,
        iconRole: element.querySelector('.board-node-kind')?.getAttribute('title'), iconClass: element.querySelector('.board-node-kind svg')?.getAttribute('class'),
        screenTitleFontPx: parseFloat(getComputedStyle(heading).fontSize) * scale, screenBodyFontPx: body ? parseFloat(getComputedStyle(body).fontSize) * scale : null,
        titleClipped: heading.scrollHeight > heading.clientHeight + 1, bodyClipped: !!body && body.scrollHeight > body.clientHeight + 1,
        fullyVisible: rect.left >= visible.left && rect.top >= visible.top && rect.right <= visible.right && rect.bottom <= visible.bottom };
    });
    const cardOverlaps = nodes.flatMap((a, index) => nodes.slice(index + 1).flatMap(b => {
      const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      return width > 0 && height > 0 ? [{ first: a.id, second: b.id, width, height }] : [];
    }));
    const paths = Array.from(root.querySelectorAll<SVGPathElement>('.board-structure-stroke,.board-connection-stroke')).map(path => {
      const structural = path.classList.contains('board-structure-stroke'), edgeId = path.closest('[data-edge-id]')?.getAttribute('data-edge-id'), edge = relationships.find(item => item.id === edgeId);
      const from = structural ? path.dataset.parentId : edge?.fromPlacementId, to = structural ? path.dataset.childId : edge?.toPlacementId;
      const length = path.getTotalLength(), samples = Array.from({ length: 799 }, (_, index) => path.getPointAtLength(length * (index + 1) / 800));
      return { kind: structural ? 'parent-child' : 'semantic', id: edgeId ?? `${from}->${to}`, from, to, length,
        thirdCardIntersections: nodes.filter(node => node.id !== from && node.id !== to && samples.some(point => point.x > node.x + 1 && point.x < node.x + node.width - 1 && point.y > node.y + 1 && point.y < node.y + node.height - 1)).map(node => node.id) };
    });
    return { scale, canvas: { width: canvas.offsetWidth, height: canvas.offsetHeight }, viewport: { width: viewport.clientWidth, height: viewport.clientHeight, x: viewport.scrollLeft, y: viewport.scrollTop }, nodes,
      fullyVisibleNodes: nodes.filter(node => node.fullyVisible).length, clippedTitles: nodes.filter(node => node.titleClipped).length, cardOverlaps,
      structuralCount: paths.filter(path => path.kind === 'parent-child').length, semanticCount: paths.filter(path => path.kind === 'semantic').length, paths,
      groupRectangles: root.querySelectorAll('.board-group').length, documentWidth: document.documentElement.scrollWidth };
  }, edges);
}

test('真实 AI 扩展既有导图：结构、关联避障与可读分支的隔离回放', async ({ page }) => {
  test.skip(!existsSync(`${sourceDirectory}/codex-probe.json`), '需要真实模型结果，不制造替代输出。');
  const fixture = JSON.parse(await readFile(`${sourceDirectory}/fixture.json`, 'utf8')) as Fixture;
  const resultText = await readFile(`${sourceDirectory}/codex-probe.json`, 'utf8'), result = JSON.parse(resultText) as Result;
  const context = fixture.request.boardContext, plan = parseBoardPlan(result.turn.rawBody, context), preview = previewBoardPlan(context, plan);
  expect(plan).toEqual(result.plan); expect(preview).toEqual(result.preview); expect(preview.board.layout).toBe('tree');
  const seed = createSeed(), researchId = context.researchId, boardId = context.boardId;
  seed.researches[researchId] = { id: researchId, title: '真实 AI 导图 · 隔离回放', question: '更新方法、运行条件与评估计划', documentIds: fixture.documents.map(document => document.id), cardIds: [], createdAt: '2026-10-20' };
  for (const document of fixture.documents) seed.documents[document.id] = { ...document, authors: '虚构演示材料', year: '', readingStatus: 'unread', textStatus: 'pending' };
  for (const source of fixture.request.context) seed.evidence[source.evidenceId] = { id: source.evidenceId, documentId: source.documentId, pageIndex: source.pageIndex, quote: source.quote };
  seed.boards[boardId] = preview.board;
  plan.nodes.forEach((node, index) => {
    const placement = preview.placements[index], id = placement.resourceRef.id;
    const original = node.resourceRef && context.resources.find(resource => resource.ref.id === node.resourceRef?.id);
    const card = node.card ?? { title: original!.title, body: original!.body!, evidenceIds: original!.evidenceIds };
    seed.cards[id] = { id, ...structuredClone(card), needsReview: !!node.card };
    seed.researches[researchId].cardIds.push(id); seed.placements[placement.id] = structuredClone(placement);
  });
  preview.edges.forEach(edge => { seed.edges[edge.id] = structuredClone(edge); });
  seed.scope = { kind: 'research', researchId }; seed.sessions[researchId] = emptySession({ kind: 'board', id: boardId });
  seed.sessions[researchId].panel.open = false; seed.sessions[researchId].viewports[boardId] = { x: 0, y: 0, scale: 1 };
  const blockedRequests: string[] = [], pageErrors: string[] = [];
  await page.route('**/api/**', route => { blockedRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`); return route.fulfill({ status: 503, json: { error: '隔离回放禁止真实后端请求。' } }); });
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, model: 'tree-render-replay-only', images: false } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/'); await saved(page); await openResearchPage(page, plan.title);
  const board = main(page), node = (id: string) => board.locator(`[data-placement-id="${id}"]`);
  await expect(board.locator('.board-node')).toHaveCount(plan.nodes.length);
  await expect(board.locator('.board-structure-stroke')).toHaveCount(preview.placements.filter(item => item.parentPlacementId).length);
  await expect(board.locator('.board-connection-stroke')).toHaveCount(0);
  for (const placement of preview.placements) {
    const root = !placement.parentPlacementId, branch = preview.placements.some(item => item.parentPlacementId === placement.id);
    const icon = node(placement.id).locator('.board-node-kind');
    await expect(icon).toHaveAttribute('title', root ? '根主题卡片' : branch ? '分支主题卡片' : '观点卡片');
    await expect(icon.locator('svg')).toHaveClass(root ? /lucide-target/ : branch ? /lucide-git-branch/ : /lucide-sticky-note/);
    if (seed.cards[placement.resourceRef.id].needsReview) await expect(node(placement.id).locator('.needs-review')).toHaveText('待核查');
  }
  // All eight new cards begin with “依据” but also contain proposals: that prefix must not turn their role icon into a fact badge.
  expect(plan.nodes.filter(item => item.card?.body.startsWith('依据：'))).toHaveLength(8);
  await expect(board.locator('.board-node-kind .lucide-quote')).toHaveCount(0);
  await mkdir(outputDirectory, { recursive: true });
  const captures: { name: string; size: { width: number; height: number }; measurements: Awaited<ReturnType<typeof measure>> }[] = [];
  async function capture(name: string, width: number, height: number) {
    await page.setViewportSize({ width, height });
    await board.locator('.board-viewport').evaluate(element => element.scrollTo(0, 0));
    await saved(page); await page.screenshot({ path: `${outputDirectory}/ai-render-${name}.png` });
    captures.push({ name, size: { width, height }, measurements: await measure(board, preview.edges) });
  }
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) await capture(`titles-${width}`, width, height);
  await board.getByRole('button', { name: `显示关联 · ${plan.edges.length}`, exact: true }).click();
  await expect(board.locator('.board-connection-stroke')).toHaveCount(plan.edges.length);
  await capture('relations-1440', 1440, 900);
  await board.getByRole('button', { name: `隐藏关联 · ${plan.edges.length}`, exact: true }).click();
  const method = preview.placements.find(item => item.resourceRef.id === 'seed-methods')!, runtime = preview.placements.find(item => item.resourceRef.id === 'seed-runtime')!;
  await node(method.id).getByRole('button', { name: /^收起分支：/ }).click();
  await node(runtime.id).getByRole('button', { name: /^收起分支：/ }).click();
  await expect(board.locator('.board-node')).toHaveCount(6);
  const evaluation = preview.placements.find(item => plan.nodes[preview.placements.indexOf(item)].card?.title === '评估与选择计划')!;
  await node(evaluation.id).click();
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) await capture(`focused-branch-${width}`, width, height);
  await saved(page); await page.reload();
  await expect(board.locator('.board-node')).toHaveCount(6);
  await expect(node(method.id).getByRole('button', { name: /^展开分支：/ })).toBeVisible();
  await expect(node(runtime.id).getByRole('button', { name: /^展开分支：/ })).toBeVisible();
  await expect(node(method.id).locator('.board-node-kind svg')).toHaveClass(/lucide-git-branch/);
  await expect(node(runtime.id).locator('.board-node-kind svg')).toHaveClass(/lucide-git-branch/);
  await expect(node(evaluation.id)).toHaveClass(/is-selected/);
  const after = await state(page);
  expect(Object.values(after.placements).filter(item => item.boardId === boardId)).toEqual(preview.placements);
  expect(Object.values(after.edges).filter(item => item.boardId === boardId)).toEqual(preview.edges);
  for (const placement of preview.placements) expect(after.cards[placement.resourceRef.id]).toEqual(seed.cards[placement.resourceRef.id]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await node(evaluation.id).getByRole('button', { name: '编辑内容：评估与选择计划', exact: true }).click();
  const originalCard = seed.cards[evaluation.resourceRef.id];
  await expect(panel(page).getByLabel('卡片正文', { exact: true })).toHaveValue(originalCard.body);
  await saved(page); await page.screenshot({ path: `${outputDirectory}/ai-render-full-content.png` });
  const report = { generatedAt: new Date().toISOString(), mode: '真实模型输出 + fixture 渲染回放；不是应用原生聊天端到端验收', source: `${sourceDirectory}/codex-probe.json`, sourceSha256: createHash('sha256').update(resultText).digest('hex'), model: result.turn.model,
    plan: { title: plan.title, layout: plan.layout, boardMode: preview.board.layout, nodes: plan.nodes.length, parentChild: preview.placements.filter(item => item.parentPlacementId).length, semanticEdges: plan.edges.length },
    checks: { rawResponseParseMatches: true, productionPreviewMatches: true, defaultStructuralOnly: true, optionalRelationsRender: true, iconsReflectRootBranchLeaf: true, factualPrefixDoesNotChangeRoleIcon: true, reviewStatusIndependentOfIcon: true, collapseAndSelectionPersist: true, cardsStructureAndEdgesUnchanged: true, fullBodyAccessible: true },
    captures, blockedRequests, pageErrors,
    limitations: ['合成材料没有对应 PDF，未检验原文跳转。', 'fixture 直接装载生产 preview，未测试真实发送、提案确认与历史生成。', '碰撞检查以 DOM 矩形和每条路径 799 个采样点近似判断；不证明任意大图均无碰撞。', '卡片全文通过右侧查看；不要求所有节点在同一屏幕同时可读。'] };
  await writeFile(`${outputDirectory}/ai-render-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  for (const capture of captures) {
    expect(capture.measurements.scale, capture.name).toBe(1);
    expect(capture.measurements.documentWidth, capture.name).toBe(capture.size.width);
    expect(capture.measurements.cardOverlaps, capture.name).toEqual([]);
    expect(capture.measurements.paths.flatMap(path => path.thirdCardIntersections), capture.name).toEqual([]);
  }
  expect(blockedRequests).toEqual([]); expect(pageErrors).toEqual([]);
});
