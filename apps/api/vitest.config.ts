import { createNodeVitestConfig } from '../../packages/testkit/vitest/node.mjs';

export default createNodeVitestConfig({
  exclude: ['test/integration/**/*.test.ts'],
  include: ['src/**/*.test.ts', 'test/smoke/**/*.test.ts'],
  testTimeout: 10_000,
});
