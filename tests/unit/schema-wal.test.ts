import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APPLICATION_ID, configureConnection, DATABASE_FILE_NAME, dataDirectory, openAppDatabase } from '../../src/main/database/connection'
import { DatabaseTooNewError, migrate, migrations, type Migration } from '../../src/main/database/migrations'
import { DataProfileUnsafeError, effectiveHeader, inspectProfile, MigrationRequiredError } from '../../src/main/database/schema-preflight'
import { confirmationPhrase, MaintenanceError, migrateProfile } from '../../src/server/maintenance/migrate-database'

// #248: the schema version of a profile with a write-ahead log is the version in the log's
// last committed copy of page 1, not the main file's header. Fixtures are real SQLite files:
// a writer is left open with autocheckpoint off, and its main file and log are copied (never
// the -shm) into a second folder, which is what a crash leaves behind. Fictional rows only.

const latest = migrations.length
const previous = migrations.slice(0, -1)
const extra = (n: number): Migration => ({ version: n, name: `test_additive_${n}`, sql: `CREATE TABLE test_extra_${n} (id TEXT PRIMARY KEY) STRICT;` })
const plusOne: readonly Migration[] = [...migrations, extra(latest + 1)]
const plusTwo: readonly Migration[] = [...plusOne, extra(latest + 2)]

const folders: string[] = []
beforeEach(() => {
  folders.length = 0
})
afterEach(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

const newFolder = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'tg-schemawal-'))
  folders.push(folder)
  return folder
}
const mainOf = (profile: string): string => join(dataDirectory(profile), DATABASE_FILE_NAME)
const walOf = (profile: string): string => `${mainOf(profile)}-wal`

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else out[relative(dir, full)] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(dir)
  return out
}

const insertClient = (db: DatabaseSync, id: string, name: string): void => {
  db.prepare("INSERT INTO clients (id, display_name, source, created_at, updated_at) VALUES (?, ?, 'direct', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(id, name)
}

function names(file: string): string[] {
  const db = new DatabaseSync(file)
  try {
    return (db.prepare('SELECT display_name FROM clients ORDER BY id').all() as { display_name: string }[]).map((r) => r.display_name)
  } finally {
    db.close()
  }
}

/** Seeds a closed (checkpointed) WAL-mode profile at `base`, then lets `work` change it while the writer is still open. Returns a copy of main + log only. */
function crash(base: readonly Migration[], work: (db: DatabaseSync) => void): string {
  const origin = newFolder()
  mkdirSync(dataDirectory(origin), { recursive: true })
  const seed = new DatabaseSync(mainOf(origin))
  configureConnection(seed)
  migrate(seed, {}, base)
  seed.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
  insertClient(seed, '00000000-0000-4000-8000-000000000001', 'Ana Ejemplo')
  seed.close()

  const writer = new DatabaseSync(mainOf(origin))
  try {
    writer.exec('PRAGMA wal_autocheckpoint = 0')
    work(writer)
    const target = newFolder()
    mkdirSync(dataDirectory(target), { recursive: true })
    copyFileSync(mainOf(origin), mainOf(target))
    copyFileSync(walOf(origin), walOf(target))
    return target
  } finally {
    writer.close()
  }
}

/** What real SQLite reports for the same two files, on a throwaway copy. */
function sqliteVersion(profile: string): number {
  const copy = newFolder()
  mkdirSync(dataDirectory(copy), { recursive: true })
  copyFileSync(mainOf(profile), mainOf(copy))
  if (existsSync(walOf(profile))) copyFileSync(walOf(profile), walOf(copy))
  const db = new DatabaseSync(mainOf(copy))
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  } finally {
    db.close()
  }
}

function parserVersion(profile: string): number {
  const header = effectiveHeader(mainOf(profile))
  if (!header.ok) throw new Error(`no effective header: ${header.reason}`)
  return header.version
}

/** Nothing about the profile changed and no shared-memory file appeared. */
function expectUntouched(profile: string, before: Record<string, string>): void {
  expect(tree(profile)).toEqual(before)
  expect(existsSync(`${mainOf(profile)}-shm`)).toBe(false)
}

const addRows = (db: DatabaseSync): void => {
  insertClient(db, '00000000-0000-4000-8000-000000000002', 'Bea Ficticia')
  insertClient(db, '00000000-0000-4000-8000-000000000003', 'Cara Imaginaria')
}

