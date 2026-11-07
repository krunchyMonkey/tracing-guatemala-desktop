import {
  type Stats,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { APPLICATION_ID, DATABASE_FILE_NAME, dataDirectory, PROFILE_MARKER_FILE_NAME } from './identity'
import { DatabaseTooNewError, getSchemaVersion, migrate, migrations, type Migration, type MigrationOutcome } from './migrations'
import { DataProfileUnsafeError, inspectProfile, MigrationRequiredError, type PreflightTolerance } from './schema-preflight'

// Driver: Node's built-in node:sqlite (see docs/architecture/client-storage.md for
// the spike). Only this module and the repositories import it, so a driver swap
// stays local to src/main/database.

export { APPLICATION_ID, DATABASE_FILE_NAME, dataDirectory, PROFILE_MARKER_FILE_NAME }

export interface OpenedDatabase {
  db: DatabaseSync
  file: string
  migration: MigrationOutcome
}

export interface OpenOptions {
  /** Kept so callers share one options shape; opening no longer writes anything that needs a clock. */
  now?: () => Date
  /** In-code test seam only: no environment variable, flag or config file may select it. */
  migrations?: readonly Migration[]
  /**
   * Leftovers the caller already knows about (a restore in progress, a maintenance
   * run verifying its own swap). In-code only; everything else still fails closed.
   */
  tolerate?: PreflightTolerance
}

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Records that this profile has held a database, in the profile root next to data/, so a
 * profile whose data/ was deleted is refused instead of replaced by an empty one (#248).
 * Durable and fail closed: fresh temp file, fsync, rename, read back and verify, then a
 * best-effort fsync of the folder. THROWS on any failure. An existing marker file is
 * never rewritten; anything else at the marker path is a failure.
 */
export function writeProfileMarker(userDataDir: string, now: () => Date = () => new Date()): void {
  const marker = join(userDataDir, PROFILE_MARKER_FILE_NAME)
  const temp = `${marker}.tmp`

  const existing = lstatOrNull(marker)
  if (existing !== null) {
    if (existing.isFile()) return
    throw new Error('profile marker path is not a file')
  }

  const stale = lstatOrNull(temp)
  if (stale !== null) {
    if (!stale.isFile()) throw new Error('profile marker temp path is not a file')
    unlinkSync(temp)
  }

  const content = { format: 1, application: 'tracing-guatemala', createdAt: now().toISOString() }
  try {
    const fd = openSync(temp, 'wx')
    try {
      writeSync(fd, JSON.stringify(content))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, marker)
  } catch (error) {
    if (lstatOrNull(temp)?.isFile()) rmSync(temp, { force: true })
    throw error
  }

  let ok: boolean
  try {
    const back = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>
    ok =
      Object.keys(back).length === 3 &&
      back['format'] === content.format &&
      back['application'] === content.application &&
      back['createdAt'] === content.createdAt
  } catch {
    ok = false
  }
  if (!ok) {
    rmSync(marker, { force: true }) // our own just-written file: remove so the next start retries
    throw new Error('profile marker did not read back')
  }

  try {
    const dirFd = openSync(userDataDir, 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch (error) {
    // Windows cannot open or sync a folder; that is the only failure tolerated here.
    if (!['EPERM', 'EISDIR', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
}

function ensureProfileMarker(userDataDir: string, now: (() => Date) | undefined): void {
  try {
    writeProfileMarker(userDataDir, now)
  } catch {
    throw new DataProfileUnsafeError('profile-marker-unwritable')
  }
}

/**
 * Open the app database under `<userData>/data` (#248). A new profile is created at
 * the latest schema. An existing profile is opened only if it is already at the latest
 * schema: an older one throws MigrationRequiredError, a newer one DatabaseTooNewError,
 * and a profile with leftovers or damage DataProfileUnsafeError. Those three are
 * thrown without creating or opening anything read-write. Upgrading an existing
 * profile is the operator's maintenance command (src/server/maintenance).
 */
export function openAppDatabase(userDataDir: string, options: OpenOptions | (() => Date) = {}): OpenedDatabase {
  const resolved: OpenOptions = typeof options === 'function' ? { now: options } : options
  const list = resolved.migrations ?? migrations
  const latest = list.length

  const state = inspectProfile(userDataDir, latest, resolved.tolerate)
  switch (state.kind) {
    case 'migration-required':
      throw new MigrationRequiredError(state.from, state.to)
    case 'too-new':
      throw new DatabaseTooNewError(state.from, state.to)
    case 'unsafe':
      throw new DataProfileUnsafeError(state.reason)
    case 'fresh':
    case 'current':
      break
  }

  // An existing database must have its marker before it is opened read-write; a failure opens nothing.
  if (state.kind === 'current') ensureProfileMarker(userDataDir, resolved.now)

  const dir = dataDirectory(userDataDir)
  if (state.kind === 'fresh') mkdirSync(dir, { recursive: true })
  const file = join(dir, DATABASE_FILE_NAME)

  const db = new DatabaseSync(file)
  try {
    configureConnection(db)
    // For a current profile this is a no-op that re-checks the version we just read.
    const migration = migrate(db, {}, list)
    const row = db.prepare('PRAGMA application_id').get() as { application_id: number }
    if (row.application_id !== APPLICATION_ID) db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    if (getSchemaVersion(db) !== latest) throw new Error('unexpected schema version after open')
    // A new database is served only once its marker exists; if it can't be written the file stays
    // and the next start (now a current profile) retries before opening it.
    if (state.kind === 'fresh') ensureProfileMarker(userDataDir, resolved.now)
    return { db, file, migration }
  } catch (error) {
    db.close()
    throw error
  }
}

export function configureConnection(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA trusted_schema = OFF;
  `)
}
