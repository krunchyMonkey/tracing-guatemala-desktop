import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APPLICATION_ID, DATABASE_FILE_NAME, dataDirectory, openAppDatabase } from '../../src/main/database/connection'
import { DatabaseTooNewError, getSchemaVersion, migrate, migrations, type Migration } from '../../src/main/database/migrations'
import {
  DataProfileUnsafeError,
  inspectProfile,
  MigrationRequiredError,
  type UnsafeReason
} from '../../src/main/database/schema-preflight'
import { startupProblemMessage } from '../../src/main/database/startup-messages'
import { acquireDataDirLock, DataDirInUseError, refuseTestHooksOnRealProfile } from '../../src/server/data-dir'
import { runMaintenanceCommand } from '../../src/server/maintenance/cli'
import {
  confirmationPhrase,
  MaintenanceError,
  migrateProfile,
  revertMigration,
  revertPhrase,
  type FaultPoint
} from '../../src/server/maintenance/migrate-database'
import { startLiveServer } from '../../src/server/server'

// #248: a newer build never upgrades an existing profile on start; only the operator's
// maintenance command does, on a verified copy. Everything runs in mkdtemp folders with
// fictional rows. No real profile is ever named.

const latest = migrations.length
const nextMigrations: readonly Migration[] = [
  ...migrations,
  { version: latest + 1, name: 'test_additive', sql: 'CREATE TABLE test_extra (id TEXT PRIMARY KEY) STRICT;' }
]
const fixedNow = () => new Date('2026-11-01T09:00:00.000Z')
const STAMP = '2026-11-01T09-00-00-000Z'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-migsafe-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const live = () => join(dataDirectory(root), DATABASE_FILE_NAME)
const maintenance = (...parts: string[]) => join(dataDirectory(root), 'maintenance', ...parts)
const marker = () => maintenance('migration-in-progress.json')

/** A profile whose schema is exactly `list`, with fictional rows, as a closed rollback-journal file. */
function buildProfile(list: readonly Migration[], where = root): string {
  const dir = dataDirectory(where)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, DATABASE_FILE_NAME)
  const db = new DatabaseSync(file)
  migrate(db, {}, list)
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
  const insert = db.prepare(
    "INSERT INTO clients (id, display_name, source, created_at, updated_at) VALUES (?, ?, 'direct', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
  )
  insert.run('00000000-0000-4000-8000-000000000001', 'Ana Ejemplo')
  insert.run('00000000-0000-4000-8000-000000000002', 'Bea Ficticia')
  db.close()
  return file
}

const buildPrevious = () => buildProfile(migrations.slice(0, -1))
const buildCurrent = () => buildProfile(migrations)

/** sha256 of every file under `dir`, by relative name (directories as "dir"). */
function tree(dir = root): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name)
      if (statSync(full).isDirectory()) {
        out[relative(dir, full)] = 'dir'
        walk(full)
      } else {
        out[relative(dir, full)] = createHash('sha256').update(readFileSync(full)).digest('hex')
      }
    }
  }
  walk(dir)
  return out
}

function codeOf(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    if (error instanceof MaintenanceError) return error.code
    throw error
  }
  throw new Error('expected a MaintenanceError')
}

function clientNames(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare('SELECT display_name FROM clients ORDER BY id').all() as { display_name: string }[]).map((r) => r.display_name)
  } finally {
    db.close()
  }
}

function migrateOptions(extra: Partial<Parameters<typeof migrateProfile>[0]> = {}): Parameters<typeof migrateProfile>[0] {
  return {
    dataDir: root,
    expectFrom: latest - 1,
    expectTo: latest,
    confirm: confirmationPhrase(latest - 1, latest),
    now: fixedNow,
    ...extra
  }
}

function nextOptions(extra: Partial<Parameters<typeof migrateProfile>[0]> = {}): Parameters<typeof migrateProfile>[0] {
  return migrateOptions({
    expectFrom: latest,
    expectTo: latest + 1,
    confirm: confirmationPhrase(latest, latest + 1),
    migrations: nextMigrations,
    ...extra
  })
}

