import { resolve } from 'node:path'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

// Keeps editor and canvas libraries behind the notebook ports (#146): their packages
// may only be imported under notebook/adapters/, and a concrete adapter folder only
// from within notebook/adapters/. Lints sample code with the repo's real ESLint config.

const root = resolve(__dirname, '../..')
const vendors = ['@tiptap/core', '@tiptap/react', 'prosemirror-state', '@excalidraw/excalidraw', 'lexical', '@lexical/react', 'tldraw', '@tldraw/editor', 'slate', 'slate-react', 'quill']

let eslint: ESLint

async function messages(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) })
  return result!.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message)
}

beforeAll(() => {
  eslint = new ESLint({ cwd: root })
})

describe('editor and canvas library boundary', () => {
  const outside = [
    'src/shared/x.ts',
    'src/main/x.ts',
    'src/server/x.ts',
    'src/preload/x.ts',
    'src/renderer/src/screens/X.tsx',
    'src/renderer/src/notebook/NotebookScreen.tsx',
    'src/renderer/src/demo/X.tsx',
    'src/renderer/src/web/X.tsx'
  ]

  it.each(outside)('forbids vendor packages in %s', async (file) => {
    for (const vendor of vendors) {
      const found = await messages(file, `import * as lib from '${vendor}'\nexport default lib\n`)
      expect(found, `${vendor} in ${file}`).toEqual([expect.stringContaining('notebook/adapters')])
    }
  })

  it('forbids a vendor sub-path import too', async () => {
    expect(await messages('src/shared/x.ts', `import { Node } from '@tiptap/core/dist/x'\nexport default Node\n`)).toHaveLength(1)
    expect(await messages('src/shared/x.ts', `export { x } from 'prosemirror-model'\n`)).toHaveLength(1)
  })

  it('allows vendor packages inside an adapter folder', async () => {
    for (const file of ['src/renderer/src/notebook/adapters/tiptap/x.ts', 'src/renderer/src/notebook/adapters/excalidraw/Canvas.tsx']) {
      for (const vendor of vendors) {
        expect(await messages(file, `import * as lib from '${vendor}'\nexport default lib\n`), `${vendor} in ${file}`).toEqual([])
      }
    }
  })

  it('does not block unrelated packages or similarly named local files', async () => {
    expect(await messages('src/shared/x.ts', `import { z } from 'zod'\nexport default z\n`)).toEqual([])
    expect(await messages('src/renderer/src/screens/X.tsx', `import { a } from './slated'\nexport default a\n`)).toEqual([])
  })

  it('still applies the existing renderer boundaries inside adapters', async () => {
    expect(await messages('src/renderer/src/notebook/adapters/tiptap/x.ts', `import fs from 'node:fs'\nexport default fs\n`)).toHaveLength(1)
    expect(await messages('src/renderer/src/screens/X.tsx', `import fs from 'node:fs'\nexport default fs\n`)).toHaveLength(1)
  })
})

describe('concrete adapter boundary', () => {
  const imports = [
    '../notebook/adapters/plain/plainTextAdapter',
    '../../notebook/adapters/plain/plainTextAdapter',
    './adapters/plain/plainTextAdapter',
    '../notebook/adapters/tiptap'
  ]

  it.each(imports)('forbids %s outside notebook/adapters', async (spec) => {
    for (const file of ['src/renderer/src/screens/X.tsx', 'src/renderer/src/notebook/NotebookScreen.tsx', 'src/renderer/src/App.tsx']) {
      expect(await messages(file, `import { a } from '${spec}'\nexport default a\n`), `${spec} in ${file}`).toHaveLength(1)
    }
  })

  it('lets the composition root and the adapters import concrete adapters', async () => {
    const code = `import { a } from './plain/plainTextAdapter'\nexport default a\n`
    expect(await messages('src/renderer/src/notebook/adapters/index.ts', code)).toEqual([])
    expect(await messages('src/renderer/src/notebook/adapters/tiptap/x.ts', `import { a } from '../plain/plainTextAdapter'\nexport default a\n`)).toEqual([])
  })

  it('lets other code import the composition root', async () => {
    expect(await messages('src/renderer/src/App.tsx', `import { a } from './notebook/adapters'\nexport default a\n`)).toEqual([])
    expect(await messages('src/renderer/src/notebook/NotebookScreen.tsx', `import { a } from './adapters'\nexport default a\n`)).toEqual([])
  })

  it('does not restrict tests', async () => {
    const code = `import { a } from '../../src/renderer/src/notebook/adapters/plain/plainTextAdapter'\nexport default a\n`
    expect(await messages('tests/renderer/notebook/x.ts', code)).toEqual([])
  })
})
