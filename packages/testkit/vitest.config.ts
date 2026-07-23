import { createNodeVitestConfig } from './vitest/node.mjs';

export default createNodeVitestConfig({
  include: ['src/**/*.test.ts'],
});
