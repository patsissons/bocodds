import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      '.wrangler/',
      'test-results/',
      'playwright-report/',
      'public/fonts/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['public/app.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  prettier,
);
