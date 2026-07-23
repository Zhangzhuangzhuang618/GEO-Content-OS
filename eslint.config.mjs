import baseConfig from './packages/config/eslint/base.mjs';
import nextPlugin from '@next/eslint-plugin-next';

export default [
  ...baseConfig,
  {
    files: [
      'apps/web/**/*.{js,mjs,cjs,ts,mts,cts,tsx}',
      'src/app/**/*.{js,mjs,cjs,ts,mts,cts,tsx}',
    ],
    plugins: {
      '@next/next': nextPlugin,
    },
    settings: {
      next: {
        rootDir: ['apps/web/', './'],
      },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    files: ['apps/web/next-env.d.ts', 'next-env.d.ts'],
    rules: {
      '@typescript-eslint/triple-slash-reference': 'off',
    },
  },
];
