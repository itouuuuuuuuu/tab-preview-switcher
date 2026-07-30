import unicorn from 'eslint-plugin-unicorn'
import tseslint from 'typescript-eslint'

/**
 * Deliberately minimal, with a single purpose. Formatting and broad static
 * analysis are out of scope here.
 *
 * Passing a function directly to an array iterator hands the array index to the
 * callback's second parameter. TypeScript intentionally allows using a function
 * with fewer parameters as a callback that takes more, so this slips past the
 * type checker even under strict. It actually shipped: `ring.map(toCandidate)`
 * fed the index into the second parameter, every candidate was rejected, and
 * Ctrl+A stopped showing any cards.
 */
export default [
  { ignores: ['dist/', 'node_modules/'] },
  {
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { unicorn },
    rules: {
      'unicorn/no-array-callback-reference': 'error',
    },
  },
]
