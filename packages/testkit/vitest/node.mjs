import { defineConfig } from 'vitest/config';

export function createNodeVitestConfig(options) {
  return defineConfig({
    test: {
      clearMocks: true,
      environment: 'node',
      exclude: options.exclude ?? [],
      hookTimeout: options.hookTimeout ?? 10_000,
      include: options.include,
      passWithNoTests: false,
      restoreMocks: true,
      testTimeout: options.testTimeout ?? 5_000,
    },
  });
}
