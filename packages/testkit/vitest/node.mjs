import { defineConfig } from 'vitest/config';

export function createNodeVitestConfig(options) {
  return defineConfig({
    test: {
      clearMocks: true,
      environment: 'node',
      exclude: options.exclude ?? [],
      include: options.include,
      passWithNoTests: false,
      restoreMocks: true,
      testTimeout: options.testTimeout ?? 5_000,
    },
  });
}
