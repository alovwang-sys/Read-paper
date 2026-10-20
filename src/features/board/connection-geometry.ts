export type ConnectionBox = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

function labelSpace(point: Point, boxes: ConnectionBox[]) {
  return boxes.reduce((available, box) => {
    if (point.y + 13 <= box.y || point.y - 13 >= box.y + box.height) return available;
    if (box.x + box.width <= point.x) return Math.min(available, 2 * (point.x - box.x - box.width - 6));
    if (box.x >= point.x) return Math.min(available, 2 * (box.x - point.x - 6));
    return 0;
  }, 180);
}

function curveHitsBox(points: Point[], box: ConnectionBox, depth = 0): boolean {
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  if (Math.max(...xs) <= box.x || Math.min(...xs) >= box.x + box.width || Math.max(...ys) <= box.y || Math.min(...ys) >= box.y + box.height) return false;
  if (depth === 12) return true;
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const [a, b, c, d] = points, ab = mid(a, b), bc = mid(b, c), cd = mid(c, d), abc = mid(ab, bc), bcd = mid(bc, cd), center = mid(abc, bcd);
  return curveHitsBox([a, ab, abc, center], box, depth + 1) || curveHitsBox([center, bcd, cd, d], box, depth + 1);
}

const expand = (box: ConnectionBox, gap: number) => ({ x: box.x - gap, y: box.y - gap, width: box.width + gap * 2, height: box.height + gap * 2 });
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function obstacleRoute(start: Point, end: Point, boxes: ConnectionBox[]): Point[] | undefined {
  const xs = [...new Set([start.x, end.x, ...boxes.flatMap(box => [box.x, box.x + box.width])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...boxes.flatMap(box => [box.y, box.y + box.height])])].sort((a, b) => a - b);
  xs.unshift(xs[0] - 24); xs.push(xs[xs.length - 1] + 24);
  ys.unshift(ys[0] - 24); ys.push(ys[ys.length - 1] + 24);
  const width = xs.length, height = ys.length, stride = width + 1;
  const xIndex = new Map(xs.map((value, i) => [value, i])), yIndex = new Map(ys.map((value, i) => [value, i]));
  // Difference grids make each neighbour check constant time, even with 80 cards and 160 links.
  const horizontal = new Int16Array(stride * (height + 1)), vertical = new Int16Array(horizontal.length);
  function mark(grid: Int16Array, left: number, top: number, right: number, bottom: number) {
    if (left > right || top > bottom) return;
    grid[top * stride + left]++; grid[top * stride + right + 1]--;
    grid[(bottom + 1) * stride + left]--; grid[(bottom + 1) * stride + right + 1]++;
  }
  for (const box of boxes) {
    const left = xIndex.get(box.x)!, right = xIndex.get(box.x + box.width)!, top = yIndex.get(box.y)!, bottom = yIndex.get(box.y + box.height)!;
    mark(horizontal, left, top + 1, right - 1, bottom - 1);
    mark(vertical, left + 1, top, right - 1, bottom - 1);
  }
  for (const grid of [horizontal, vertical]) for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const i = row * stride + col;
    grid[i] += (col ? grid[i - 1] : 0) + (row ? grid[i - stride] : 0) - (col && row ? grid[i - stride - 1] : 0);
  }
  const first = yIndex.get(start.y)! * width + xIndex.get(start.x)!, last = yIndex.get(end.y)! * width + xIndex.get(end.x)!;
  const costs = new Float64Array(width * height).fill(Infinity), previous = new Int32Array(costs.length).fill(-1);
  type Entry = { id: number; cost: number; rank: number };
  const queue: Entry[] = [];
  function push(entry: Entry) {
    let i = queue.length;
    queue.push(entry);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (queue[parent].rank <= entry.rank) break;
      queue[i] = queue[parent]; i = parent;
    }
    queue[i] = entry;
  }
  function pop(): Entry {
    const entry = queue[0], tail = queue.pop()!;
    if (queue.length) {
      let i = 0;
      while (i * 2 + 1 < queue.length) {
        let child = i * 2 + 1;
        if (child + 1 < queue.length && queue[child + 1].rank < queue[child].rank) child++;
        if (queue[child].rank >= tail.rank) break;
        queue[i] = queue[child]; i = child;
      }
      queue[i] = tail;
    }
    return entry;
  }
  costs[first] = 0; push({ id: first, cost: 0, rank: distance(start, end) });
  while (queue.length) {
    const current = pop();
    if (current.cost !== costs[current.id]) continue;
    if (current.id === last) {
      const route: Point[] = [];
      for (let id = last; id >= 0; id = previous[id]) route.push({ x: xs[id % width], y: ys[Math.floor(id / width)] });
      const compressed: Point[] = [];
      for (const point of route.reverse()) {
        const a = compressed.at(-2), b = compressed.at(-1);
        if (a && b && ((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y))) compressed[compressed.length - 1] = point;
        else compressed.push(point);
      }
      return compressed;
    }
    const col = current.id % width, row = Math.floor(current.id / width), gridId = row * stride + col;
    const neighbours = [
      col > 0 && !horizontal[gridId - 1] ? current.id - 1 : -1,
      col + 1 < width && !horizontal[gridId] ? current.id + 1 : -1,
      row > 0 && !vertical[gridId - stride] ? current.id - width : -1,
      row + 1 < height && !vertical[gridId] ? current.id + width : -1,
    ];
    for (const id of neighbours) {
      if (id < 0) continue;
      const point = { x: xs[id % width], y: ys[Math.floor(id / width)] };
      const cost = current.cost + Math.abs(point.x - xs[col]) + Math.abs(point.y - ys[row]);
      if (cost >= costs[id]) continue;
      costs[id] = cost; previous[id] = current.id;
      push({ id, cost, rank: cost + distance(point, end) });
    }
  }
}

