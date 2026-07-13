import { defineConfig, devices } from '@playwright/test';

const webPort = 34_100;
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: '.',
  testMatch: ['**/apps/api/test/e2e/**/*.spec.ts', '**/apps/web/test/e2e/**/*.spec.ts'],
  outputDir: './test-results/playwright',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['line']] : 'line',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm --filter web start --hostname 127.0.0.1 --port ${webPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: baseURL,
  },
});
