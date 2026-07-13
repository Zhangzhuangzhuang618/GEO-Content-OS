import { createNodeVitestConfig } from '../../packages/testkit/vitest/node.mjs';

export default createNodeVitestConfig({
  include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  testTimeout: 10_000,
});
