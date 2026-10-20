import { describe, expect, it } from 'vitest';
import { boardConnection, type ConnectionBox } from '../../src/features/board/connection-geometry';

const first: ConnectionBox = { x: 50, y: 80, width: 260, height: 215 };
function inside(point: { x: number; y: number }, box: ConnectionBox) {
  return point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height;
}

function samplePath(path: string) {
  const tokens = path.match(/[MLCQ]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!;
  let cursor = 0, current = { x: 0, y: 0 };
  const points: typeof current[] = [];
  const read = () => ({ x: Number(tokens[cursor++]), y: Number(tokens[cursor++]) });
  while (cursor < tokens.length) {
    const command = tokens[cursor++], start = current;
    if (command === 'M') { current = read(); points.push(current); continue; }
    const controls = command === 'C' ? [read(), read()] : command === 'Q' ? [read()] : [];
    const end = read();
    const span = [start, ...controls, end];
    const steps = Math.max(1, Math.ceil(span.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - span[i].x, point.y - span[i].y), 0) / 2));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps, u = 1 - t;
      if (command === 'C') points.push({ x: u ** 3 * start.x + 3 * u ** 2 * t * controls[0].x + 3 * u * t ** 2 * controls[1].x + t ** 3 * end.x, y: u ** 3 * start.y + 3 * u ** 2 * t * controls[0].y + 3 * u * t ** 2 * controls[1].y + t ** 3 * end.y });
      else if (command === 'Q') points.push({ x: u ** 2 * start.x + 2 * u * t * controls[0].x + t ** 2 * end.x, y: u ** 2 * start.y + 2 * u * t * controls[0].y + t ** 2 * end.y });
      else points.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
    }
    current = end;
  }
  return points;
}

