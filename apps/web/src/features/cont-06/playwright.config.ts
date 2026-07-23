import { defineConfig } from '@playwright/test';

const port = 34116;

export default defineConfig({
  testDir: '.',
  testMatch: 'cont-06.spec.ts',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  webServer: {
    command: `pnpm --filter web start --hostname 127.0.0.1 --port ${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://127.0.0.1:${port}/cont-06?id=60000000-0000-4000-8000-000000000087`,
  },
  workers: 1,
});