describe('(a) header v(N-1), log v(N): an old auto-migrating build crashed after migrating', () => {
  it('reads the version from the log, agrees with SQLite and refuses nothing it should open', () => {
    const profile = crash(previous, (db) => {
      migrate(db, {}, migrations)
      addRows(db)
    })
    const before = tree(profile)
    expect(statSync(walOf(profile)).size).toBeGreaterThan(0)
    expect(parserVersion(profile)).toBe(latest)
    expect(sqliteVersion(profile)).toBe(latest)
    // The main file alone still says N-1: the log is what changes the answer.
    const mainOnly = newFolder()
    mkdirSync(dataDirectory(mainOnly), { recursive: true })
    copyFileSync(mainOf(profile), mainOf(mainOnly))
    expect(parserVersion(mainOnly)).toBe(latest - 1)

    expect(inspectProfile(profile, latest)).toEqual({ kind: 'current', version: latest })
    expect(inspectProfile(profile, latest + 1)).toEqual({ kind: 'migration-required', from: latest, to: latest + 1 })
    expect(inspectProfile(profile, latest - 1)).toEqual({ kind: 'too-new', from: latest, to: latest - 1 })
    expectUntouched(profile, before)

    // A build that needs N-1 refuses before writing anything.
    expect(() => openAppDatabase(profile, { migrations: previous })).toThrow(DatabaseTooNewError)
    expectUntouched(profile, before)
  })

  it('opens at the latest version with every row, applying no migration', () => {
    const profile = crash(previous, (db) => {
      migrate(db, {}, migrations)
      addRows(db)
    })
    const opened = openAppDatabase(profile)
    try {
      expect(opened.migration).toEqual({ from: latest, to: latest })
      const rows = opened.db.prepare('SELECT display_name FROM clients ORDER BY id').all() as { display_name: string }[]
      expect(rows.map((r) => r.display_name)).toEqual(['Ana Ejemplo', 'Bea Ficticia', 'Cara Imaginaria'])
    } finally {
      opened.db.close()
    }
  })
})

describe('(b) header v(N), log v(N+1): a newer build crashed', () => {
  it('is too new for this build and refuses before writing', () => {
    const profile = crash(migrations, (db) => {
      migrate(db, {}, plusOne)
      addRows(db)
    })
    const before = tree(profile)
    expect(parserVersion(profile)).toBe(latest + 1)
    expect(sqliteVersion(profile)).toBe(latest + 1)

    expect(inspectProfile(profile, latest)).toEqual({ kind: 'too-new', from: latest + 1, to: latest })
    expect(inspectProfile(profile, latest + 1)).toEqual({ kind: 'current', version: latest + 1 })
    expect(inspectProfile(profile, latest + 2)).toEqual({ kind: 'migration-required', from: latest + 1, to: latest + 2 })
    expect(() => openAppDatabase(profile)).toThrow(DatabaseTooNewError)
    expectUntouched(profile, before)
  })

  it('opens with a build that has that version, with every row', () => {
    const profile = crash(migrations, (db) => {
      migrate(db, {}, plusOne)
      addRows(db)
    })
    const opened = openAppDatabase(profile, { migrations: plusOne })
    try {
      expect(opened.migration).toEqual({ from: latest + 1, to: latest + 1 })
      expect((opened.db.prepare('SELECT count(*) AS n FROM clients').get() as { n: number }).n).toBe(3)
    } finally {
      opened.db.close()
    }
  })
})

describe('(c) a log with fictional rows and no schema change', () => {
  it('current profile: opens with every row and no migration applied', () => {
    const profile = crash(migrations, addRows)
    expect(statSync(walOf(profile)).size).toBeGreaterThan(0)
    expect(parserVersion(profile)).toBe(latest)
    expect(sqliteVersion(profile)).toBe(latest)
    expect(inspectProfile(profile, latest)).toEqual({ kind: 'current', version: latest })

    const opened = openAppDatabase(profile)
    try {
      expect(opened.migration).toEqual({ from: latest, to: latest })
    } finally {
      opened.db.close()
    }
    expect(names(mainOf(profile))).toEqual(['Ana Ejemplo', 'Bea Ficticia', 'Cara Imaginaria'])
  })

  it('older profile: migration-required, and neither start nor the maintenance command touches it', () => {
    const profile = crash(previous, addRows)
    const before = tree(profile)
    expect(parserVersion(profile)).toBe(latest - 1)
    expect(sqliteVersion(profile)).toBe(latest - 1)
    expect(inspectProfile(profile, latest)).toEqual({ kind: 'migration-required', from: latest - 1, to: latest })

    expect(() => openAppDatabase(profile)).toThrow(MigrationRequiredError)
    expectUntouched(profile, before)
    let code = ''
    try {
      migrateProfile({
        dataDir: profile,
        expectFrom: latest - 1,
        expectTo: latest,
        confirm: confirmationPhrase(latest - 1, latest)
      })
    } catch (error) {
      code = error instanceof MaintenanceError ? error.code : String(error)
    }
    expect(code).toBe('not-cleanly-closed')
    expectUntouched(profile, before)
  })
})

