import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests-pages',
  outputDir: './test-results/pages',
  workers: 1,
  timeout: 180000,
  use: {
    baseURL: 'http://127.0.0.1:8005/pokemon-tcg-tournament/',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: '.venv/bin/python -m tests.pages_server',
    url: 'http://127.0.0.1:8005/pokemon-tcg-tournament/',
    reuseExistingServer: false,
  },
});
