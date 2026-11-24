import js from '@eslint/js'
import globals from 'globals'

export default [
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  {
    ...js.configs.recommended,
    files: [
      'eslint.config.js',
      'scripts/**/*.{js,cjs,mjs}',
      'packages/brand/scripts/**/*.{js,cjs,mjs}',
    ],
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
]
