import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// #255: the research access checks (canRead and canWrite) run OUTSIDE the repository's write transaction.
// That is safe only because the code between a check and its write never yields to the event loop.
// Keeping these two files free of async code is the regression guard; the day one of them needs an
// await, the checks must first move inside the write transaction (see docs/architecture/research-authorization.md).

const root = join(__dirname, '..', '..')

/** The source with block comments, line comments and string/template contents removed. */
function code(file: string): string {
  return readFileSync(join(root, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
}

describe('research access stays synchronous (#255)', () => {
  it.each(['src/main/data-services.ts', 'src/main/database/research-access.ts'])(
    'keeps %s free of async, await, Promise and .then( so a point check and its write are never split by an await while checks run outside the write transaction',
    (file) => {
      const source = code(file)
      expect(source.length).toBeGreaterThan(500)
      expect(source).not.toMatch(/\basync\b/)
      expect(source).not.toMatch(/\bawait\b/)
      expect(source).not.toMatch(/\bPromise\b/)
      expect(source).not.toMatch(/\.then\s*\(/)
    }
  )
})
