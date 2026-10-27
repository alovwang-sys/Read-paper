import type { RegionRect } from './region';
import { captureTextAnchor, normalizedPageText } from './text-anchor';

export type PageBox = { pageIndex: number; left: number; top: number; width: number; height: number };
export type SelectionPoint = { x: number; y: number };

/** Intersect the drag with each actual page, so page gaps never enter a crop. */
export function pageRegionFragments(start: SelectionPoint, end: SelectionPoint, pages: PageBox[]) {
  const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y), bottom = Math.max(start.y, end.y);
  return pages.flatMap(page => {
    const x = Math.max(left, page.left), y = Math.max(top, page.top);
    const width = Math.min(right, page.left + page.width) - x;
    const height = Math.min(bottom, page.top + page.height) - y;
    if (width < 1 || height < 1) return [];
    const rect: RegionRect = { x: (x - page.left) / page.width, y: (y - page.top) / page.height, width: width / page.width, height: height / page.height };
    return [{ pageIndex: page.pageIndex, rect }];
  }).sort((a, b) => a.pageIndex - b.pageIndex);
}

export function selectionScrollStep(y: number, top: number, bottom: number) {
  const edge = Math.min(44, (bottom - top) / 3);
  if (y < top + edge) return -Math.min(20, Math.max(0, (top + edge - y) / 2));
  if (y > bottom - edge) return Math.min(20, Math.max(0, (y - bottom + edge) / 2));
  return 0;
}

export function pageTextFragments(range: Range, pages: Array<{ pageIndex: number; layer: HTMLElement }>) {
  return pages.flatMap(({ pageIndex, layer }) => {
    if (!range.intersectsNode(layer)) return [];
    const fragment = document.createRange();
    fragment.selectNodeContents(layer);
    if (range.compareBoundaryPoints(Range.START_TO_START, fragment) > 0) fragment.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, fragment) < 0) fragment.setEnd(range.endContainer, range.endOffset);
    const textAnchor = captureTextAnchor(layer, fragment);
    const text = normalizedPageText([...layer.querySelectorAll('span')].filter(span => !span.querySelector('span')).map(span => span.textContent ?? ''));
    const quote = textAnchor ? text.slice(textAnchor.start, textAnchor.end) : fragment.toString().replace(/\s+/g, ' ').trim();
    return quote ? [{ pageIndex, quote, textAnchor, range: fragment }] : [];
  }).sort((a, b) => a.pageIndex - b.pageIndex);
}
