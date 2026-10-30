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

// Editor and canvas libraries stay behind the notebook ports (#146): their packages
// may only be imported under notebook/adapters/, and a concrete adapter folder only
// from within notebook/adapters/ (the composition root, adapters/index.ts, picks one).
const notebookVendorPackages = [
  '@tiptap/*',
  'prosemirror-*',
  '@excalidraw/*',
  'excalidraw',
  'lexical',
  '@lexical/*',
  'tldraw',
  '@tldraw/*',
  'slate',
  'slate-*',
  'quill',
  'quill-*'
]
const notebookVendorPattern = {
  group: notebookVendorPackages,
  message: 'Editor and canvas libraries may only be imported under src/renderer/src/notebook/adapters/.'
}
const concreteAdapterPattern = {
  group: ['**/adapters/*/**', '**/adapters/*', '!**/adapters/index'],
  message: 'Import adapters through the notebook ports and the composition root (notebook/adapters/index.ts), not a concrete adapter folder.'
}

export default defineConfig(
  { ignores: ['out/**', 'dist-demo/**', 'dist-web/**', '.web-dev-data/**', 'release/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/main/**', 'src/preload/**', 'src/server/**', 'tests/unit/**', 'tests/e2e/**', 'tests/demo/**', 'tests/web/**', 'scripts/**', '*.config.*'],
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
            },
            notebookVendorPattern,
            concreteAdapterPattern
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
    // Driver.js stays behind the guidance seam: only its provider may import it (#102).
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    ignores: ['src/renderer/src/guidance/driverJsProvider.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[source.value=/^driver[.]js/]",
          message: 'Only guidance/driverJsProvider.ts may import driver.js.'
        }
      ]
    }
  },
  {
    files: ['src/renderer/src/runtime/AppRuntime.tsx'],
    rules: { 'no-restricted-properties': 'off' }
  },
  {
    // The demo's fictional data and entry point must never reach the desktop or
    // Live bundles, and the Live API client must never reach the demo (#110).
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    ignores: ['src/renderer/src/demo/**', 'src/renderer/src/web/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: rendererForbiddenImports,
              message: 'Renderer code must use window.tracingGuatemala instead of Node, Electron, or main-process modules.'
            },
            notebookVendorPattern,
            concreteAdapterPattern,
            { group: ['**/demo/**', './demo', '../demo'], message: 'Only the browser demo entry may import demo code.' },
            { group: ['**/web/**', './web', '../web'], message: 'Only the Live web entry may import Live web code.' }
          ]
        }
      ]
    }
  },
  {
    files: ['src/renderer/src/demo/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: rendererForbiddenImports,
              message: 'Renderer code must use window.tracingGuatemala instead of Node, Electron, or main-process modules.'
            },
            notebookVendorPattern,
            concreteAdapterPattern,
            { group: ['**/web/**', './web', '../web'], message: 'The fictional demo must never reach the Live web host.' }
          ]
        }
      ]
    }
  },
  {
    files: ['src/renderer/src/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: rendererForbiddenImports,
              message: 'Renderer code must use window.tracingGuatemala instead of Node, Electron, or main-process modules.'
            },
            notebookVendorPattern,
            concreteAdapterPattern,
            { group: ['**/demo/**', './demo', '../demo'], message: 'Fictional demo data must never reach the Live web app.' }
          ]
        }
      ]
    }
  },
  {
    // Everything outside the renderer never touches an editor or canvas library.
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/server/**/*.ts', 'src/shared/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [notebookVendorPattern] }] }
  },
  {
    // Adapters are where the libraries live: they may import them and each other, but
    // keep every other renderer boundary.
    files: ['src/renderer/src/notebook/adapters/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: rendererForbiddenImports,
              message: 'Renderer code must use window.tracingGuatemala instead of Node, Electron, or main-process modules.'
            },
            { group: ['**/demo/**', './demo', '../demo'], message: 'Only the browser demo entry may import demo code.' },
            { group: ['**/web/**', './web', '../web'], message: 'Only the Live web entry may import Live web code.' }
          ]
        }
      ]
    }
  }
)
