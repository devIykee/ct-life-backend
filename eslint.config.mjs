// ESLint flat config (ESLint 9). Layering rules enforce architecture.
// Boundaries: domain <- application <- transport; domain never imports transport or infra.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsdoc from 'eslint-plugin-jsdoc';
import importPlugin from 'eslint-plugin-import';
import * as tsImportResolver from 'eslint-import-resolver-typescript';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/target/**',
      'contract/openapi/generated/**',
      'contract/realtime/generated/**',
      'docs/spec/**',
      '.github/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      jsdoc,
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: { ...tsImportResolver, project: './tsconfig.json' },
        node: { extensions: ['.ts', '.js'] },
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "TSAsExpression[typeAnnotation.typeName.name='any']",
          message: 'Avoid `as any`. Use unknown + validation.',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
          },
        },
      ],
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns-description': 'error',
      // Layering: server/shared and packages/npc-brain (domain) cannot import transport.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/server/api/**', '**/server/realtime/**', '**/server/workers/**'],
              message: 'Domain layer (server/shared, packages/*) cannot import transport.',
            },
          ],
        },
      ],
    },
  },
  {
    // Transport layer may import anything; just disallow DOM-only globals.
    files: ['server/api/**/*.ts', 'server/realtime/**/*.ts', 'server/workers/**/*.ts'],
    rules: {},
  },
  {
    // Tests are allowed to use any, console.log, etc.
    files: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/test/**/*.ts',
      '**/tests/**/*.ts',
      'tools/**/index.ts',
    ],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
