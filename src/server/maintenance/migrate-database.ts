import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { configureConnection, openAppDatabase, writeProfileMarker } from '../../main/database/connection'
import { APPLICATION_ID, DATABASE_FILE_NAME, dataDirectory } from '../../main/database/identity'
import { getSchemaVersion, migrate, migrations as defaultMigrations, type Migration } from '../../main/database/migrations'
import { DataProfileUnsafeError, inspectProfile, MIGRATION_MARKER_RELATIVE, walSize, type UnsafeReason } from '../../main/database/schema-preflight'
import { acquireDataDirLock, checkLiveDataDir } from '../data-dir'
import { computeManifest, manifestsEqual, rowCounts, tableDigest, userTables, type Manifest } from './manifest'

// The operator's maintenance command for upgrading an existing profile (#248). The
// app itself never migrates an existing database on start: a newer build refuses
// with MigrationRequiredError. This module upgrades a verified copy and only then
// swaps it in, keeping the original and a verified snapshot. See
// docs/operations/database-migration.md.
//
// Everything here works inside the profile's own folder. Reports and errors carry
// versions, counts and relative names (maintenance/<stamp>/...) only: never an
// absolute path and never row content.

export type MaintenanceCode =
  | 'data-dir-missing'
  | 'data-dir-refused'
  | 'nothing-to-do'
  | 'version-mismatch'
  | 'too-new'
  | 'not-cleanly-closed'
  | 'in-use'
  | 'changed-during-migration'
  | 'not-confirmed'
  | 'source-damaged'
  | 'snapshot-unverified'
  | 'staging-failed'
  | 'content-changed'
  | 'swap-failed'
  | 'verify-failed'
  | 'marker-unwritable'
  | 'nothing-to-revert'
  | 'original-missing'
  | 'changed-since-migration'
  | 'revert-failed'
  | `unsafe:${UnsafeReason}`

const MESSAGES: Record<string, string> = {
  'data-dir-missing': 'The data folder does not exist. Nothing was changed.',
  'data-dir-refused': 'That folder cannot be used by the web app. Nothing was changed.',
  'nothing-to-do': 'The data is already at the version this build needs (or is new). Nothing was changed.',
  'version-mismatch': 'The data is at a different version than expected. Nothing was changed.',
  'too-new': 'The data was saved by a newer version than this build. Nothing was changed.',
  'not-cleanly-closed':
    'The data was not closed cleanly. Start and stop the current app version once, then try again. Nothing was changed.',
  'in-use': 'Another program has this data open. Stop every copy of the app, then try again. Nothing was changed.',
  'changed-during-migration':
    'The data changed while the migration was running. The live data was not changed by the migration; the snapshot was kept.',
  'not-confirmed': 'The confirmation phrase did not match. Nothing was changed.',
  'source-damaged': 'The data failed its integrity check. Nothing was changed.',
  'snapshot-unverified': 'The snapshot could not be verified. The live data was not changed; the snapshot was kept.',
  'staging-failed': 'The upgraded copy could not be made. The live data was not changed; the snapshot was kept.',
  'content-changed': 'The upgrade would have changed stored rows. The live data was not changed; the snapshot was kept.',
  'swap-failed': 'The upgraded copy could not be put in place. See docs/operations/database-migration.md.',
  'verify-failed': 'The upgraded data failed verification. See docs/operations/database-migration.md.',
  'marker-unwritable':
    'The app could not record that this data folder is in use. Check that the folder is writable, then try again. Nothing was deleted.',
  'nothing-to-revert': 'There is no completed migration to revert. Nothing was changed.',
  'original-missing': 'The preserved original is missing. Nothing was changed.',
  'changed-since-migration':
    'The data changed after the migration, so reverting would lose those changes. Nothing was changed. See docs/operations/database-migration.md.',
  'revert-failed': 'The revert failed verification and the migrated data was put back.'
}

/** A maintenance command refused or failed. Carries a code and a fixed message: no paths, no content. */
export class MaintenanceError extends Error {
  constructor(readonly code: MaintenanceCode) {
    super(
      code.startsWith('unsafe:')
        ? `The data folder is not safe to change (${code.slice(7)}). Nothing was changed.`
        : (MESSAGES[code] ?? code)
    )
    this.name = 'MaintenanceError'
  }
}