describe('a log that stops being valid', () => {
  /** Two commits in the log: v(N+1) then v(N+2). */
  const twoCommits = (): string => crash(migrations, (db) => migrate(db, {}, plusTwo))

  function flipByte(file: string, offsetFromEnd: number): void {
    const fd = openSync(file, 'r+')
    try {
      const at = statSync(file).size - offsetFromEnd
      const one = Buffer.alloc(1)
      readSync(fd, one, 0, 1, at)
      one[0] = (one[0] ?? 0) ^ 0xff
      writeSync(fd, one, 0, 1, at)
    } finally {
      closeSync(fd)
    }
  }

  it('falls back to the previous commit when the last commit frame is damaged, as SQLite does', () => {
    const intact = twoCommits()
    expect(parserVersion(intact)).toBe(latest + 2)

    const damaged = twoCommits()
    flipByte(walOf(damaged), 100) // inside the last frame (the commit frame)
    expect(parserVersion(damaged)).toBe(latest + 1)
    expect(sqliteVersion(damaged)).toBe(latest + 1)
    expect(inspectProfile(damaged, latest + 1)).toEqual({ kind: 'current', version: latest + 1 })
  })

  it('counts nothing after the last valid commit', () => {
    const profile = twoCommits()
    // Cut the log in the middle of its last frame.
    const bytes = readFileSync(walOf(profile))
    writeFileSync(walOf(profile), bytes.subarray(0, bytes.length - 100))
    expect(parserVersion(profile)).toBe(latest + 1)
    expect(sqliteVersion(profile)).toBe(latest + 1)
  })

  const garbage: [string, (log: string) => void][] = [
    ['an unknown magic number', (log) => writeFileSync(log, Buffer.alloc(64, 7))],
    [
      'a damaged header checksum',
      (log) => {
        flipByte(log, statSync(log).size - 16) // salt-1 inside the 32-byte header
      }
    ],
    ['a truncated header', (log) => writeFileSync(log, readFileSync(log).subarray(0, 20))]
  ]
  for (const [name, damage] of garbage) {
    it(`fails closed on ${name} and writes nothing`, () => {
      const profile = crash(previous, (db) => migrate(db, {}, migrations))
      damage(walOf(profile))
      const before = tree(profile)
      expect(effectiveHeader(mainOf(profile))).toEqual({ ok: false, reason: 'wal-unreadable' })
      expect(inspectProfile(profile, latest)).toEqual({ kind: 'unsafe', reason: 'wal-unreadable' })
      expect(() => openAppDatabase(profile)).toThrow(DataProfileUnsafeError)
      expect(() => openAppDatabase(profile, { migrations: previous })).toThrow(DataProfileUnsafeError)
      expectUntouched(profile, before)
    })
  }

  it('fails closed when the main file is empty but a log exists, because SQLite would discard that log', () => {
    const profile = crash(migrations, addRows)
    writeFileSync(mainOf(profile), '')
    const before = tree(profile)
    expect(inspectProfile(profile, latest)).toEqual({ kind: 'unsafe', reason: 'wal-unreadable' })
    expect(() => openAppDatabase(profile)).toThrow(DataProfileUnsafeError)
    expectUntouched(profile, before)
    // The reason it must not be read as the log's version: SQLite throws the log away.
    expect(sqliteVersion(profile)).toBe(0)
  })
})

describe('a profile whose creation crashed', () => {
  it('resolves through the log when the main file is only a stub', () => {
    const origin = newFolder()
    mkdirSync(dataDirectory(origin), { recursive: true })
    const writer = new DatabaseSync(mainOf(origin))
    let profile: string
    try {
      writer.exec('PRAGMA wal_autocheckpoint = 0')
      configureConnection(writer)
      migrate(writer, {}, migrations)
      writer.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
      insertClient(writer, '00000000-0000-4000-8000-000000000001', 'Ana Ejemplo')
      profile = newFolder()
      mkdirSync(dataDirectory(profile), { recursive: true })
      writeFileSync(mainOf(profile), Buffer.alloc(40)) // too short to hold a header
      copyFileSync(walOf(origin), walOf(profile))
    } finally {
      writer.close()
    }
    expect(parserVersion(profile)).toBe(latest)
    expect(sqliteVersion(profile)).toBe(latest)
    expect(inspectProfile(profile, latest)).toEqual({ kind: 'current', version: latest })
    const opened = openAppDatabase(profile)
    try {
      expect(opened.migration).toEqual({ from: latest, to: latest })
      expect((opened.db.prepare('SELECT count(*) AS n FROM clients').get() as { n: number }).n).toBe(1)
    } finally {
      opened.db.close()
    }
  })
})
