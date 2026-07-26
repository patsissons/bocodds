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
    files: ['public/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['tests/e2e/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      // document: used inside page.evaluate() callbacks (browser side).
      globals: { ...globals.node, document: 'readonly' },
    },
  },
  prettier,
);