describe('inspectProfile', () => {
  it('is fresh for a missing folder and creates nothing', () => {
    const target = join(root, 'nope')
    expect(inspectProfile(target, latest)).toEqual({ kind: 'fresh' })
    expect(existsSync(target)).toBe(false)
  })

  it('treats a 0-byte database with no log as fresh', () => {
    mkdirSync(dataDirectory(root), { recursive: true })
    writeFileSync(live(), '')
    expect(inspectProfile(root, latest)).toEqual({ kind: 'fresh' })
  })

  it('reports current, migration-required and too-new from the header, writing nothing', () => {
    buildCurrent()
    const before = tree()
    expect(inspectProfile(root, latest)).toEqual({ kind: 'current', version: latest })
    expect(inspectProfile(root, latest + 1)).toEqual({ kind: 'migration-required', from: latest, to: latest + 1 })
    expect(inspectProfile(root, latest - 1)).toEqual({ kind: 'too-new', from: latest, to: latest - 1 })
    expect(tree()).toEqual(before)
  })
})

describe('startup never migrates an existing profile', () => {
  it('refuses a pending migration and changes nothing', () => {
    buildPrevious()
    const before = tree()
    expect(() => openAppDatabase(root)).toThrow(MigrationRequiredError)
    try {
      openAppDatabase(root)
    } catch (error) {
      expect(error).toMatchObject({ from: latest - 1, to: latest })
    }
    expect(tree()).toEqual(before)
    expect(existsSync(join(dataDirectory(root), 'pre-migration'))).toBe(false)
  })

  it('refuses through the Live host, releases the lock and listens on nothing', async () => {
    buildPrevious()
    const staticDir = join(root, 'static-site')
    mkdirSync(staticDir)
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>test</title>')
    const before = tree()
    await expect(
      startLiveServer({ dataDir: root, port: 0, staticDir, appInfo: { name: 'T', version: '0', platform: 'web' }, log: () => {} })
    ).rejects.toThrow(MigrationRequiredError)
    // The lock is free again (acquiring it works) and the profile is untouched.
    acquireDataDirLock(root)()
    expect(tree()).toEqual(before)
  })

  it('refuses data from a newer version', () => {
    buildProfile(nextMigrations)
    const before = tree()
    expect(() => openAppDatabase(root)).toThrow(DatabaseTooNewError)
    expect(tree()).toEqual(before)
  })

  it('initializes a fresh profile at the latest schema without a snapshot', () => {
    const opened = openAppDatabase(root)
    expect(opened.migration).toEqual({ from: 0, to: latest })
    expect(getSchemaVersion(opened.db)).toBe(latest)
    opened.db.close()
    expect(existsSync(maintenance())).toBe(false)
    expect(existsSync(join(dataDirectory(root), 'pre-migration'))).toBe(false)
  })

  it('opens a current profile and adds no files', () => {
    buildCurrent()
    const names = readdirSync(dataDirectory(root))
    const opened = openAppDatabase(root)
    expect(opened.migration).toEqual({ from: latest, to: latest })
    opened.db.close()
    expect(readdirSync(dataDirectory(root))).toEqual(names)
  })

  describe('fails closed on an unsafe profile', () => {
    const unsafe = (reason: UnsafeReason, setup: () => void) => {
      it(reason, () => {
        setup()
        const before = tree()
        expect(() => openAppDatabase(root)).toThrow(DataProfileUnsafeError)
        try {
          openAppDatabase(root)
        } catch (error) {
          expect(error).toMatchObject({ reason })
        }
        expect(tree()).toEqual(before)
      })
    }

    const header = (version: number, appId: number, pageSize = 4096): Buffer => {
      const bytes = Buffer.alloc(512)
      bytes.write('SQLite format 3\u0000', 0, 'latin1')
      bytes.writeUInt16BE(pageSize, 16)
      bytes.writeUInt32BE(version, 60)
      bytes.writeUInt32BE(appId, 68)
      return bytes
    }

    unsafe('restore-interrupted', () => {
      buildCurrent()
      copyFileSync(live(), `${live()}.replaced-0f0f0f0f`)
    })
    unsafe('restore-interrupted', () => {
      // The crash window: the live file is gone and only the .replaced-* file holds the data.
      buildCurrent()
      copyFileSync(live(), `${live()}.replaced-0f0f0f0f`)
      rmSync(live())
    })
    unsafe('migration-interrupted', () => {
      buildCurrent()
      mkdirSync(maintenance(), { recursive: true })
      writeFileSync(marker(), JSON.stringify({ from: latest - 1, to: latest, stamp: STAMP }))
    })
    unsafe('missing-database', () => {
      mkdirSync(join(dataDirectory(root), 'pre-restore'), { recursive: true })
    })
    unsafe('missing-database', () => {
      mkdirSync(dataDirectory(root), { recursive: true })
      writeFileSync(join(dataDirectory(root), 'restore-staging-1.sqlite'), 'x')
    })
    unsafe('not-an-app-database', () => {
      mkdirSync(dataDirectory(root), { recursive: true })
      writeFileSync(live(), 'this is a plain text file, not a database. '.repeat(10))
    })
    unsafe('not-an-app-database', () => {
      mkdirSync(dataDirectory(root), { recursive: true })
      writeFileSync(live(), header(latest, 0x11111111))
    })
    unsafe('not-an-app-database', () => {
      mkdirSync(dataDirectory(root), { recursive: true })
      writeFileSync(live(), header(0, APPLICATION_ID))
    })
    unsafe('unreadable', () => {
      mkdirSync(live(), { recursive: true })
    })
    unsafe('wal-pending', () => {
      // A valid-looking header with a log next to it that SQLite cannot read read-only.
      mkdirSync(dataDirectory(root), { recursive: true })
      writeFileSync(live(), header(latest, APPLICATION_ID, 0))
      writeFileSync(`${live()}-wal`, Buffer.alloc(32, 7))
    })
  })
})

