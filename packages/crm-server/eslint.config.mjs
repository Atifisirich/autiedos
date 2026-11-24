import js from '@eslint/js';
import tseslint from 'typescript-eslint';
// The ported CRM logic works on untyped database rows (Row = Record<string, any>), as the original lib/*.ts did.
export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'off',
  },
});
