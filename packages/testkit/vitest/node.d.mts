import type { UserConfig } from 'vitest/config';

export interface NodeVitestConfigOptions {
  readonly exclude?: string[];
  readonly include: string[];
  readonly testTimeout?: number;
}

export function createNodeVitestConfig(options: NodeVitestConfigOptions): UserConfig;
