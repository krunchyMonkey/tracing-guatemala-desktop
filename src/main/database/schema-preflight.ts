import { type Stats, closeSync, existsSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { APPLICATION_ID, DATABASE_FILE_NAME, dataDirectory } from './identity'

// A look at a data profile that never changes it (#248). Startup runs this before
// anything is created or opened read-write, so a newer build can't silently upgrade
// an existing profile, and a profile with leftovers from an interrupted restore or
// migration fails closed instead of being replaced by a fresh empty database.
// Errors carry a reason code only: no paths and no stored content.

export type UnsafeReason =
  | 'restore-interrupted'
  | 'migration-interrupted'
  | 'missing-database'
  | 'not-an-app-database'
  | 'unreadable'
  | 'wal-pending'

export type ProfileState =
  | { kind: 'fresh' }
  | { kind: 'current'; version: number }
  | { kind: 'migration-required'; from: number; to: number }
  | { kind: 'too-new'; from: number; to: number }
  | { kind: 'unsafe'; reason: UnsafeReason }

/** The data was saved by an older schema; it is only upgraded by the operator's maintenance command. */
export class MigrationRequiredError extends Error {
  constructor(
    readonly from: number,
    readonly to: number
  ) {
    super(`Data is at schema version ${from}; this version needs ${to}. Nothing was changed.`)
    this.name = 'MigrationRequiredError'
  }
}

/** The profile has leftovers or damage that make opening it unsafe. Nothing was changed. */
export class DataProfileUnsafeError extends Error {
  constructor(readonly reason: UnsafeReason) {
    super(`The data folder is not safe to open: ${reason}. Nothing was changed.`)
    this.name = 'DataProfileUnsafeError'
  }
}

/** Leftovers the caller knows about and accepts (the restore in progress, a maintenance run verifying its own result). */
export interface PreflightTolerance {
  /** File name (inside the data directory) of the `.replaced-*` file of a restore that is still running. */
  replacedFile?: string
  /** The migration-in-progress marker of the maintenance run that is verifying its own swap. */
  migrationMarker?: boolean
}

export const MIGRATION_MARKER_RELATIVE = join('maintenance', 'migration-in-progress.json')

const MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1')
const HEADER_BYTES = 100
const USER_VERSION_OFFSET = 60
const APPLICATION_ID_OFFSET = 68

function statOf(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Size in bytes of the write-ahead log next to `file`, or 0 if there is none. */
export function walSize(file: string): number {
  try {
    return statOf(`${file}-wal`)?.size ?? 0
  } catch {
    return 1 // can't tell: treat as non-empty
  }
}

export function inspectProfile(userDataDir: string, latest: number, tolerate: PreflightTolerance = {}): ProfileState {
  const dir = dataDirectory(userDataDir)
  const file = join(dir, DATABASE_FILE_NAME)

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'fresh' }
    return { kind: 'unsafe', reason: 'unreadable' }
  }

  // Residue first: these mean a previous restore or migration did not finish.
  if (entries.some((name) => name.startsWith(`${DATABASE_FILE_NAME}.replaced-`) && name !== tolerate.replacedFile)) {
    return { kind: 'unsafe', reason: 'restore-interrupted' }
  }
  if (!tolerate.migrationMarker && existsSync(join(dir, MIGRATION_MARKER_RELATIVE))) {
    return { kind: 'unsafe', reason: 'migration-interrupted' }
  }

  let stat: Stats | null
  try {
    stat = statOf(file)
  } catch {
    return { kind: 'unsafe', reason: 'unreadable' }
  }
  if (stat !== null && !stat.isFile()) return { kind: 'unsafe', reason: 'unreadable' }
  const size = stat === null ? null : stat.size

  if (size === null) {
    const leftovers = entries.some(
      (name) => ['pre-migration', 'pre-restore', 'maintenance'].includes(name) || name.includes('.sqlite')
    )
    return leftovers ? { kind: 'unsafe', reason: 'missing-database' } : { kind: 'fresh' }
  }

  const wal = walSize(file)
  if (size === 0 && wal === 0) return { kind: 'fresh' }

  let version: number
  let applicationId: number
  try {
    const header = Buffer.alloc(HEADER_BYTES)
    const fd = openSync(file, 'r')
    let read: number
    try {
      read = readSync(fd, header, 0, HEADER_BYTES, 0)
    } finally {
      closeSync(fd)
    }
    if (read < HEADER_BYTES && wal === 0) return { kind: 'unsafe', reason: 'not-an-app-database' }
    if (read >= HEADER_BYTES && !header.subarray(0, MAGIC.length).equals(MAGIC)) {
      return { kind: 'unsafe', reason: 'not-an-app-database' }
    }
    version = read >= HEADER_BYTES ? header.readUInt32BE(USER_VERSION_OFFSET) : 0
    applicationId = read >= HEADER_BYTES ? header.readUInt32BE(APPLICATION_ID_OFFSET) : 0
  } catch {
    return { kind: 'unsafe', reason: 'unreadable' }
  }

  if (wal > 0) {
    // The header can be older than the log: ask SQLite, read-only, never read-write.
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(file, { readOnly: true })
      version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      applicationId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
    } catch {
      return { kind: 'unsafe', reason: 'wal-pending' }
    } finally {
      try {
        db?.close()
      } catch {
        // Nothing to clean up.
      }
    }
  }

  if (applicationId !== 0 && applicationId !== APPLICATION_ID) return { kind: 'unsafe', reason: 'not-an-app-database' }
  if (version === 0) return { kind: 'unsafe', reason: 'not-an-app-database' }
  if (version === latest) return { kind: 'current', version }
  if (version < latest) return { kind: 'migration-required', from: version, to: latest }
  return { kind: 'too-new', from: version, to: latest }
}
