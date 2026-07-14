import { createNodeVitestConfig } from '../../testkit/vitest/node.mjs';

export default createNodeVitestConfig({ include: ['src/**/*.test.ts'], testTimeout: 10_000 });
