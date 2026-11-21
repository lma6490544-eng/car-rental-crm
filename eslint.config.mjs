import tseslint from 'typescript-eslint';

const frontendFiles = ['apps/web/src/**/*.{ts,tsx}', 'apps/web/vite.config.ts'];
const sourceFiles = [...frontendFiles, 'apps/api/src/**/*.ts', 'apps/api/drizzle.config.ts'];

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '.runtime/**', 'outputs/**'] },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: sourceFiles })),
  {
    files: sourceFiles,
    rules: {
      // Keep diagnostics visible; npm scripts reject warnings with --max-warnings 0.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/web/src/pages/clients/Clients.tsx', 'apps/web/src/pages/clients/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-nested-ternary': 'error',
    },
  },
];