describe('startup messages', () => {
  it('are actionable and path-free', () => {
    const required = startupProblemMessage(new MigrationRequiredError(8, 9))
    expect(required).toContain('schema v8')
    expect(required).toContain('needs v9')
    expect(required).toContain('docs/operations/database-migration.md')
    const restore = startupProblemMessage(new DataProfileUnsafeError('restore-interrupted'))
    expect(restore).toContain('A restore was interrupted. Nothing was changed.')
    for (const reason of ['restore-interrupted', 'migration-interrupted', 'missing-database', 'not-an-app-database', 'unreadable', 'wal-pending'] as const) {
      const message = startupProblemMessage(new DataProfileUnsafeError(reason))
      expect(message).toContain('Nothing was changed')
      expect(message).not.toMatch(/[A-Za-z]:[\\/]|\\/)
    }
    expect(startupProblemMessage(new Error('x'))).toBeNull()
  })
})

describe('migrateProfile', () => {
  it('upgrades a copy, keeps the original and a verified snapshot, then opens strictly', () => {
    const file = buildPrevious()
    const originalBytes = readFileSync(file)

    const report = migrateProfile(migrateOptions())
    expect(report).toMatchObject({ from: latest - 1, to: latest, folder: `maintenance/${STAMP}` })
    expect(report.tables.find((t) => t.table === 'clients')?.rows).toBe(2)
    expect(JSON.stringify(report)).not.toContain(root)

    expect(readFileSync(maintenance(STAMP, `original-v${latest - 1}.sqlite`)).equals(originalBytes)).toBe(true)
    const snapshot = new DatabaseSync(maintenance(STAMP, `snapshot-v${latest - 1}.sqlite`), { readOnly: true })
    expect(getSchemaVersion(snapshot)).toBe(latest - 1)
    snapshot.close()
    expect(clientNames(maintenance(STAMP, `snapshot-v${latest - 1}.sqlite`))).toEqual(['Ana Ejemplo', 'Bea Ficticia'])
    expect(existsSync(maintenance(STAMP, 'migration.json'))).toBe(true)
    expect(existsSync(marker())).toBe(false)
    expect(existsSync(maintenance(STAMP, 'staging.sqlite'))).toBe(false)

    expect(inspectProfile(root, latest)).toEqual({ kind: 'current', version: latest })
    expect(clientNames(file)).toEqual(['Ana Ejemplo', 'Bea Ficticia'])
    const opened = openAppDatabase(root)
    expect(opened.migration).toEqual({ from: latest, to: latest })
    opened.db.close()
  })

  describe('refuses and leaves the live file untouched', () => {
    const refuses = (name: string, code: string, setup: () => Partial<Parameters<typeof migrateProfile>[0]> | void) => {
      it(name, () => {
        const extra = setup() ?? {}
        const before = tree()
        expect(codeOf(() => migrateProfile(migrateOptions(extra)))).toBe(code)
        expect(tree()).toEqual(before)
        expect(existsSync(marker())).toBe(false)
        expect(existsSync(maintenance())).toBe(false)
      })
    }

    refuses('a wrong confirmation phrase', 'not-confirmed', () => {
      buildPrevious()
      return { confirm: 'migrate v1 to v2' }
    })
    refuses('a missing confirmation phrase', 'not-confirmed', () => {
      buildPrevious()
      return { confirm: '' }
    })
    refuses('an unexpected source version', 'version-mismatch', () => {
      buildPrevious()
      return { expectFrom: latest - 2 }
    })
    refuses('an unexpected target version', 'version-mismatch', () => {
      buildPrevious()
      return { expectTo: latest + 1 }
    })
    refuses('a profile that is already current', 'nothing-to-do', () => {
      buildCurrent()
    })
    refuses('data from a newer version', 'too-new', () => {
      buildProfile(nextMigrations)
    })
    refuses('a damaged source', 'source-damaged', () => {
      const file = buildPrevious()
      const bytes = readFileSync(file)
      // Overwrite a whole page inside the file (not the header page).
      bytes.fill(0xff, 4096 * 2, 4096 * 3)
      writeFileSync(file, bytes)
    })
    refuses('a non-empty write-ahead log', 'not-cleanly-closed', () => {
      buildPrevious()
      writeFileSync(`${live()}-wal`, Buffer.alloc(64, 1))
    })
    refuses('a leftover from an interrupted restore', 'unsafe:restore-interrupted', () => {
      buildPrevious()
      copyFileSync(live(), `${live()}.replaced-abc`)
    })

    it('while another host holds the data folder', () => {
      buildPrevious()
      const before = tree()
      const release = acquireDataDirLock(root)
      try {
        expect(() => migrateProfile(migrateOptions())).toThrow(DataDirInUseError)
      } finally {
        release()
      }
      expect(tree()).toEqual(before)
    })

    it('for a folder that does not exist', () => {
      expect(codeOf(() => migrateProfile(migrateOptions({ dataDir: join(root, 'missing') })))).toBe('data-dir-missing')
      expect(existsSync(join(root, 'missing'))).toBe(false)
    })
  })

  describe('with an injected fault', () => {
    for (const point of ['after-marker', 'after-snapshot', 'after-staging', 'after-swap'] as FaultPoint[]) {
      it(`${point}: the live file is intact, the marker is gone, the snapshot is kept`, () => {
        const file = buildCurrent()
        const originalBytes = readFileSync(file)
        expect(() => migrateProfile(nextOptions({ faultAt: point }))).toThrow(/injected fault/)

        expect(readFileSync(file).equals(originalBytes)).toBe(true)
        expect(existsSync(marker())).toBe(false)
        expect(existsSync(maintenance(STAMP, 'staging.sqlite'))).toBe(false)
        expect(existsSync(maintenance(STAMP, `snapshot-v${latest}.sqlite`))).toBe(point !== 'after-marker')
        expect(existsSync(`${file}-wal`)).toBe(false)
        expect(inspectProfile(root, latest)).toEqual({ kind: 'current', version: latest })
        // A later attempt works: the failed one left nothing in the way.
        const report = migrateProfile(nextOptions())
        expect(report.folder).toBe(`maintenance/${STAMP}-2`)
      })
    }

    it('after a swap that cannot be undone: the marker stays and startup fails closed', () => {
      const file = buildCurrent()
      const originalBytes = readFileSync(file)
      expect(() => migrateProfile(nextOptions({ faultAt: 'after-swap-unrecoverable' }))).toThrow(/injected fault/)

      expect(existsSync(marker())).toBe(true)
      expect(readFileSync(maintenance(STAMP, `original-v${latest}.sqlite`)).equals(originalBytes)).toBe(true)
      expect(() => openAppDatabase(root)).toThrow(DataProfileUnsafeError)
      expect(inspectProfile(root, latest + 1)).toEqual({ kind: 'unsafe', reason: 'migration-interrupted' })
      // A new maintenance run refuses too, until the operator has looked.
      expect(codeOf(() => migrateProfile(nextOptions()))).toBe('unsafe:migration-interrupted')
    })

    it('a migration that changes stored rows is refused before the swap', () => {
      const file = buildCurrent()
      const originalBytes = readFileSync(file)
      const rewriting: readonly Migration[] = [
        ...migrations,
        { version: latest + 1, name: 'test_rewrite', sql: "UPDATE clients SET display_name = 'Changed' WHERE id = '00000000-0000-4000-8000-000000000001';" }
      ]
      expect(codeOf(() => migrateProfile(nextOptions({ migrations: rewriting })))).toBe('content-changed')
      expect(readFileSync(file).equals(originalBytes)).toBe(true)
      expect(existsSync(marker())).toBe(false)
      expect(existsSync(maintenance(STAMP, `snapshot-v${latest}.sqlite`))).toBe(true)
    })
  })
})

