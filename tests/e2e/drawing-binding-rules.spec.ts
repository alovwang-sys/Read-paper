import { expect, test } from '@playwright/test';

test('内部吸附遵守实际形状、锁定和本次手势，保留已有连接与几何', async ({ page }) => {
  await page.routeWebSocket('**', () => {});
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/features/board/drawing-bindings.ts';
    const { bindDroppedArrowEndpoints } = await import(path);
    const base = { angle: 0, strokeColor: '#000', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, index: 'a1', roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
    const shape = (type: string, extra = {}) => ({ ...base, id: 'shape', type, x: 200, y: 200, width: 100, height: 80, ...extra });
    const arrow = (x = 250, y = 240, extra = {}) => ({ ...base, id: 'arrow', type: 'arrow', x: 0, y: 0, width: x, height: y, points: [[0, 0], [x, y]], lastCommittedPoint: null, startBinding: { elementId: 'existing-card', focus: 0, gap: 2 }, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', elbowed: false, ...extra });
    const check = (target: unknown, item: unknown, before = new Map()) => {
      const input = [target, item], original = JSON.stringify(input);
      const next = bindDroppedArrowEndpoints(input, before);
      return { next, inputUntouched: original === JSON.stringify(input) };
    };
    const centers = ['rectangle', 'ellipse', 'diamond'].map(type => {
      const original = arrow(), output = check(shape(type), original);
      return { type, end: output.next[1].endBinding?.elementId, start: output.next[1].startBinding?.elementId, points: output.next[1].points, originalPoints: original.points, reverse: output.next[0].boundElements?.[0]?.id, inputUntouched: output.inputUntouched };
    });
    const skipped = [
      check(shape('ellipse'), arrow(202, 202)),
      check(shape('diamond'), arrow(202, 202)),
      check(shape('rectangle', { locked: true }), arrow()),
      check(shape('rectangle'), arrow(250, 240, { locked: true })),
      check(shape('rectangle'), arrow(250, 240, { customData: { boardRelation: true } })),
      check(shape('rectangle'), arrow(250, 240, { startBinding: { elementId: 'shape', focus: 0, gap: 2 } })),
      check(shape('rectangle'), arrow(), new Map([['arrow', arrow()]])),
    ].map(output => output.next[1].endBinding);
    const rotated = check(shape('rectangle', { angle: Math.PI / 4 }), arrow(303, 240));
    return { centers, skipped, rotatedEnd: rotated.next[1].endBinding?.elementId };
  });
  for (const item of result.centers) {
    expect(item.end).toBe('shape'); expect(item.start).toBe('existing-card'); expect(item.reverse).toBe('arrow');
    expect(item.points).toEqual(item.originalPoints); expect(item.inputUntouched).toBe(true);
  }
  expect(result.skipped).toEqual(Array(7).fill(null));
  expect(result.rotatedEnd).toBe('shape');
});

test('共享摆放平移保留端点、手调中间点与连接，双方同移时整条平移', async ({ page }) => {
  await page.routeWebSocket('**', () => {});
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/features/board/drawing-bindings.ts';
    const { moveBoundArrowEndpoints } = await import(path);
    const base = { angle: 0, version: 1, versionNonce: 1, isDeleted: false, updated: 1, locked: false };
    const a = { ...base, id: 'a', type: 'embeddable', x: 10, y: 10, width: 100, height: 80 }, b = { ...a, id: 'b', x: 300 };
    const wire = { ...base, id: 'wire', type: 'arrow', x: 110, y: 50, width: 190, height: 50, points: [[0, 0], [100, 50], [190, 0]], startBinding: { elementId: 'a', focus: 0, gap: 2 }, endBinding: { elementId: 'b', focus: 0, gap: 2 }, elbowed: false };
    const before = [a, b, wire], original = JSON.stringify(before);
    const moved = moveBoundArrowEndpoints(before, [{ ...a, x: a.x + 40, y: a.y + 30 }, b, wire])[2];
    const together = moveBoundArrowEndpoints(before, [{ ...a, x: a.x + 40, y: a.y + 30 }, { ...b, x: b.x + 40, y: b.y + 30 }, wire])[2];
    const nativeWire = { ...wire, x: 150, y: 80, width: 150, height: 50, points: [[0, 0], [60, 20], [150, -30]] };
    const alreadyMoved = [{ ...a, x: a.x + 40, y: a.y + 30 }, b, nativeWire];
    const nativePreserved = moveBoundArrowEndpoints(before, alreadyMoved) === alreadyMoved;
    const rotatedWire = { ...wire, points: [[0, 0], [190, 0]], height: 0, angle: Math.PI / 2, roundness: null, roughness: 0, strokeWidth: 1, seed: 1 };
    const rotated = moveBoundArrowEndpoints([a, b, rotatedWire], [{ ...a, x: a.x + 40, y: a.y + 30 }, b, rotatedWire])[2];
    const global = (item: typeof wire) => item.points.map(point => [item.x + point[0], item.y + point[1]]);
    return { originalUntouched: original === JSON.stringify(before), moved: global(moved), together: global(together), points: together.points, start: moved.startBinding, end: moved.endBinding, nativePreserved, rotated: global(rotated) };
  });
  expect(result.originalUntouched).toBe(true);
  expect(result.nativePreserved).toBe(true);
  expect(result.moved).toEqual([[150, 80], [210, 100], [300, 50]]);
  expect(result.together).toEqual([[150, 80], [250, 130], [340, 80]]);
  expect(result.points).toEqual([[0, 0], [100, 50], [190, 0]]);
  expect(result.start?.elementId).toBe('a'); expect(result.end?.elementId).toBe('b');
  for (const [index, expected] of [[245, -15], [205, 145]].entries()) {
    expect(result.rotated[index][0]).toBeCloseTo(expected[0]); expect(result.rotated[index][1]).toBeCloseTo(expected[1]);
  }
});
