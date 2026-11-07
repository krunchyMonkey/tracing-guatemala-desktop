import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { APPLICATION_ID, DATABASE_FILE_NAME, dataDirectory } from './identity'
import { DatabaseTooNewError, getSchemaVersion, migrate, migrations, type Migration, type MigrationOutcome } from './migrations'
import { DataProfileUnsafeError, inspectProfile, MigrationRequiredError, type PreflightTolerance } from './schema-preflight'

// Driver: Node's built-in node:sqlite (see docs/architecture/client-storage.md for
// the spike). Only this module and the repositories import it, so a driver swap
// stays local to src/main/database.

export { APPLICATION_ID, DATABASE_FILE_NAME, dataDirectory }

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
