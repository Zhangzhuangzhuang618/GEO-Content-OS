import { defineConfig } from '@playwright/test';

const port = 34114;

export default defineConfig({
  testDir: '.',
  testMatch: 'cont-04.spec.ts',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  webServer: {
    command: `pnpm --filter web start --hostname 127.0.0.1 --port ${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://127.0.0.1:${port}/cont-04?id=50000000-0000-4000-8000-000000000085`,
  },
  workers: 1,
});
