import { defineConfig, devices } from '@playwright/test';

const port = 34_140;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  expect: { timeout: 5_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: '../../../../test-results/a11y',
  reporter: 'line',
  retries: process.env.CI ? 1 : 0,
  testDir: '.',
  testMatch: 'core-pages.a11y.spec.ts',
  timeout: 30_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm --filter web start --hostname 127.0.0.1 --port ${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    url: `${baseURL}/auth-01`,
  },
  workers: 1,
});
