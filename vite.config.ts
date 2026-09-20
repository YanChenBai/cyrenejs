import { defineConfig } from 'vite-plus';

export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },

  fmt: {
    singleQuote: true,
    sortImports: true,
    sortTailwindcss: true,
    sortPackageJson: true,
    arrowParens: 'avoid',
    embeddedLanguageFormatting: 'auto',
    printWidth: 100,
    ignorePatterns: ['CHANGELOG.md'],
  },

  lint: {
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
      {
        name: 'stylistic',
        specifier: '@stylistic/eslint-plugin',
      },
    ],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'typescript/switch-exhaustiveness-check': 'error',
      'typescript/consistent-type-imports': 'error',
      'unicorn/switch-case-braces': 'error',
      'default-case-last': 'allow',
      'no-return-assign': 'error',
      'no-implicit-coercion': 'error',
      'prefer-template': 'error',
      'prefer-const': 'error',
      'no-sequences': 'error',
      'no-console': [
        'error',
        {
          allow: ['warn', 'error'],
        },
      ],

      curly: 'error',

      // return 后不要再套 else
      'no-else-return': 'error',

      // 避免 else { if (...) }
      'no-lonely-if': 'error',

      // 禁止嵌套三元
      'no-nested-ternary': 'error',

      // 去掉无意义三元
      'no-unneeded-ternary': 'error',

      // 最大块嵌套层级
      'max-depth': ['warn', { max: 4 }],

      // 圈复杂度
      complexity: ['warn', { max: 12 }],

      // foo(bar(baz(qux()))) 这种调用嵌套
      'unicorn/max-nested-calls': ['warn', { max: 3 }],

      'stylistic/padding-line-between-statements': [
        'error',
        {
          blankLine: 'always',
          prev: '*',
          next: 'block-like',
        },
        {
          blankLine: 'always',
          prev: 'block-like',
          next: '*',
        },
        {
          blankLine: 'always',
          prev: '*',
          next: ['multiline-const', 'multiline-let', 'multiline-var'],
        },

        {
          blankLine: 'always',
          prev: ['multiline-const', 'multiline-let', 'multiline-var'],
          next: '*',
        },
      ],
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: ['CHANGELOG.md'],
  },

  pack: {
    entry: ['src/index.ts'],
    dts: true,
  },

  test: {
    include: ['tests/**/*.test.ts'],
  },

  run: {
    cache: true,
  },
});
