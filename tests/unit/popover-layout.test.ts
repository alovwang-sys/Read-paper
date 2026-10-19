import { describe, expect, it } from 'vitest';
import { constrainPopover } from '../../src/features/reader/popover-layout';

describe('原文旁问答窗口范围', () => {
  it('拖动不会越出视口，也不会改变已有大小', () => {
    expect(constrainPopover({ left: -200, top: 1000, width: 430, height: 300 }, { width: 1280, height: 800 })).toEqual({ left: 8, top: 492, width: 430, height: 300 });
  });
  it('调整大小保留可用的最小尺寸', () => {
    expect(constrainPopover({ left: 100, top: 100, width: 80, height: 50 }, { width: 1024, height: 800 }, { width: 320, height: 280 })).toEqual({ left: 100, top: 100, width: 320, height: 280 });
  });
  it('窗口缩小时让整个浮窗回到视口内', () => {
    expect(constrainPopover({ left: 1000, top: 700, width: 900, height: 700 }, { width: 720, height: 500 })).toEqual({ left: 8, top: 8, width: 704, height: 484 });
  });
  it('极窄窗口优先满足视口约束', () => {
    expect(constrainPopover({ left: 20, top: 20, width: 100, height: 100 }, { width: 250, height: 220 }, { width: 320, height: 280 })).toEqual({ left: 8, top: 8, width: 234, height: 204 });
  });
});
