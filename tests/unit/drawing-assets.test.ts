import { describe, expect, it, vi } from 'vitest';
import { localDrawingFontSource } from '../../src/drawing-assets';

const cdn = 'https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/';
const font = 'fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2';
const src = (url: string) => `url(${url}) format('woff2')`;

describe('self-hosted Excalidraw font fallback', () => {
  it.each(['papertrail://app/excalidraw-assets/', 'http://127.0.0.1:5173/excalidraw-assets/'])(
    'uses the local copy of the same file at %s', assetPath => {
      const local = src(assetPath + font);
      expect(localDrawingFontSource(`${local}, ${src(cdn + font)}`, assetPath)).toBe(local);
    },
  );

  it('preserves other fonts, different files, standalone CDN and additional sources', () => {
    const assetPath = 'papertrail://app/excalidraw-assets/';
    const local = src(assetPath + font), fallback = src(cdn + font);
    for (const source of [
      local, fallback, 'url(data:font/woff2;base64,d09GMgABAAAA) format("woff2")',
      `${local}, ${src(cdn + 'fonts/Other.woff2')}`,
      `${src('https://other.example/' + font)}, ${fallback}`,
      `${local}, ${fallback}, local(Excalifont)`,
    ]) expect(localDrawingFontSource(source, assetPath)).toBe(source);
  });

  it('preserves the native constructor, binary sources and descriptor identity', async () => {
    class NativeFontFace {
      constructor(public family: string, public source: string | BufferSource, public descriptors?: FontFaceDescriptors) {}
    }
    const assetPath = 'papertrail://app/excalidraw-assets/';
    vi.stubGlobal('window', { location: { href: 'papertrail://app/' }, FontFace: NativeFontFace });
    vi.resetModules();
    try {
      await import('../../src/drawing-assets');
      const descriptors = { unicodeRange: 'U+20-7E', display: 'swap' as const };
      const local = src(assetPath + font);
      const face = new window.FontFace('Excalifont', `${local}, ${src(cdn + font)}`, descriptors);
      expect(face).toBeInstanceOf(NativeFontFace);
      expect(face).toMatchObject({ family: 'Excalifont', source: local });
      expect(Object.getOwnPropertyDescriptor(face, 'descriptors')?.value).toBe(descriptors);
      const binary = new Uint8Array([0, 1, 2]);
      const binaryFace = new window.FontFace('Binary', binary, descriptors);
      expect(Object.getOwnPropertyDescriptor(binaryFace, 'source')?.value).toBe(binary);
    } finally { vi.unstubAllGlobals(); vi.resetModules(); }
  });
});
