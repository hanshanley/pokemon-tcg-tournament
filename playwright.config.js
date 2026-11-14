import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests-browser',
  outputDir: './test-results/local',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:8003',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: '.venv/bin/python -m tests.browser_server',
    url: 'http://127.0.0.1:8003/api/health',
    reuseExistingServer: false,
  },
});