describe('board connection geometry', () => {
  it.each([
    { name: 'right', target: { x: 430, y: 190, width: 260, height: 310 } },
    { name: 'left', target: { x: -380, y: 190, width: 260, height: 310 } },
    { name: 'below', target: { x: 80, y: 410, width: 260, height: 310 } },
    { name: 'above', target: { x: 80, y: -360, width: 260, height: 310 } },
    { name: 'diagonal', target: { x: 460, y: 500, width: 260, height: 310 } },
    { name: 'narrow gap', target: { x: 311, y: 180, width: 260, height: 310 } },
  ])('keeps the $name curve and label outside its source and target', ({ target }) => {
    const geometry = boardConnection(first, target);
    expect(geometry.path).toContain(' C ');
    for (let step = 0; step <= 100; step++) {
      const t = step / 100, u = 1 - t;
      const point = {
        x: u ** 3 * geometry.start.x + 3 * u ** 2 * t * geometry.control1.x + 3 * u * t ** 2 * geometry.control2.x + t ** 3 * geometry.end.x,
        y: u ** 3 * geometry.start.y + 3 * u ** 2 * t * geometry.control1.y + 3 * u * t ** 2 * geometry.control2.y + t ** 3 * geometry.end.y,
      };
      expect(inside(point, first)).toBe(false);
      expect(inside(point, target)).toBe(false);
    }
    expect(inside(geometry.label, first)).toBe(false);
    expect(inside(geometry.label, target)).toBe(false);
  });

  it('uses measured card dimensions and reverses the arrow without moving the label', () => {
    const tall = { ...first, height: 380 }, below = { x: 100, y: 550, width: 320, height: 260 };
    const forward = boardConnection(tall, below), reverse = boardConnection(below, tall);
    expect(forward.start.y).toBeGreaterThan(tall.y + tall.height);
    expect(forward.end.y).toBeLessThan(below.y);
    expect(forward.end.x).toBe(below.x + below.width / 2);
    expect(reverse.start).toEqual(forward.end);
    expect(reverse.end).toEqual(forward.start);
    expect(reverse.label).toEqual(forward.label);
    expect(forward.end.y - forward.control2.y).toBeGreaterThan(0);
    expect(reverse.end.y - reverse.control2.y).toBeLessThan(0);
  });

  it('limits label width in a narrow horizontal corridor instead of covering cards', () => {
    const sameRow = { x: 380, y: first.y, width: 260, height: first.height };
    const geometry = boardConnection(first, sameRow);
    expect(geometry.labelMaxWidth).toBe(58);
    expect(geometry.label.x - geometry.labelMaxWidth / 2).toBeGreaterThan(first.x + first.width);
    expect(geometry.label.x + geometry.labelMaxWidth / 2).toBeLessThan(sameRow.x);
  });

  it.each([first, { ...first, x: 110, y: 130 }])('keeps an outer loop finite for coincident or overlapping cards', target => {
    const geometry = boardConnection(first, target);
    expect(geometry.path).not.toMatch(/NaN|Infinity/);
    expect(geometry.control1.x).toBeGreaterThan(Math.max(first.x + first.width, target.x + target.width));
    expect(geometry.start).not.toEqual(geometry.end);
    expect(geometry.label.x).toBeGreaterThan(Math.max(first.x + first.width, target.x + target.width));
  });

  it.each([
    { name: 'horizontal', from: { x: 0, y: 100, width: 260, height: 100 }, to: { x: 680, y: 100, width: 260, height: 100 }, obstacles: [{ x: 340, y: 100, width: 260, height: 100 }] },
    { name: 'vertical', from: { x: 100, y: 0, width: 260, height: 100 }, to: { x: 100, y: 500, width: 260, height: 100 }, obstacles: [{ x: 100, y: 250, width: 260, height: 160 }] },
    { name: 'narrow ports', from: { x: 0, y: 100, width: 260, height: 100 }, to: { x: 540, y: 100, width: 260, height: 100 }, obstacles: [{ x: 270, y: 100, width: 260, height: 100 }] },
    { name: 'multi-card wall', from: { x: 0, y: 200, width: 260, height: 100 }, to: { x: 1000, y: 200, width: 260, height: 160 }, obstacles: [{ x: 340, y: 0, width: 260, height: 160 }, { x: 340, y: 180, width: 260, height: 160 }, { x: 340, y: 360, width: 260, height: 160 }, { x: 680, y: 200, width: 260, height: 160 }] },
  ])('routes around third cards in $name, in both directions', ({ from, to, obstacles }) => {
    for (const [source, target] of [[from, to], [to, from]]) {
      const geometry = boardConnection(source, target, obstacles);
      expect(geometry.path).toContain(' Q ');
      const points = samplePath(geometry.path);
      expect(points[0]).toEqual(geometry.start);
      expect(points.at(-1)).toEqual(geometry.end);
      for (const box of [source, target, ...obstacles]) {
        expect(points.some(point => inside(point, box))).toBe(false);
        const labelBox = { x: geometry.label.x - geometry.labelMaxWidth / 2, y: geometry.label.y - 13, width: geometry.labelMaxWidth, height: 26 };
        expect(labelBox.width === 0 || labelBox.x >= box.x + box.width || labelBox.x + labelBox.width <= box.x || labelBox.y >= box.y + box.height || labelBox.y + labelBox.height <= box.y).toBe(true);
      }
    }
  });

  it('keeps the original curve when unrelated cards do not obstruct it', () => {
    const target = { x: 480, y: 120, width: 260, height: 100 };
    expect(boardConnection(first, target, [{ x: 200, y: 600, width: 260, height: 160 }])).toEqual(boardConnection(first, target));
  });

  it('routes a finite 80-card / 160-relation board', () => {
    const boxes = Array.from({ length: 80 }, (_, i) => ({ x: i % 10 * 340, y: Math.floor(i / 10) * 128, width: 260, height: 100 }));
    for (let i = 0; i < 160; i++) {
      const from = i % 80, to = (i * 17 + 33) % 80;
      const geometry = boardConnection(boxes[from], boxes[to], boxes.filter((_, j) => j !== from && j !== to));
      expect(geometry.path).not.toMatch(/NaN|Infinity/);
      expect(geometry.labelMaxWidth).toBeGreaterThanOrEqual(0);
      const points = samplePath(geometry.path);
      expect(boxes.some(box => points.some(point => inside(point, box)))).toBe(false);
    }
  });
});