describe('revertMigration', () => {
  it('puts the original back, keeps it, and says to use the old version', () => {
    const file = buildCurrent()
    const originalBytes = readFileSync(file)
    migrateProfile(nextOptions())
    expect(inspectProfile(root, latest + 1)).toEqual({ kind: 'current', version: latest + 1 })

    const report = revertMigration({ dataDir: root, confirm: revertPhrase(latest, latest + 1), now: fixedNow })
    expect(report).toMatchObject({ from: latest, to: latest + 1, folder: `maintenance/${STAMP}` })
    expect(report.note).toContain('previous app version')
    expect(JSON.stringify(report)).not.toContain(root)

    expect(readFileSync(file).equals(originalBytes)).toBe(true)
    expect(existsSync(maintenance(STAMP, `original-v${latest}.sqlite`))).toBe(true)
    expect(existsSync(maintenance(STAMP, `reverted-v${latest + 1}.sqlite`))).toBe(true)
    expect(existsSync(maintenance(STAMP, 'reverted.json'))).toBe(true)
    // The old version opens it; the newer one refuses it again.
    expect(inspectProfile(root, latest)).toEqual({ kind: 'current', version: latest })
    expect(() => openAppDatabase(root, { migrations: nextMigrations })).toThrow(MigrationRequiredError)
    // Nothing left to revert.
    expect(codeOf(() => revertMigration({ dataDir: root, confirm: revertPhrase(latest, latest + 1) }))).toBe('nothing-to-revert')
  })

  it('is refused after a write to the migrated data', () => {
    buildCurrent()
    migrateProfile(nextOptions())
    const opened = openAppDatabase(root, { migrations: nextMigrations })
    opened.db.prepare("INSERT INTO test_extra (id) VALUES ('written-after')").run()
    opened.db.close()
    const before = tree()

    expect(codeOf(() => revertMigration({ dataDir: root, confirm: revertPhrase(latest, latest + 1) }))).toBe('changed-since-migration')
    expect(tree()).toEqual(before)
  })

  it('is refused with the wrong phrase and changes nothing', () => {
    buildCurrent()
    migrateProfile(nextOptions())
    const before = tree()
    expect(codeOf(() => revertMigration({ dataDir: root, confirm: 'REVERT' }))).toBe('not-confirmed')
    expect(tree()).toEqual(before)
  })
})

