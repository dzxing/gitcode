import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

const sourceFiles = ['app/**/*.{ts,vue}', 'nuxt.config.ts']

export default [
  {
    ignores: ['node_modules/**', '.nuxt/**', '.output/**', '.tmp/**', 'dist/**', 'design/**'],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  { ...js.configs.recommended, files: ['eslint.config.js', ...sourceFiles] },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: sourceFiles })),
  ...vue.configs['flat/essential'],
  {
    files: sourceFiles,
    languageOptions: { globals: globals.browser },
    rules: {
      // Nuxt's generated types validate auto-imported globals during typecheck.
      'no-undef': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  {
    files: ['app/**/*.vue'],
    languageOptions: { parser: vueParser, parserOptions: { parser: tseslint.parser } },
    rules: {
      'vue/block-lang': ['error', { script: { lang: 'ts' } }],
      // Nuxt derives routes from filenames such as index.vue and [slug].vue.
      'vue/multi-word-component-names': 'off',
    },
  },
  { files: ['eslint.config.js'], languageOptions: { globals: globals.node } },
]
