import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'regional-mode.spec.ts',
  workers: 1,
  timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:34166', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm --filter web start --hostname 127.0.0.1 --port 34166',
    url: 'http://127.0.0.1:34166/auth-01',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
