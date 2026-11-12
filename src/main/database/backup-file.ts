import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { APPLICATION_ID } from './connection'
import { getSchemaVersion, migrations } from './migrations'

// Read-only checks of a backup file, shared by restore (app-data.ts) and the host-only
// legacy ownership claim (ownership-repository.ts). Nothing here writes or returns a path.

export type BackupProblem = 'not-a-backup' | 'damaged' | 'too-new'

/** The file is not a usable backup. Carries no path or content. */
export class BackupInvalidError extends Error {
  constructor(readonly problem: BackupProblem) {
    super(`Backup rejected: ${problem}`)
    this.name = 'BackupInvalidError'
  }
}

const SQLITE_HEADER = 'SQLite format 3\u0000'
export const MAX_BACKUP_BYTES = 2 * 1024 ** 3

export function readsAsSqlite(file: string): boolean {
  const size = statSync(file).size
  if (size < 512 || size > MAX_BACKUP_BYTES) return false
  const header = Buffer.alloc(SQLITE_HEADER.length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, header, 0, header.length, 0)
  } finally {
    closeSync(fd)
  }
  return header.toString('latin1') === SQLITE_HEADER
}

export function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
}

/**
 * Opens `file` read-only after checking that it is an intact Tracing Guatemala database this app
 * can read. The caller closes the returned connection. Throws BackupInvalidError.
 */
export function openBackupReadOnly(file: string): { db: DatabaseSync; schemaVersion: number } {
  if (!existsSync(file) || !readsAsSqlite(file)) throw new BackupInvalidError('not-a-backup')

  let db: DatabaseSync
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch {
    throw new BackupInvalidError('damaged')
  }
  try {
    let healthy: boolean
    try {
      const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
      healthy = rows.length === 1 && rows[0]?.integrity_check === 'ok'
    } catch {
      healthy = false
    }
    if (!healthy) throw new BackupInvalidError('damaged')

    const appId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
    if (appId !== APPLICATION_ID) throw new BackupInvalidError('not-a-backup')
    const schemaVersion = getSchemaVersion(db)
    if (schemaVersion > migrations.length) throw new BackupInvalidError('too-new')
    if (schemaVersion < 1 || !tableExists(db, 'clients')) throw new BackupInvalidError('not-a-backup')
    return { db, schemaVersion }
  } catch (error) {
    db.close()
    throw error
  }
}

/** SHA-256 (hex) and size of the file's bytes, read in chunks. */
export function hashFile(file: string): { sha256: string; bytes: number } {
  const hash = createHash('sha256')
  const fd = openSync(file, 'r')
  let bytes = 0
  try {
    const chunk = Buffer.alloc(1024 * 1024)
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read === 0) break
      hash.update(chunk.subarray(0, read))
      bytes += read
    }
  } finally {
    closeSync(fd)
  }
  return { sha256: hash.digest('hex'), bytes }
}
