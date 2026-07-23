import { defineConfig, devices } from '@playwright/test';

const port = 34_101;

export default defineConfig({
  fullyParallel: false,
  reporter: 'line',
  testDir: '.',
  testMatch: 'auth-01.spec.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
  },
  webServer: {
    command: `node ../../../node_modules/next/dist/bin/next start ../../.. --hostname 127.0.0.1 --port ${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    url: `http://127.0.0.1:${port}/auth-01`,
  },
});
