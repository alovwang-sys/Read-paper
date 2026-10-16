import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api/ai': 'http://127.0.0.1:8787' } },
  preview: { proxy: { '/api/ai': 'http://127.0.0.1:8787' } },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