describe('maintenance command line', () => {
  function io(isTTY: boolean, answer = '') {
    const lines: string[] = []
    const errors: string[] = []
    return {
      lines,
      errors,
      io: {
        isTTY,
        log: (m: string) => lines.push(m),
        error: (m: string) => errors.push(m),
        prompt: async (q: string) => {
          lines.push(q)
          return answer
        }
      }
    }
  }
  const args = (extra: Partial<Parameters<typeof runMaintenanceCommand>[0]> = {}): Parameters<typeof runMaintenanceCommand>[0] => ({
    migrate: true,
    revert: false,
    dataDir: root,
    expectFrom: String(latest),
    expectTo: String(latest + 1),
    confirm: undefined,
    ...extra
  })

  it('needs an explicit data folder', async () => {
    const { io: terminal, errors } = io(true)
    expect(await runMaintenanceCommand(args({ dataDir: undefined }), terminal)).toBe(1)
    expect(errors.join(' ')).toContain('--data-dir')
  })

  it('refuses without --confirm when not on a terminal', async () => {
    buildCurrent()
    const before = tree()
    const { io: terminal } = io(false)
    expect(await runMaintenanceCommand(args(), terminal, { migrations: nextMigrations })).toBe(1)
    expect(tree()).toEqual(before)
  })

  it('shows counts, asks for the phrase and migrates', async () => {
    buildCurrent()
    const { io: terminal, lines, errors } = io(true, confirmationPhrase(latest, latest + 1))
    expect(await runMaintenanceCommand(args(), terminal, { migrations: nextMigrations, now: fixedNow })).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('clients: 2')
    expect(output).toContain(`maintenance/${STAMP}/`)
    expect(output).not.toContain(root)
    expect(output).not.toContain('Ana Ejemplo')
    expect(errors).toEqual([])
  })

  it('exits 1 on a wrong phrase', async () => {
    buildCurrent()
    const { io: terminal, errors } = io(true, 'nope')
    expect(await runMaintenanceCommand(args(), terminal, { migrations: nextMigrations })).toBe(1)
    expect(errors.join(' ')).toContain('Nothing was changed')
  })
})

