import { defineConfig } from '@playwright/test';

const port = 34103;

export default defineConfig({
  testDir: '.',
  testMatch: 'dash-01.spec.ts',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  webServer: {
    command: `pnpm --filter web start --hostname 127.0.0.1 --port ${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://127.0.0.1:${port}/dash-01`,
  },
  workers: 1,
});
