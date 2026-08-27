import { createNodeVitestConfig } from '../../packages/testkit/vitest/node.mjs';

export default createNodeVitestConfig({
  include: ['src/**/*.integration.test.ts'],
  testTimeout: 30_000,
});
