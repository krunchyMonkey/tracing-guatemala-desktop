import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// The renderer is untrusted web content: it may only reach the main process
// through the typed preload API (window.tracingGuatemala).
const rendererForbiddenImports = [
  'electron',
  'electron/*',
  'node:*',
  'fs',
  'fs/*',
  'path',
  'os',
  'child_process',
  'worker_threads',
  'net',
  'http',
  'https',
  '*sqlite*',
  '**/main/**',
  '**/preload/**'
]

export default defineConfig(
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/main/**', 'src/preload/**', 'tests/unit/**', 'tests/e2e/**', '*.config.*'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: rendererForbiddenImports,
              message: 'Renderer code must use window.tracingGuatemala instead of Node, Electron, or main-process modules.'
            }
          ]
        }
      ]
    }
  }
)