export type FaultPoint =
  | 'before-swap-write'
  | 'after-marker'
  | 'after-snapshot'
  | 'after-staging'
  | 'after-swap'
  | 'after-swap-unrecoverable'
  | 'after-swap-mutate-original'

/** Test-only. The `crash` flavor skips every cleanup, as if the process had been killed. */
class InjectedFault extends Error {
  constructor(
    readonly point: FaultPoint,
    readonly crash: boolean
  ) {
    super(`injected fault ${point}`)
    this.name = 'InjectedFault'
  }
}

export const confirmationPhrase = (from: number, to: number): string => `MIGRATE v${from} TO v${to}`
export const revertPhrase = (from: number, to: number): string => `REVERT v${to} TO v${from}`

export interface MigrationReport {
  from: number
  to: number
  stamp: string
  /** Relative to the data folder, e.g. maintenance/<stamp>. */
  folder: string
  tables: { table: string; rows: number }[]
}

export interface RevertReport {
  from: number
  to: number
  stamp: string
  folder: string
  /** The older app version must be used from now on: this build refuses the reverted data. */
  note: string
}

export interface MigrationPlan {
  from: number
  to: number
  tables: { table: string; rows: number }[]
}

export interface RevertPlan {
  from: number
  to: number
  stamp: string
}

interface MigrationRecord {
  from: number
  to: number
  stamp: string
  completedAt: string
  sourceManifest: Manifest
  migratedManifest: Manifest
}

const maintenanceDirOf = (dataDir: string): string => join(dataDirectory(dataDir), 'maintenance')
const liveFileOf = (dataDir: string): string => join(dataDirectory(dataDir), DATABASE_FILE_NAME)
const stamped = (date: Date): string => date.toISOString().replace(/[:.]/g, '-')

function withLockedProfile<T>(dataDir: string, work: () => T): T {
  if (!existsSync(dataDir)) throw new MaintenanceError('data-dir-missing')
  if (!checkLiveDataDir(dataDir).ok) throw new MaintenanceError('data-dir-refused')
  const release = acquireDataDirLock(dataDir) // the lock Live holds: DataDirInUseError while it runs
  try {
    return work()
  } finally {
    release()
  }
}

function removeSideFiles(file: string, which: ('-wal' | '-shm')[] = ['-wal', '-shm']): void {
  for (const suffix of which) rmSync(`${file}${suffix}`, { force: true })
}

/** After read-only opens: drop a leftover -shm and an empty -wal. Only called with the lock held and nothing open. */
function tidySideFiles(file: string): void {
  if (walSize(file) === 0) removeSideFiles(file)
}

/**
 * Evidence (not proof) that no other connection has the file open: a probe asks for the
 * exclusive lock without waiting. Writes nothing. Side files are tidied only when it passes,
 * because a holder may be using them.
 */
function assertNoOtherConnections(file: string): void {
  let probe: DatabaseSync | null = null
  let busy = false
  try {
    probe = new DatabaseSync(file)
    probe.exec('PRAGMA busy_timeout = 0')
    probe.exec('PRAGMA locking_mode = EXCLUSIVE')
    probe.exec('BEGIN EXCLUSIVE')
    probe.exec('ROLLBACK')
  } catch (error) {
    const code = (error as { errcode?: number }).errcode
    busy = (typeof code === 'number' && [5, 6].includes(code & 0xff)) || /locked|busy/i.test((error as Error).message)
    if (!busy) {
      closeQuietly(probe)
      throw new MaintenanceError('source-damaged')
    }
  }
  closeQuietly(probe)
  if (busy) throw new MaintenanceError('in-use')
  tidySideFiles(file)
}

