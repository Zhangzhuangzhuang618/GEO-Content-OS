import { createNodeVitestConfig } from '../../packages/testkit/vitest/node.mjs';

export default createNodeVitestConfig({
  include: ['test/integration/**/*.test.ts'],
  testTimeout: 120_000,
});
