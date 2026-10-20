import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const target = new URL('../public/excalidraw-assets/', import.meta.url);
await mkdir(target, { recursive: true });
await cp(fileURLToPath(new URL('../node_modules/@excalidraw/excalidraw/dist/prod/fonts/', import.meta.url)), fileURLToPath(new URL('fonts/', target)), { recursive: true });
