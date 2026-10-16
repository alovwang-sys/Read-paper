export type RegionRect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
export const REGION_MAX_SIDE = 2048;
export const REGION_MAX_BYTES = 4 * 1024 * 1024;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

export function regionFromPoints(start: Point, end: Point): RegionRect {
  const left = clamp(Math.min(start.x, end.x));
  const top = clamp(Math.min(start.y, end.y));
  return {
    x: left,
    y: top,
    width: clamp(Math.max(start.x, end.x)) - left,
    height: clamp(Math.max(start.y, end.y)) - top,
  };
}

export function validRegion(rect: RegionRect) {
  return Object.values(rect).every(Number.isFinite) &&
    rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 &&
    rect.x + rect.width <= 1 + Number.EPSILON &&
    rect.y + rect.height <= 1 + Number.EPSILON;
}

export function rotateRegion(rect: RegionRect, clockwise: number): RegionRect {
  const turns = ((clockwise % 360) + 360) % 360 / 90;
  if (!Number.isInteger(turns)) throw new Error('页面旋转角度无效');
  for (let index = 0; index < turns; index++) {
    rect = {
      x: 1 - rect.y - rect.height,
      y: rect.x,
      width: rect.height,
      height: rect.width,
    };
  }
  return rect;
}

export function cropGeometry(rect: RegionRect, width: number, height: number) {
  if (!validRegion(rect) || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1)
    throw new Error('请在当前 PDF 页内选择有效区域');
  const x = Math.floor(rect.x * width);
  const y = Math.floor(rect.y * height);
  const sourceWidth = Math.min(width, Math.ceil((rect.x + rect.width) * width)) - x;
  const sourceHeight = Math.min(height, Math.ceil((rect.y + rect.height) * height)) - y;
  const ratio = Math.min(1, REGION_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
  return { x, y, sourceWidth, sourceHeight, width: Math.max(1, Math.round(sourceWidth * ratio)), height: Math.max(1, Math.round(sourceHeight * ratio)) };
}

export async function cropRegion(
  source: HTMLCanvasElement,
  rect: RegionRect,
  createCanvas = () => document.createElement('canvas'),
) {
  const geometry = cropGeometry(rect, source.width, source.height);
  const output = createCanvas();
  output.width = geometry.width;
  output.height = geometry.height;
  const context = output.getContext('2d');
  if (!context) throw new Error('浏览器暂时无法截取区域，请重试');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(source, geometry.x, geometry.y, geometry.sourceWidth, geometry.sourceHeight, 0, 0, output.width, output.height);
  const encode = (type: string, quality?: number) => new Promise<Blob>((resolve, reject) => {
    output.toBlob((blob) => blob ? resolve(blob) : reject(new Error('区域截图失败，请重新选择')), type, quality);
  });
  let blob = await encode('image/png');
  if (blob.size > REGION_MAX_BYTES) blob = await encode('image/jpeg', 0.9);
  if (blob.size > REGION_MAX_BYTES) throw new Error('区域图片超过 4 MB，请缩小区域后重试');
  return { blob, width: output.width, height: output.height };
}
