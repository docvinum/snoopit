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
      // The DOM lib is enabled because playwright-core's types require it and
      // because page-evaluated code is genuine browser code. It must not leak:
      // these globals do not exist in the Node runtime this project runs in.
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Browser global — only inside src/runtime/browser adapters.' },
        { name: 'document', message: 'Browser global — only inside src/runtime/browser adapters.' },
        {
          name: 'navigator',
          message: 'Browser global — only inside src/runtime/browser adapters.',
        },
        { name: 'location', message: 'Browser global — only inside src/runtime/browser adapters.' },
      ],
    },
  },
  {
    // The browser adapters are the one place that legitimately evaluates code in a
    // page, so browser globals are expected here and nowhere else.
    files: ['src/runtime/browser/cdp.ts', 'src/runtime/browser/fake.ts'],
    rules: { 'no-restricted-globals': 'off' },
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
