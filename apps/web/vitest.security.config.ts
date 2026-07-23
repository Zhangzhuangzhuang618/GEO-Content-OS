import { createNodeVitestConfig } from '../../packages/testkit/vitest/node.mjs';

export default createNodeVitestConfig({
  include: ['test/security/**/*.test.ts', 'test/security/**/*.test.tsx'],
  testTimeout: 10_000,
});