/** Test-only (faultAt 'before-swap-write'): another connection writes a fictional row. */
function injectForeignWrite(file: string): void {
  const db = new DatabaseSync(file)
  try {
    db.exec(
      "INSERT INTO clients (id, display_name, source, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000000aa', 'Cara Injectada', 'direct', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    )
  } finally {
    db.close()
  }
}

/**
 * Test-only (faultAt 'after-swap-mutate-original'): change one character of a fictional name in the
 * preserved original, then put its modification time back, so only a content check can notice.
 */
function mutateOriginal(original: string): void {
  const before = statSync(original)
  const db = new DatabaseSync(original)
  try {
    db.exec("UPDATE clients SET display_name = 'Ana Ejemplp' WHERE id = '00000000-0000-4000-8000-000000000001'")
  } finally {
    db.close()
  }
  utimesSync(original, before.atime, before.mtime)
}

function isHealthy(db: DatabaseSync): boolean {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') return false
    return db.prepare('PRAGMA foreign_key_check').all().length === 0
  } catch {
    return false
  }
}

function closeQuietly(db: DatabaseSync | null): void {
  try {
    db?.close()
  } catch {
    // Already closed.
  }
}

function uniqueStamp(maintenanceDir: string, now: Date): string {
  const base = stamped(now)
  let candidate = base
  for (let n = 2; existsSync(join(maintenanceDir, candidate)); n += 1) candidate = `${base}-${n}`
  return candidate
}

function requireMigrationRequired(dataDir: string, list: readonly Migration[]): { from: number; to: number } {
  const state = inspectProfile(dataDir, list.length)
  const wal = walSize(liveFileOf(dataDir)) > 0
  if (wal && (state.kind === 'migration-required' || (state.kind === 'unsafe' && state.reason === 'wal-unreadable'))) {
    throw new MaintenanceError('not-cleanly-closed')
  }
  if (state.kind === 'unsafe') throw new MaintenanceError(`unsafe:${state.reason}`)
  if (state.kind === 'too-new') throw new MaintenanceError('too-new')
  if (state.kind !== 'migration-required') throw new MaintenanceError('nothing-to-do')
  return { from: state.from, to: state.to }
}

/** What a migration would do, from a read-only look. Counts only. */
export function planMigration({
  dataDir,
  migrations = defaultMigrations
}: {
  dataDir: string
  migrations?: readonly Migration[]
}): MigrationPlan {
  return withLockedProfile(dataDir, () => {
    const { from, to } = requireMigrationRequired(dataDir, migrations)
    const live = liveFileOf(dataDir)
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(live, { readOnly: true })
      const open = db
      const tables = userTables(open).map(({ name }) => ({
        table: name,
        rows: (open.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number }).n
      }))
      return { from, to, tables }
    } catch {
      throw new MaintenanceError('source-damaged')
    } finally {
      closeQuietly(db)
      tidySideFiles(live)
    }
  })
}

export interface MigrateOptions {
  /** The profile folder (the same folder the web host takes with --data-dir). */
  dataDir: string
  expectFrom: number
  expectTo: number
  confirm: string
  now?: () => Date
  /** In-code test seam only. */
  migrations?: readonly Migration[]
  /** Test-only fault injection. */
  faultAt?: FaultPoint
}

