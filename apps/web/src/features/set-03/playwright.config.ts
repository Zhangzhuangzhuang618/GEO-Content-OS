import { defineConfig } from '@playwright/test';

const port = 34129;

export default defineConfig({
  testDir: '.',
  testMatch: 'set-03.spec.ts',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  webServer: {
    command: `pnpm --filter web start --hostname 127.0.0.1 --port ${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://127.0.0.1:${port}/set-03`,
  },
  workers: 1,
});