function roundedRoute(points: Point[], radius: number) {
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const incoming = distance(a, b), outgoing = distance(b, c), bend = Math.min(radius, incoming / 2, outgoing / 2);
    const before = { x: b.x + (a.x - b.x) * bend / incoming, y: b.y + (a.y - b.y) * bend / incoming };
    const after = { x: b.x + (c.x - b.x) * bend / outgoing, y: b.y + (c.y - b.y) * bend / outgoing };
    path += ` L ${before.x} ${before.y} Q ${b.x} ${b.y}, ${after.x} ${after.y}`;
  }
  return `${path} L ${points.at(-1)!.x} ${points.at(-1)!.y}`;
}

export function boardConnection(from: ConnectionBox, to: ConnectionBox, obstacles: ConnectionBox[] = []) {
  const dx = to.x + to.width / 2 - from.x - from.width / 2;
  const dy = to.y + to.height / 2 - from.y - from.height / 2;
  const gapX = Math.abs(dx) - (from.width + to.width) / 2;
  const gapY = Math.abs(dy) - (from.height + to.height) / 2;
  let start: Point, end: Point, control1: Point, control2: Point;
  if (gapX > 0 && (gapY <= 0 || gapX >= gapY)) {
    const direction = Math.sign(dx), padding = Math.min(6, gapX / 5);
    start = { x: from.x + (direction > 0 ? from.width : 0) + direction * padding, y: from.y + from.height / 2 };
    end = { x: to.x + (direction > 0 ? 0 : to.width) - direction * padding, y: to.y + to.height / 2 };
    const bend = Math.min(180, Math.abs(end.x - start.x) / 2);
    control1 = { x: start.x + direction * bend, y: start.y };
    control2 = { x: end.x - direction * bend, y: end.y };
  } else if (gapY > 0) {
    const direction = Math.sign(dy), padding = Math.min(6, gapY / 5);
    start = { x: from.x + from.width / 2, y: from.y + (direction > 0 ? from.height : 0) + direction * padding };
    end = { x: to.x + to.width / 2, y: to.y + (direction > 0 ? 0 : to.height) - direction * padding };
    const bend = Math.min(180, Math.abs(end.y - start.y) / 2);
    control1 = { x: start.x, y: start.y + direction * bend };
    control2 = { x: end.x, y: end.y - direction * bend };
  } else {
    const outside = Math.max(from.x + from.width, to.x + to.width) + 64;
    start = { x: from.x + from.width + 4, y: from.y + from.height * .35 };
    end = { x: to.x + to.width + 4, y: to.y + to.height * .65 };
    control1 = { x: outside, y: start.y - 24 };
    control2 = { x: outside, y: end.y + 24 };
  }
  let label = {
    x: (start.x + 3 * control1.x + 3 * control2.x + end.x) / 8,
    y: (start.y + 3 * control1.y + 3 * control2.y + end.y) / 8,
  };
  let path = `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`;
  const boxes = [from, to, ...obstacles];
  if (obstacles.some(box => curveHitsBox([start, control1, control2, end], expand(box, 4)))) {
    const portGap = (point: Point, box: ConnectionBox) => Math.max(box.x - point.x, point.x - box.x - box.width, box.y - point.y, point.y - box.y - box.height, 0);
    const margin = Math.min(4, portGap(start, from) / 2, portGap(end, to) / 2);
    const margins = obstacles.map(box => Math.min(12, portGap(start, box) / 2, portGap(end, box) / 2));
    const route = obstacleRoute(start, end, [expand(from, margin), expand(to, margin), ...obstacles.map((box, i) => expand(box, margins[i]))]);
    if (route) {
      path = roundedRoute(route, Math.min(margin, ...margins) * 2);
      const midpoints = route.slice(1).map((point, i) => ({ x: (point.x + route[i].x) / 2, y: (point.y + route[i].y) / 2 }));
      midpoints.sort((a, b) => labelSpace(b, boxes) - labelSpace(a, boxes) || distance(a, label) - distance(b, label));
      label = midpoints[0] ?? label;
    }
  }
  const labelMaxWidth = Math.max(0, labelSpace(label, boxes));
  return {
    start, end, control1, control2, label, labelMaxWidth,
    path,
  };
}
