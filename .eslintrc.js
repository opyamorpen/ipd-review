module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaFeatures: {
      impliedStrict: true,
      jsx: true,
    },
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: ['./*/tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: ['.eslintrc.js'],
  plugins: ['react-hooks', '@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'plugin:yml/standard',
    'prettier',
  ],
  overrides: [
    {
      files: ['*.tsx', '*.ts'],
      parser: '@typescript-eslint/parser',
      rules: {
        '@typescript-eslint/no-this-alias': 'off',
        '@typescript-eslint/ban-types': 'warn',
        '@typescript-eslint/ban-ts-comment': 'warn',
        '@typescript-eslint/no-unused-vars': 'warn',
        '@typescript-eslint/no-explicit-any': 'warn',
        '@typescript-eslint/member-ordering': 'warn',
        '@typescript-eslint/no-redundant-type-constituents': 'warn',
        '@typescript-eslint/explicit-module-boundary-types': 'warn',
        '@typescript-eslint/prefer-optional-chain': 'error',
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/consistent-generic-constructors': 'error',
        '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
        // 以下三条为继承自 dcp-review-v2 基线的既有代码模式（组件先使用后定义、
        // 容错性空 catch、hooks 依赖数组从简），存量约 70 处，降级为警告避免
        // 大规模高风险重排；新代码不应再新增此类模式。
        '@typescript-eslint/no-use-before-define': [
          'warn',
          {
            functions: false,
            typedefs: false,
          },
        ],
        '@typescript-eslint/consistent-type-exports': [
          'error',
          {
            fixMixedExportsWithInlineTypeSpecifier: true,
          },
        ],
        'no-empty': ['warn', { allowEmptyCatch: true }],
        'react-hooks/exhaustive-deps': 'warn',
      },
    },
    {
      files: ['*.yaml', '*.yml'],
      parser: 'yaml-eslint-parser',
      parserOptions: {
        defaultYAMLVersion: '1.2',
      },
      rules: {
        'yml/quotes': 'off',
        'yml/spaced-comment': 'warn',
        'yml/no-empty-document': 'warn',
        'yml/no-empty-mapping-value': 'warn',
      },
    },
  ],
  rules: {
    'no-use-before-define': 'off',
    'no-constant-binary-expression': 'error',
    'no-console': [
      'warn',
      {
        allow: ['error', 'warn'],
      },
    ],
    'object-shorthand': [
      'error',
      'always',
      {
        avoidQuotes: true,
      },
    ],
    'prefer-const': [
      'error',
      {
        destructuring: 'all',
      },
    ],
    'react-hooks/exhaustive-deps': 'error',
  },
}