describe('test hooks cannot touch a real profile', () => {
  it('refuses the default Live and desktop folders when TG_TEST_HOOKS=1, and only then', () => {
    const where = { platform: 'linux' as const, env: { XDG_CONFIG_HOME: root }, home: root }
    const live = join(root, 'Tracing Guatemala Web')
    const desktop = join(root, 'Tracing Guatemala')
    const hooks = { TG_TEST_HOOKS: '1' }
    expect(refuseTestHooksOnRealProfile(live, hooks, where).ok).toBe(false)
    expect(refuseTestHooksOnRealProfile(desktop, hooks, where).ok).toBe(false)
    expect(refuseTestHooksOnRealProfile(join(root, 'scratch'), hooks, where).ok).toBe(true)
    expect(refuseTestHooksOnRealProfile(live, {}, where).ok).toBe(true)
  })

  it('also refuses a link that points at them', () => {
    const where = { platform: 'linux' as const, env: { XDG_CONFIG_HOME: root }, home: root }
    const live = join(root, 'Tracing Guatemala Web')
    mkdirSync(live)
    const alias = join(root, 'alias')
    try {
      symlinkSync(live, alias, 'junction')
    } catch {
      return // links are not allowed here
    }
    expect(refuseTestHooksOnRealProfile(alias, { TG_TEST_HOOKS: '1' }, where).ok).toBe(false)
  })
})
