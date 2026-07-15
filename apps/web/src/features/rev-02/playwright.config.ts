import { defineConfig } from '@playwright/test';
const port = 34121;
export default defineConfig({
  testDir: '.',
  testMatch: 'rev-02.spec.ts',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  webServer: {
    command: `pnpm --filter web start --hostname 127.0.0.1 --port ${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://127.0.0.1:${port}/rev-02?id=50000000-0000-4000-8000-000000000090`,
  },
  workers: 1,
});
