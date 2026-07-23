import { createNodeVitestConfig } from '../../testkit/vitest/node.mjs';

export default createNodeVitestConfig({
  include: [
    'runtime/*.test.ts',
    'material-parser/src/*.test.ts',
    'content-writer/src/*.test.ts',
    'fact-checker/src/*.test.ts',
    'topic-planner/src/*.test.ts',
    'geo-optimizer/src/*.test.ts',
    'quality-checker/src/*.test.ts',
  ],
});
