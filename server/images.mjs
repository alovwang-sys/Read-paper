import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const IMAGE_LIMITS = Object.freeze({ maxImages: 4, maxImageBytes: 8 * 1024 * 1024 });
export const MAX_IMAGE_BODY_BYTES = IMAGE_LIMITS.maxImages * (Math.ceil(IMAGE_LIMITS.maxImageBytes / 3) * 4 + 256);
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const invalid = message => failure(400, 'invalid_request', message);
const extensions = { png: 'png', jpeg: 'jpg', webp: 'webp' };

export function decodeImageDataURL(url) {
  if (typeof url !== 'string') throw invalid('图片必须是 PNG、JPEG 或 WebP 的 base64 数据。');
  if (url.length > Math.ceil(IMAGE_LIMITS.maxImageBytes / 3) * 4 + 32) throw failure(413, 'image_too_large', '单张图片不能超过 8 MB。');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match || match[2].length % 4 !== 0) throw invalid('图片必须是 PNG、JPEG 或 WebP 的 base64 数据。');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > IMAGE_LIMITS.maxImageBytes) throw failure(413, 'image_too_large', '单张图片不能超过 8 MB。');
  if (bytes.toString('base64') !== match[2]) throw invalid('图片编码不正确。');
  const valid = (match[1] === 'png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    || (match[1] === 'jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || (match[1] === 'webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
  if (!valid) throw invalid('图片数据与声明的格式不一致。');
  return { bytes, extension: extensions[match[1]] };
}

export function regionImageName(image, index) {
  const format = image.dataUrl.slice(11, image.dataUrl.indexOf(';'));
  if (!extensions[format]) throw invalid('图片格式不正确。');
  return `region-${index + 1}.${extensions[format]}`;
}

export async function writeRegionImages(directory, images = []) {
  for (const [index, image] of images.entries()) {
    const { bytes } = decodeImageDataURL(image.dataUrl);
    await writeFile(join(directory, regionImageName(image, index)), bytes, { mode: 0o400, flag: 'wx' });
  }
}

// Keep binary data in immutable files, rather than duplicating base64 in archives.
export function imageRequestManifest(request) {
  const { images, ...rest } = request;
  return images?.length ? { ...rest, images: images.map((image, index) => ({ evidenceId: image.evidenceId, fileName: regionImageName(image, index) })) } : rest;
}
