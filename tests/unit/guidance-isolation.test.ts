import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Keeps Driver.js behind the guidance seam (#102): one file imports it, and the Live
// web app and desktop entries cannot reach it, statically or through built output.

const root = resolve(__dirname, '../..')
const src = join(root, 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const code = /\.(ts|tsx|mts|mjs)$/
const specifier = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(specifier)].map((m) => m[1] ?? m[2] ?? m[3]!)
}

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Every file reachable from `entry` through relative imports (static and dynamic). */
function reachable(entry: string, stopAt?: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file) || file === stopAt || !code.test(file)) continue
    seen.add(file)
    for (const spec of specifiers(file)) {
      const target = resolveImport(file, spec)
      if (target) queue.push(target)
    }
  }
  return seen
}

describe('driver.js isolation', () => {
  it('is imported by driverJsProvider.ts and by no other source file', () => {
    const importers = walk(src)
      .filter((f) => code.test(f) || f.endsWith('.tsx'))
      .filter((f) => specifiers(f).some((s) => s === 'driver.js' || s.startsWith('driver.js/')))
    expect(importers.map((f) => relative(root, f).replaceAll('\\', '/'))).toEqual(['src/renderer/src/guidance/driverJsProvider.ts'])
  })

  it('is pinned to an exact 1.x version in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['driver.js']).toMatch(/^1\.\d+\.\d+$/)
  })

  it.each([
    ['Live web entry', 'renderer/src/web/main.tsx'],
    ['desktop entry', 'renderer/src/main.tsx']
  ])('cannot reach the provider from the %s', (_label, entry) => {
    const entryFile = join(src, entry)
    expect(existsSync(entryFile), `entry ${entry}`).toBe(true)
    const files = [...reachable(entryFile)].map((f) => relative(root, f).split(sep).join('/'))
    expect(files).not.toContain('src/renderer/src/guidance/driverJsProvider.ts')
    expect(files).not.toContain('src/renderer/src/demo/main.tsx')
  })

  it('is mounted only from the demo entry, through a dynamic import', () => {
    const mounts = walk(src).filter((f) => code.test(f) && specifiers(f).some((s) => s.endsWith('guidance/driverJsProvider')))
    expect(mounts.map((f) => relative(root, f).replaceAll('\\', '/'))).toEqual(['src/renderer/src/demo/main.tsx'])
    expect(readFileSync(mounts[0]!, 'utf8')).toMatch(/await import\('\.\.\/guidance\/driverJsProvider'\)/)
  })

  // Runs against the real Live web and desktop builds when `npm run web:build` /
  // `npm run build` have produced them (the e2e script always does).
  it.each([
    ['dist-web/client'],
    ['out/renderer']
  ])('is absent from built output in %s', (dir) => {
    const path = join(root, dir)
    if (!existsSync(path)) return
    const built = walk(path).filter((f) => /\.(js|css|html)$/.test(f))
    expect(built.length).toBeGreaterThan(0)
    for (const file of built) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/driver-popover|driver\.js|driver-overlay/)
    }
  })
})
