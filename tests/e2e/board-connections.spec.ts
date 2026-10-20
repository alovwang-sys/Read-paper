import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import { openResearchPage } from './knowledge-helpers';
import { mockProjectService } from './project-fixture';

test('分叉、纵向与反向曲线在三个视口保留方向和可编辑关系', async ({ page }) => {
  const seed = createSeed();
  seed.sessions['research-a'].panel.open = false;
  seed.sessions['research-a'].viewports['board-a'] = { x: 0, y: 0, scale: .7 };
  seed.boards['board-a'].title = '从研究问题到证据回查';
  const cards = [
    ['研究问题', '检索增强在什么条件下有效？', '先明确问题，再区分影响收益的条件。', 50, 285, '核心问题'],
    ['研究假设', '相关性决定检索收益', '信息与问题相关时，外部材料可以补充回答所需的证据。', 450, 80, '拆解与验证'],
    ['验证与边界', '用反例检验适用条件', '同时观察无关语料、噪声和证据缺失，保留人工判断。', 450, 500, '拆解与验证'],
    ['原文依据', '回到可定位的论文证据', '观点必须可以沿引用回到原文，避免结论与材料脱节。', 850, 80, '证据与回查'],
    ['反向核查', '新证据改变判断', '若反例与原判断冲突，回头修改适用范围，而非覆盖来源。', 850, 500, '证据与回查'],
  ] as const;
  Object.keys(seed.placements).filter(id => seed.placements[id].boardId === 'board-a').forEach(id => delete seed.placements[id]);
  cards.forEach(([_kind, title, body, x, y, group], index) => {
    const id = `connection-card-${index}`, placementId = `connection-placement-${index}`;
    seed.cards[id] = { ...seed.cards['card-a'], id, title, body };
    seed.researches['research-a'].cardIds.push(id);
    seed.placements[placementId] = { id: placementId, boardId: 'board-a', resourceRef: { kind: 'card', id }, x, y, group };
  });
  delete seed.edges['edge-a'];
  const relationships = [[0, 1, '拆解'], [0, 2, '验证'], [1, 3, '依据'], [4, 2, '修正范围'], [1, 2, '检验']] as const;
  relationships.forEach(([from, to, label], index) => {
    const id = `connection-edge-${index}`;
    seed.edges[id] = { id, boardId: 'board-a', fromPlacementId: `connection-placement-${from}`, toPlacementId: `connection-placement-${to}`, label };
  });
  await mockProjectService(page, { bound: false, seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, model: 'connection-visual-fixture', images: false } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.goto('/');
  await openResearchPage(page, '从研究问题到证据回查');
  const board = page.getByRole('main', { name: '主工作区' });
  await expect(board.locator('.board-connections .board-edge')).toHaveCount(5);
  await expect(board.locator('.board-connections .board-connection-stroke')).toHaveCount(5);
  for (const path of await board.locator('.board-connection-stroke').all()) {
    await expect(path).toHaveAttribute('d', / [CQ] /);
    await expect(path).toHaveAttribute('marker-end', /connection-arrow/);
  }
  const geometry = await board.evaluate(root => {
    const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-placement-id]')).map(card => ({ id: card.dataset.placementId!, x: card.offsetLeft, y: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight }));
    return Array.from(root.querySelectorAll<SVGPathElement>('.board-connection-stroke')).map(path => {
      const length = path.getTotalLength(), samples = Math.ceil(length / 2);
      const points = Array.from({ length: samples + 1 }, (_, i) => path.getPointAtLength(length * i / samples));
      return { id: path.closest('[data-edge-id]')!.getAttribute('data-edge-id'), start: { x: points[0].x, y: points[0].y }, end: { x: points.at(-1)!.x, y: points.at(-1)!.y },
        intersections: cards.filter(card => points.some(point => point.x > card.x + .1 && point.x < card.x + card.width - .1 && point.y > card.y + .1 && point.y < card.y + card.height - .1)).map(card => card.id), cards };
    });
  });
  for (const edge of geometry) {
    expect(edge.intersections, `关系 ${edge.id} 不应穿过卡片`).toEqual([]);
    const expected = seed.edges[edge.id!];
    for (const [point, id] of [[edge.start, expected.fromPlacementId], [edge.end, expected.toPlacementId]] as const) {
      const card = edge.cards.find(item => item.id === id)!;
      const gap = Math.max(card.x - point.x, point.x - card.x - card.width, card.y - point.y, point.y - card.y - card.height, 0);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(6.1);
    }
  }
  const reversed = board.getByRole('button', { name: '编辑关系：修正范围', exact: true });
  await reversed.locator('text').click();
  await expect(board.getByLabel('连线说明', { exact: true })).toHaveValue('修正范围');
  await board.getByRole('button', { name: '编辑关系：检验', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(board.getByLabel('连线说明', { exact: true })).toHaveValue('检验');
  await board.locator('.board-viewport').click({ position: { x: 1050, y: 110 } });
  await mkdir('docs/verification/human-board-control', { recursive: true });
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(board.locator('[data-placement-id="connection-placement-4"]')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    await page.screenshot({ path: `docs/verification/human-board-control/board-connections-${width}.png` });
  }
});
