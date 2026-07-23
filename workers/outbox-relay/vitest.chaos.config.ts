import { createNodeVitestConfig } from '../../packages/testkit/vitest/node.mjs';

export default createNodeVitestConfig({
  hookTimeout: 120_000,
  include: ['chaos/**/*.chaos.test.ts'],
  testTimeout: 30_000,
});
