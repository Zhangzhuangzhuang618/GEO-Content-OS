import { defineConfig } from '@playwright/test';
const port = 34109;
export default defineConfig({
  testDir: '.',
  testMatch: 'know-02.spec.ts',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  webServer: {
    command: `pnpm --filter web start --hostname 127.0.0.1 --port ${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://127.0.0.1:${port}/know-02`,
  },
  workers: 1,
});
