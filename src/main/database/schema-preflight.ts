import { type Stats, closeSync, existsSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { APPLICATION_ID, DATABASE_FILE_NAME, dataDirectory, PROFILE_MARKER_FILE_NAME } from './identity'
import { DB_HEADER_BYTES, readWal } from './wal-reader'

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
  | 'wal-unreadable'
  | 'profile-marker-unwritable'

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
const HEADER_BYTES = DB_HEADER_BYTES
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

export type EffectiveHeader =
  | { ok: true; version: number; applicationId: number; fromWal: boolean }
  | { ok: false; reason: 'not-an-app-database' | 'wal-unreadable' | 'unreadable' }

function readMainHeader(file: string): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  const fd = openSync(file, 'r')
  try {
    return header.subarray(0, readSync(fd, header, 0, HEADER_BYTES, 0))
  } finally {
    closeSync(fd)
  }
}

const hasMagic = (header: Buffer): boolean => header.length >= MAGIC.length && header.subarray(0, MAGIC.length).equals(MAGIC)

const fieldsOf = (header: Buffer, fromWal: boolean): EffectiveHeader => ({
  ok: true,
  version: header.readUInt32BE(USER_VERSION_OFFSET),
  applicationId: header.readUInt32BE(APPLICATION_ID_OFFSET),
  fromWal
})

/**
 * The page-1 header SQLite would see: the last committed copy of page 1 in the log, else
 * the main file's. Plain file reads only: never opens SQLite, never creates a -shm.
 * A non-empty log whose header is invalid or unknown fails closed (wal-unreadable).
 */
export function effectiveHeader(file: string): EffectiveHeader {
  try {
    const main = readMainHeader(file)
    const mainKnown = main.length >= HEADER_BYTES
    if (walSize(file) === 0) {
      return mainKnown && hasMagic(main) ? fieldsOf(main, false) : { ok: false, reason: 'not-an-app-database' }
    }
    // SQLite discards a log whose main file is empty, so opening would silently lose it: fail closed.
    if (main.length === 0) return { ok: false, reason: 'wal-unreadable' }
    const wal = readWal(`${file}-wal`)
    if (wal === null) return { ok: false, reason: 'wal-unreadable' }
    if (wal.page1 !== null) return hasMagic(wal.page1) ? fieldsOf(wal.page1, true) : { ok: false, reason: 'wal-unreadable' }
    if (!mainKnown) return { ok: false, reason: 'wal-unreadable' }
    return hasMagic(main) ? fieldsOf(main, false) : { ok: false, reason: 'not-an-app-database' }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}

function isEmptyDirectory(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

export function inspectProfile(userDataDir: string, latest: number, tolerate: PreflightTolerance = {}): ProfileState {
  const dir = dataDirectory(userDataDir)
  const file = join(dir, DATABASE_FILE_NAME)

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unsafe', reason: 'unreadable' }
    entries = []
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

  const wal = walSize(file)
  if (stat === null || (stat.size === 0 && wal === 0)) {
    // No database. It is a new profile only if nothing shows one ever existed: no marker,
    // an empty data folder (a 0-byte database file and its side files don't count), no backups or uploads.
    const ignored = [DATABASE_FILE_NAME, `${DATABASE_FILE_NAME}-shm`, `${DATABASE_FILE_NAME}-wal`]
    const others = entries.filter((name) => !ignored.includes(name))
    const evidence =
      others.length > 0 ||
      (stat === null && wal > 0) ||
      existsSync(join(userDataDir, PROFILE_MARKER_FILE_NAME)) ||
      !isEmptyDirectory(join(userDataDir, 'backups')) ||
      !isEmptyDirectory(join(userDataDir, 'uploads'))
    return evidence ? { kind: 'unsafe', reason: 'missing-database' } : { kind: 'fresh' }
  }

  // The version is the effective header's (the log's last committed page 1, else the file's):
  // equal to latest opens normally and SQLite recovers the log; lower needs the maintenance
  // command; higher is too new. Nothing is opened or created here.
  const header = effectiveHeader(file)
  if (!header.ok) return { kind: 'unsafe', reason: header.reason }
  const { version, applicationId } = header
  if (applicationId !== 0 && applicationId !== APPLICATION_ID) return { kind: 'unsafe', reason: 'not-an-app-database' }
  if (version === 0) return { kind: 'unsafe', reason: 'not-an-app-database' }
  if (version === latest) return { kind: 'current', version }
  if (version < latest) return { kind: 'migration-required', from: version, to: latest }
  return { kind: 'too-new', from: version, to: latest }
}
