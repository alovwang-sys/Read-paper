import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync, readdirSync } from 'node:fs';

const pdfCodecs = new URL('./node_modules/pdfjs-dist/wasm/', import.meta.url);
const codecNames = readdirSync(pdfCodecs).filter(name => /\.(wasm|js)$/.test(name) || name.startsWith('LICENSE'));

export default defineConfig({
  plugins: [react(), {
    name: 'pdf-reader-codecs',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0]?.replace(/^\/pdfjs\/wasm\//, '');
        if (!req.url?.startsWith('/pdfjs/wasm/') || !name || !codecNames.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : 'text/plain');
        res.end(readFileSync(new URL(name, pdfCodecs)));
      });
    },
    generateBundle() {
      for (const name of codecNames) this.emitFile({ type: 'asset', fileName: `pdfjs/wasm/${name}`, source: readFileSync(new URL(name, pdfCodecs)) });
    },
  }],
  server: { proxy: { '/api/ai': 'http://127.0.0.1:8787', '/api/sources': 'http://127.0.0.1:8787' } },
  preview: { proxy: { '/api/ai': 'http://127.0.0.1:8787', '/api/sources': 'http://127.0.0.1:8787' } },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
