import { describe, expect, it, vi } from 'vitest';
import { cropGeometry, cropRegion, regionFromPoints, rotateRegion, validRegion } from '../../src/features/reader/region';

describe('PDF 区域坐标与裁图', () => {
  it('反向拖动与拖出页边界仍得到页内规范坐标', () => {
    expect(regionFromPoints({ x: 1.2, y: 0.8 }, { x: -0.2, y: 0.2 })).toEqual({ x: 0, y: 0.2, width: 1, height: 0.6000000000000001 });
    expect(validRegion({ x: 0, y: 0, width: 0, height: 0.5 })).toBe(false);
    expect(validRegion({ x: 0, y: NaN, width: 1, height: 1 })).toBe(false);
    expect(() => cropGeometry({ x: 0.8, y: 0, width: 0.4, height: 1 }, 100, 100)).toThrow();
  });

  it('缩放和高 DPI 仅改变像素，不改变归一化锚点', () => {
    const rect = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };
    expect(cropGeometry(rect, 600, 800)).toEqual({ x: 150, y: 400, sourceWidth: 300, sourceHeight: 200, width: 300, height: 200 });
    expect(cropGeometry(rect, 1200, 1600)).toEqual({ x: 300, y: 800, sourceWidth: 600, sourceHeight: 400, width: 600, height: 400 });
    expect(cropGeometry({ x: 0, y: 0, width: 1, height: 1 }, 4000, 6000)).toMatchObject({ width: 1365, height: 2048 });
    const edge = cropGeometry({ x: 0.999, y: 0.999, width: 0.001, height: 0.001 }, 601, 801);
    expect(edge.x + edge.sourceWidth).toBe(601);
    expect(edge.y + edge.sourceHeight).toBe(801);
  });

  it('旋转映射能在 90、180、270 度后回到原区域', () => {
    const original = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    const rotated = rotateRegion(original, 90);
    expect(rotated.x).toBeCloseTo(0.4);
    expect(rotated.y).toBeCloseTo(0.1);
    expect(rotated.width).toBe(0.4);
    const restored = rotateRegion(rotated, -90);
    Object.entries(original).forEach(([key, value]) => expect(restored[key as keyof typeof restored]).toBeCloseTo(value));
    for (const rotation of [180, 270]) {
      const restored = rotateRegion(rotateRegion(original, rotation), -rotation);
      Object.entries(original).forEach(([key, value]) => expect(restored[key as keyof typeof restored]).toBeCloseTo(value));
    }
    expect(() => rotateRegion(original, 45)).toThrow();
  });

  it('裁图仅使用 PDF canvas 的对应像素，输出可保存的实际图片', async () => {
    const drawImage = vi.fn();
    const blob = new Blob(['region'], { type: 'image/png' });
    const output = { width: 0, height: 0, getContext: () => ({ fillRect: vi.fn(), drawImage }), toBlob: (done: BlobCallback) => done(blob) };
    const source = { width: 1200, height: 1600 } as HTMLCanvasElement;
    const result = await cropRegion(source, { x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, () => output as unknown as HTMLCanvasElement);
    expect(drawImage).toHaveBeenCalledWith(source, 300, 800, 600, 400, 0, 0, 600, 400);
    expect(result).toEqual({ blob, width: 600, height: 400 });
  });

  it('编码失败明确报错且不返回伪图片', async () => {
    const output = { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (done: BlobCallback) => done(null) };
    await expect(cropRegion({ width: 10, height: 20 } as HTMLCanvasElement, { x: 0, y: 0, width: 1, height: 1 }, () => output as unknown as HTMLCanvasElement)).rejects.toThrow('区域截图失败');
  });

  it('PNG 超限时使用 JPEG，并阻止仍超 4 MB 的图片', async () => {
    const large = new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: 'image/png' });
    const small = new Blob(['jpeg'], { type: 'image/jpeg' });
    const encode = vi.fn((done: BlobCallback, type: string) => done(type === 'image/png' ? large : small));
    const output = { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: encode };
    const rect = { x: 0, y: 0, width: 1, height: 1 };
    const createCanvas = () => output as unknown as HTMLCanvasElement;
    expect((await cropRegion({ width: 10, height: 20 } as HTMLCanvasElement, rect, createCanvas)).blob.type).toBe('image/jpeg');
    expect(encode).toHaveBeenLastCalledWith(expect.any(Function), 'image/jpeg', 0.9);
    encode.mockImplementation((done) => done(large));
    await expect(cropRegion({ width: 10, height: 20 } as HTMLCanvasElement, rect, createCanvas)).rejects.toThrow('超过 4 MB');
  });
});
