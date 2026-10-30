import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Bundles the Live web host (src/server/main.ts, #110) into
// dist-web/server/main.mjs for `npm run web:local`. Dependencies (zod) and
// Node built-ins (node:sqlite) stay external.

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const { version } = JSON.parse(readFileSync(fromRoot('./package.json'), 'utf8')) as { version: string }

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    ssr: fromRoot('./src/server/main.ts'),
    outDir: fromRoot('./dist-web/server'),
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { format: 'es', entryFileNames: 'main.mjs' } }
  }
})
