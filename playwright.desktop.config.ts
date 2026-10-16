import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/desktop',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results-desktop',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-desktop', open: 'never' }]],
  use: { trace: 'retain-on-failure' },
});
