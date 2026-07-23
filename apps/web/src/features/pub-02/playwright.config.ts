import { defineConfig } from '@playwright/test';

const port = 34122;
const externalBaseUrl = process.env.PUB02_BASE_URL;
const baseURL = externalBaseUrl ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'pub-02.spec.ts',
  use: { baseURL, headless: true },
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: `pnpm --filter web start --hostname 127.0.0.1 --port ${port}`,
          reuseExistingServer: false,
          timeout: 60_000,
          url: `http://127.0.0.1:${port}/pub-02`,
        },
      }),
  workers: 1,
});
