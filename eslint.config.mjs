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
      'contract/**/*.ts',
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
        typescript: {
          ...tsImportResolver,
          project: './tsconfig.json',
          // The contract/ directory is excluded from tsconfig.json but is
          // imported by tools/contract-check/*.ts. Tell the resolver to
          // still resolve from node_modules and from sibling files.
          alwaysTryTypes: true,
        },
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
      'jsdoc/require-jsdoc': 'off',
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
    // The pure domain value objects (Cents, TokenAmount, errors, clock,
    // rng, uuid) are documented at the file level. Per-method JSDoc is
    // required for services, handlers, rooms, and repos. This keeps the
    // spec "TSDoc on every exported function" enforceable for the
    // application layer while not doubling the size of the value-object
    // files for trivial getters.
    files: ['server/shared/domain/**'],
    rules: {
      'jsdoc/require-jsdoc': 'off',
    },
  },
  {
    // Transport layer (api, realtime, workers) and shared application
    // services. JSDoc is required on every exported function/method.
    files: [
      'server/api/**/*.ts',
      'server/application/**/*.ts',
      'server/realtime/**/*.ts',
      'server/workers/**/*.ts',
      'server/shared/infra/**/*.ts',
      'server/shared/application/**/*.ts',
      'server/shared/auth/**/*.ts',
      'server/shared/ledger/**/*.ts',
      'server/shared/solana/**/*.ts',
      'server/shared/livekit/**/*.ts',
      'server/shared/s3/**/*.ts',
      'server/shared/redis/**/*.ts',
      'server/shared/jwt/**/*.ts',
      'server/shared/logger/**/*.ts',
      'server/shared/config/**/*.ts',
      'packages/npc-brain/**/*.ts',
    ],
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: false,
            ArrowFunctionExpression: false,
          },
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
    // Tools (scripts, contract-check, bots, econ-sim) are allowed to use
    // `any`, `console.log`, and to skip JSDoc on small utility scripts.
    files: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/test/**/*.ts',
      '**/tests/**/*.ts',
      'tools/**/index.ts',
      'tools/scripts/**',
      'tools/contract-check/**',
    ],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'jsdoc/require-jsdoc': 'off',
    },
  },
];
