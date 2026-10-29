import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// The renderer is untrusted web content: it may only reach the main process
// through the typed preload API (window.tracingGuatemala), and only via the
// runtime adapter (runtime/AppRuntime.tsx) so the browser demo can swap it out.
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
  { ignores: ['out/**', 'dist-demo/**', 'release/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/main/**', 'src/preload/**', 'tests/unit/**', 'tests/e2e/**', 'tests/demo/**', 'scripts/**', '*.config.*'],
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
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'tracingGuatemala',
          message: 'Use useAppRuntime() so the browser demo can provide its own data.'
        }
      ]
    }
  },
  {
    files: ['src/renderer/src/runtime/AppRuntime.tsx'],
    rules: { 'no-restricted-properties': 'off' }
  },
  {
    // The demo's fictional data and entry point must never reach the desktop bundle.
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    ignores: ['src/renderer/src/demo/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: rendererForbiddenImports,
              message: 'Renderer code must use window.tracingGuatemala instead of Node, Electron, or main-process modules.'
            },
            { group: ['**/demo/**', './demo', '../demo'], message: 'Only the browser demo entry may import demo code.' }
          ]
        }
      ]
    }
  }
)
