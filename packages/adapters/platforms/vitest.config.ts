import { createNodeVitestConfig } from '../../testkit/vitest/node.mjs';

export default createNodeVitestConfig({ include: ['**/*.test.ts'] });
