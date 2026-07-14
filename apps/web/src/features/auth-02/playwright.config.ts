import { defineConfig } from '@playwright/test';

const port = 34102;

export default defineConfig({
  fullyParallel: false,
  retries: 0,
  testDir: '.',
  testMatch: 'auth-02.spec.ts',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
  },
  webServer: {
    command: `pnpm --filter web start --hostname 127.0.0.1 --port ${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://127.0.0.1:${port}/auth-02`,
  },
  workers: 1,
});
