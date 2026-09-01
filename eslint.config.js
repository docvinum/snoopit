import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // eslint.config.js is not part of the TS project, so it is not type-checked here.
  { ignores: ['dist/**', 'node_modules/**', 'data/**', 'coverage/**', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // The CLI is the one place that legitimately writes to stdout.
    files: ['src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.ts', '*.config.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
