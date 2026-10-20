const drawingCDN = 'https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/';

export function localDrawingFontSource(source: string, assetPath: string) {
  if (!source.startsWith(`url(${assetPath}fonts/`)) return source;
  const [local, fallback, ...others] = source.split(', ');
  return others.length === 0 && fallback === local.replace(assetPath, drawingCDN) ? local : source;
}

if (typeof window !== 'undefined') {
  const assetPath = new URL('/excalidraw-assets/', window.location.href).href;
  Object.assign(window, { EXCALIDRAW_ASSET_PATH: assetPath });
  // shortcut: 0.18.1 adds a CDN fallback that triggers CSP during registration; review when upgrading Excalidraw.
  window.FontFace = new Proxy(window.FontFace, {
    construct(target, args: ConstructorParameters<typeof FontFace>, newTarget) {
      if (typeof args[1] === 'string') args[1] = localDrawingFontSource(args[1], assetPath);
      return Reflect.construct(target, args, newTarget);
    },
  });
}
