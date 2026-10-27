import { describe, expect, it } from 'vitest';
import { pageRegionFragments, selectionScrollStep } from '../../src/features/reader/cross-page-selection';

describe('跨页选区', () => {
  const pages = [{ pageIndex: 0, left: 20, top: 0, width: 600, height: 800 }, { pageIndex: 1, left: 70, top: 824, width: 500, height: 700 }];
  it('正反拖选得到同一组页内片段，不包含24px页间空隙', () => {
    const start = { x: 50, y: 700 }, end = { x: 400, y: 924 };
    const result = pageRegionFragments(start, end, pages);
    expect(result).toEqual(pageRegionFragments(end, start, pages));
    expect(result[0]).toEqual({ pageIndex: 0, rect: { x: .05, y: .875, width: 350 / 600, height: .125 } });
    expect(result[1]).toEqual({ pageIndex: 1, rect: { x: 0, y: 0, width: .66, height: 100 / 700 } });
    expect(result.reduce((sum, item) => sum + item.rect.height * pages[item.pageIndex].height, 0)).toBe(200);
  });
  it('只框住空隙不产生图片，拖出页面则裁剪到实际页边界', () => {
    expect(pageRegionFragments({ x: 0, y: 801 }, { x: 900, y: 823 }, pages)).toEqual([]);
    expect(pageRegionFragments({ x: -100, y: -100 }, { x: 900, y: 1600 }, pages).map(item => item.rect)).toEqual([
      { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 },
    ]);
  });
  it('仅在阅读区边缘滚动，正反方向与最大速度一致', () => {
    expect(selectionScrollStep(300, 100, 600)).toBe(0);
    expect(selectionScrollStep(110, 100, 600)).toBe(-17);
    expect(selectionScrollStep(590, 100, 600)).toBe(17);
    expect(selectionScrollStep(-100, 100, 600)).toBe(-20);
    expect(selectionScrollStep(1000, 100, 600)).toBe(20);
  });
});
