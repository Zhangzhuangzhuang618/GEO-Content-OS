import { createNodeVitestConfig } from '../../packages/testkit/vitest/node.mjs';

export default createNodeVitestConfig({
  exclude: ['src/**/*.integration.test.ts'],
  include: ['src/**/*.test.ts'],
  testTimeout: 10_000,
});