export function migrateProfile(options: MigrateOptions): MigrationReport {
  const { dataDir, expectFrom, expectTo, confirm, faultAt } = options
  const now = options.now ?? (() => new Date())
  const list = options.migrations ?? defaultMigrations
  const fault = (point: FaultPoint): void => {
    if (faultAt === point) throw new InjectedFault(point, false)
  }

  return withLockedProfile(dataDir, () => {
    const live = liveFileOf(dataDir)
    const { from, to } = requireMigrationRequired(dataDir, list)
    if (from !== expectFrom || to !== expectTo) throw new MaintenanceError('version-mismatch')
    if (confirm !== confirmationPhrase(from, to)) throw new MaintenanceError('not-confirmed')
    assertNoOtherConnections(live)

    // d. Read-only look at the source: it must be healthy before anything is written.
    let source: DatabaseSync | null = null
    let sourceManifest: Manifest
    let fingerprint: { size: number; mtimeMs: number }
    try {
      source = new DatabaseSync(live, { readOnly: true })
      if (!isHealthy(source)) throw new MaintenanceError('source-damaged')
      sourceManifest = computeManifest(source)
      fingerprint = statSync(live)
    } catch (error) {
      closeQuietly(source)
      tidySideFiles(live)
      throw error instanceof MaintenanceError ? error : new MaintenanceError('source-damaged')
    }

    // e. The marker: from here a crash makes startup fail closed until the operator looks.
    const maintenanceDir = maintenanceDirOf(dataDir)
    const markerFile = join(dataDirectory(dataDir), MIGRATION_MARKER_RELATIVE)
    let stamp: string
    try {
      mkdirSync(maintenanceDir, { recursive: true })
      stamp = uniqueStamp(maintenanceDir, now())
      writeFileSync(markerFile, JSON.stringify({ from, to, stamp }), { flag: 'wx' })
    } catch {
      closeQuietly(source)
      tidySideFiles(live)
      throw new MaintenanceError('swap-failed')
    }
    const stampDir = join(maintenanceDir, stamp)
    const snapshot = join(stampDir, `snapshot-v${from}.sqlite`)
    const staging = join(stampDir, 'staging.sqlite')
    const original = join(stampDir, `original-v${from}.sqlite`)
    const failedFile = join(stampDir, `failed-v${to}.sqlite`)

    let originalMoved = false
    let failClosed = false
    let newInPlace = false
    try {
      mkdirSync(stampDir)
      fault('after-marker')

      // f. Snapshot from the read-only connection, then prove it matches.
      try {
        source.prepare('VACUUM INTO ?').run(snapshot)
      } finally {
        closeQuietly(source)
        source = null
      }
      tidySideFiles(live)
      const snap = new DatabaseSync(snapshot)
      try {
        snap.exec('PRAGMA journal_mode = DELETE')
      } finally {
        snap.close()
      }
      let verified = false
      let check: DatabaseSync | null = null
      try {
        check = new DatabaseSync(snapshot, { readOnly: true })
        verified = isHealthy(check) && getSchemaVersion(check) === from && manifestsEqual(computeManifest(check), sourceManifest)
      } catch {
        verified = false
      } finally {
        closeQuietly(check)
      }
      if (!verified) throw new MaintenanceError('snapshot-unverified')
      fault('after-snapshot')

      // g. Upgrade a copy of the snapshot; the live file is untouched.
      copyFileSync(snapshot, staging)
      let migratedManifest: Manifest
      const upgraded = new DatabaseSync(staging)
      try {
        configureConnection(upgraded)
        migrate(upgraded, {}, list)
        upgraded.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
        if (!isHealthy(upgraded)) throw new MaintenanceError('staging-failed')
        // The additive-migration invariant: every source table keeps every source column's content.
        for (const [table, entry] of Object.entries(sourceManifest)) {
          let after
          try {
            after = tableDigest(upgraded, table, entry.columns)
          } catch {
            throw new MaintenanceError('content-changed')
          }
          if (after.rows !== entry.rows || after.sha256 !== entry.sha256) throw new MaintenanceError('content-changed')
        }
        migratedManifest = computeManifest(upgraded)
      } finally {
        upgraded.close()
      }
      removeSideFiles(staging)
      fault('after-staging')

      // h. Swap. The original is moved, never deleted. First: nobody else has the file open,
      // and it is still exactly what step d read (size, mtime, no log, same fingerprints).
      if (faultAt === 'before-swap-write') injectForeignWrite(live)
      assertNoOtherConnections(live)
      let unchanged = false
      try {
        const current = statSync(live)
        if (current.size === fingerprint.size && current.mtimeMs === fingerprint.mtimeMs && !existsSync(`${live}-wal`)) {
          const recheck = new DatabaseSync(live, { readOnly: true })
          try {
            unchanged = manifestsEqual(computeManifest(recheck), sourceManifest)
          } finally {
            closeQuietly(recheck)
          }
          tidySideFiles(live)
        }
      } catch {
        unchanged = false
      }
      if (!unchanged) throw new MaintenanceError('changed-during-migration')
      const swapFingerprint = statSync(live)
      renameSync(live, original)
      originalMoved = true
      if (existsSync(`${live}-shm`)) renameSync(`${live}-shm`, `${original}-shm`)
      removeSideFiles(live, ['-wal']) // empty: checked above
      try {
        renameSync(staging, live)
        newInPlace = true
      } catch {
        throw new MaintenanceError('swap-failed')
      }
      if (faultAt === 'after-swap-mutate-original') mutateOriginal(original)
      if (faultAt === 'after-swap-unrecoverable') throw new InjectedFault('after-swap-unrecoverable', true)
      fault('after-swap')

      // i. The strict open must now call it current.
      const after = inspectProfile(dataDir, list.length, { migrationMarker: true })
      if (after.kind !== 'current' || after.version !== to) throw new MaintenanceError('verify-failed')
      let reopened: ReturnType<typeof openAppDatabase>
      try {
        reopened = openAppDatabase(dataDir, { migrations: list, tolerate: { migrationMarker: true } })
      } catch (error) {
        if (error instanceof DataProfileUnsafeError && error.reason === 'profile-marker-unwritable') throw new MaintenanceError('marker-unwritable')
        throw error
      }
      try {
        if (!manifestsEqual(computeManifest(reopened.db), migratedManifest)) throw new MaintenanceError('verify-failed')
      } finally {
        reopened.db.close()
      }

      // The moved original must be exactly what was swapped out: nothing may still be writing to it.
      let originalIntact = false
      try {
        const kept = statSync(original)
        originalIntact = kept.size === swapFingerprint.size && kept.mtimeMs === swapFingerprint.mtimeMs && !existsSync(`${original}-wal`)
      } catch {
        originalIntact = false
      }
      if (!originalIntact) {
        failClosed = true // no auto-repair: the marker stays and startup refuses
        throw new MaintenanceError('verify-failed')
      }

      // ...and by content: the preserved original must still read as exactly the source we fingerprinted.
      let originalContentOk = false
      let kept: DatabaseSync | null = null
      try {
        kept = new DatabaseSync(original, { readOnly: true })
        originalContentOk = isHealthy(kept) && manifestsEqual(computeManifest(kept), sourceManifest)
      } catch {
        originalContentOk = false
      } finally {
        closeQuietly(kept)
        try {
          tidySideFiles(original)
        } catch {
          // Leftover side files only; the verdict below stands.
        }
      }
      if (!originalContentOk) {
        failClosed = true // nothing is renamed back, repaired or deleted: the marker stays for a human
        throw new MaintenanceError('verify-failed')
      }

      // j. The profile marker (fail closed), local record, then the in-progress marker goes.
      try {
        writeProfileMarker(dataDir, now)
      } catch {
        throw new MaintenanceError('marker-unwritable')
      }
      const record: MigrationRecord = { from, to, stamp, completedAt: now().toISOString(), sourceManifest, migratedManifest }
      writeFileSync(join(stampDir, 'migration.json'), JSON.stringify(record, null, 2))
      rmSync(markerFile, { force: true })
      return { from, to, stamp, folder: `maintenance/${stamp}`, tables: rowCounts(sourceManifest) }
    } catch (error) {
      if ((error instanceof InjectedFault && error.crash) || failClosed) throw error // simulated kill / no auto-repair: leave everything as it is
      closeQuietly(source)
      let keepMarker = false
      try {
        if (newInPlace) {
          renameSync(live, failedFile)
          removeSideFiles(live)
          newInPlace = false
        }
        if (originalMoved) {
          renameSync(original, live)
          if (existsSync(`${original}-shm`)) renameSync(`${original}-shm`, `${live}-shm`)
          originalMoved = false
        }
      } catch {
        // The original could not be put back: leave the marker so startup fails closed.
        keepMarker = true
      }
      removeSideFiles(staging, ['-wal', '-shm'])
      rmSync(staging, { force: true })
      if (!keepMarker) rmSync(markerFile, { force: true })
      throw error
    }
  })
}

