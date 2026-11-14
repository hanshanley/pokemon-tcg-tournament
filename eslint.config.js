import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules', '.venv', 'data', 'dist', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { 'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }] },
  },
];
