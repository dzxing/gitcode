import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

const typedFiles = ['src/**/*.{ts,vue}', 'scripts/**/*.ts', '*.config.ts']
const nodeFiles = [
  'electron/**/*.{js,cjs,mjs}',
  'scripts/**/*.{js,cjs,mjs}',
  'tests/**/*.{js,cjs,mjs}',
]

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'release/**',
      'legacy/**',
      'design/**',
      'test-results/**',
      'playwright-report/**',
      '.gitcode-local/**',
      '.tmp/**',
    ],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  { ...js.configs.recommended, files: ['eslint.config.js', ...typedFiles] },
  {
    ...js.configs.recommended,
    files: nodeFiles,
    languageOptions: { ecmaVersion: 2022, globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Browser evaluation callbacks execute in the renderer, not the Node test runner.
    files: [
      'scripts/verify-*.{cjs,mjs}',
      'tests/**/*.mjs',
      'tests/browser/**/*.js',
      'electron/preload.cjs',
    ],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: typedFiles })),
  ...vue.configs['flat/essential'],
  {
    files: typedFiles,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['src/**/*.vue'],
    languageOptions: { parser: vueParser, parserOptions: { parser: tseslint.parser } },
    rules: {
      'vue/block-lang': ['error', { script: { lang: 'ts' } }],
      'vue/no-v-html': 'error',
      'vue/no-restricted-syntax': [
        'error',
        {
          selector: 'VOnExpression[body.length>1]',
          message: '将多条语句的模板事件提取为具名函数，避免格式化后失效。',
        },
      ],
      'vue/multi-word-component-names': [
        'error',
        { ignores: ['App', 'Icon', 'Sidebar', 'Inspector', 'Dialogs'] },
      ],
    },
  },
  { files: ['src/**/*.{ts,vue}'], languageOptions: { globals: globals.browser } },
  {
    files: ['eslint.config.js', '*.config.ts', 'scripts/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
]