function findRevertable(dataDir: string): { stamp: string; record: MigrationRecord } | null {
  const maintenanceDir = maintenanceDirOf(dataDir)
  let names: string[]
  try {
    names = readdirSync(maintenanceDir)
  } catch {
    return null
  }
  for (const stamp of names.sort().reverse()) {
    const recordFile = join(maintenanceDir, stamp, 'migration.json')
    if (!existsSync(recordFile) || existsSync(join(maintenanceDir, stamp, 'reverted.json'))) continue
    try {
      const record = JSON.parse(readFileSync(recordFile, 'utf8')) as MigrationRecord
      if (Number.isInteger(record.from) && Number.isInteger(record.to)) return { stamp, record }
    } catch {
      // An unreadable record is not revertable.
    }
  }
  return null
}

/** Which migration a revert would undo. Versions only. */
export function planRevert({ dataDir }: { dataDir: string }): RevertPlan {
  return withLockedProfile(dataDir, () => {
    const found = findRevertable(dataDir)
    if (!found) throw new MaintenanceError('nothing-to-revert')
    return { from: found.record.from, to: found.record.to, stamp: found.stamp }
  })
}

export function revertMigration({
  dataDir,
  confirm,
  now = () => new Date()
}: {
  dataDir: string
  confirm: string
  now?: () => Date
}): RevertReport {
  return withLockedProfile(dataDir, () => {
    const found = findRevertable(dataDir)
    if (!found) throw new MaintenanceError('nothing-to-revert')
    const { stamp, record } = found
    const { from, to } = record
    const live = liveFileOf(dataDir)
    const stampDir = join(maintenanceDirOf(dataDir), stamp)
    const original = join(stampDir, `original-v${from}.sqlite`)

    const state = inspectProfile(dataDir, to)
    if (state.kind === 'unsafe') throw new MaintenanceError(`unsafe:${state.reason}`)
    if (state.kind !== 'current') throw new MaintenanceError('version-mismatch')
    if (walSize(live) > 0) throw new MaintenanceError('not-cleanly-closed')
    if (!existsSync(original)) throw new MaintenanceError('original-missing')
    assertNoOtherConnections(live)

    let db: DatabaseSync | null = null
    let unchanged: boolean
    try {
      db = new DatabaseSync(live, { readOnly: true })
      unchanged = manifestsEqual(computeManifest(db), record.migratedManifest)
    } catch {
      unchanged = false
    } finally {
      closeQuietly(db)
      tidySideFiles(live)
    }
    if (!unchanged) throw new MaintenanceError('changed-since-migration')
    if (confirm !== revertPhrase(from, to)) throw new MaintenanceError('not-confirmed')

    assertNoOtherConnections(live)
    const reverted = join(stampDir, `reverted-v${to}.sqlite`)
    const temp = join(dataDirectory(dataDir), `${DATABASE_FILE_NAME}.revert-${stamp}.tmp`)
    renameSync(live, reverted)
    removeSideFiles(live)
    const putBack = (): void => {
      rmSync(temp, { force: true })
      rmSync(live, { force: true })
      removeSideFiles(live)
      renameSync(reverted, live)
    }
    try {
      copyFileSync(original, temp)
      renameSync(temp, live)
    } catch {
      putBack()
      throw new MaintenanceError('revert-failed')
    }

    let ok = false
    let check: DatabaseSync | null = null
    try {
      const after = inspectProfile(dataDir, from)
      if (after.kind === 'current' && after.version === from) {
        check = new DatabaseSync(live, { readOnly: true })
        ok = isHealthy(check) && manifestsEqual(computeManifest(check), record.sourceManifest)
      }
    } catch {
      ok = false
    } finally {
      closeQuietly(check)
      tidySideFiles(live)
    }
    if (!ok) {
      putBack()
      throw new MaintenanceError('revert-failed')
    }

    writeFileSync(join(stampDir, 'reverted.json'), JSON.stringify({ from, to, stamp, revertedAt: now().toISOString() }, null, 2))
    return {
      from,
      to,
      stamp,
      folder: `maintenance/${stamp}`,
      note: `The data is back at schema v${from}. Use the previous app version now: this build will refuse it until it is migrated again.`
    }
  })
}
