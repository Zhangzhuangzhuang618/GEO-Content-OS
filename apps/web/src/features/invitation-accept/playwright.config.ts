import { defineConfig } from '@playwright/test';

const port = 34103;

export default defineConfig({
  fullyParallel: false,
  retries: 0,
  testDir: '.',
  testMatch: 'invitation-accept.spec.ts',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
  },
  webServer: {
    command: `node ../../../node_modules/next/dist/bin/next start ../../.. --hostname 127.0.0.1 --port ${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://127.0.0.1:${port}/invitations/accept`,
  },
  workers: 1,
});
