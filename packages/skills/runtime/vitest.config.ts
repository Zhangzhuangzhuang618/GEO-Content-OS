import { createNodeVitestConfig } from '../../testkit/vitest/node.mjs';

export default createNodeVitestConfig({
  include: ['runtime/*.test.ts', 'material-parser/src/*.test.ts'],
});
