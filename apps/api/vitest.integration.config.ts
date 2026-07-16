import { createNodeVitestConfig } from '../../packages/testkit/vitest/node.mjs';

export default createNodeVitestConfig({
  hookTimeout: 120_000,
  include: ['test/integration/**/*.test.ts'],
  testTimeout: 120_000,
});
