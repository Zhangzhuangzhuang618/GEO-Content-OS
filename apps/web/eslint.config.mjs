import nextPluginPackage from '@next/eslint-plugin-next';

import baseConfig from '../../packages/config/eslint/base.mjs';

const { flatConfig: nextFlatConfig } = nextPluginPackage;

export default [
  ...baseConfig,
  {
    ...nextFlatConfig.coreWebVitals,
    settings: {
      next: {
        rootDir: '.',
      },
    },
  },
  {
    files: ['next-env.d.ts'],
    rules: {
      '@typescript-eslint/triple-slash-reference': 'off',
    },
  },
];
