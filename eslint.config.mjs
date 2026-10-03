import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['node_modules/**', '.release/**', '*test-*/**', '**/*.cjs'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['main.js'],
    rules: {
      // Obsidian loads this readable, unbundled installation asset as CommonJS.
      '@typescript-eslint/no-require-imports': 'off',
      'obsidianmd/ui/sentence-case': ['warn', { brands: ['BiliNote', 'Obsidian', 'Markdown'], enforceCamelCaseLower: true }],
    },
  },
  {
    files: ['manifest.json'],
    languageOptions: { parser: tseslint.parser, parserOptions: { extraFileExtensions: ['.json'] } },
    rules: { 'obsidianmd/validate-manifest': 'error' },
  },
]);
