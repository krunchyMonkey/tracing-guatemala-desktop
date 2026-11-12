import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATABASE_FILE_NAME, dataDirectory } from '../../main/database/identity'
import { walSize, type UnsafeReason } from '../../main/database/schema-preflight'
import { acquireDataDirLock, checkLiveDataDir } from '../data-dir'

// Shared by the operator's maintenance commands (migrate/revert #248, claim-legacy #245):
// the error type with its fixed messages, the data-folder lock and the exclusive-use probe.
// Messages carry no path and no row content.

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
  | 'claim-input-invalid'
  | 'migration-required'
  | 'target-not-found'
  | 'target-inactive'
  | 'target-unbound'
  | 'client-not-found'
  | 'ownership-conflict'
  | 'claim-verify-failed'
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
  'revert-failed': 'The revert failed verification and the migrated data was put back.',
  'claim-input-invalid': 'The command needs --target-user, at least one valid --client and a valid --operator. Nothing was changed.',
  'migration-required': 'The data is at an older schema. Run npm run db:migrate first. Nothing was changed.',
  'target-not-found': 'The target user does not exist. Nothing was changed.',
  'target-inactive': 'The target user is not an active Owner or Researcher. Nothing was changed.',
  'target-unbound': 'The target user has no bound sign-in identity yet. Nothing was changed.',
  'client-not-found': 'A listed client does not exist. Nothing was changed.',
  'ownership-conflict': 'A listed client is already claimed by a different user. Nothing was changed.',
  'claim-verify-failed':
    'The post-checks after the claims did not hold. Claims may have been committed. Read maintenance/<folder>/report.json and follow docs/operations/ownership-reconciliation.md before doing anything else.'
}

/** A maintenance command refused or failed. Carries a code and a fixed message: no paths, no content. */
export class MaintenanceError extends Error {
  constructor(
    readonly code: MaintenanceCode,
    /** Ids and the relative report folder only, for the claim command's failure output. */
    readonly detail?: { batchId: string; folder: string; claimed: string[]; done: string[]; remaining: string[] }
  ) {
    super(
      code.startsWith('unsafe:')
        ? `The data folder is not safe to change (${code.slice(7)}). Nothing was changed.`
        : (MESSAGES[code] ?? code)
    )
    this.name = 'MaintenanceError'
  }
}

export const maintenanceDirOf = (dataDir: string): string => join(dataDirectory(dataDir), 'maintenance')
export const liveFileOf = (dataDir: string): string => join(dataDirectory(dataDir), DATABASE_FILE_NAME)
export const stamped = (date: Date): string => date.toISOString().replace(/[:.]/g, '-')

export function withLockedProfile<T>(dataDir: string, work: () => T): T {
  if (!existsSync(dataDir)) throw new MaintenanceError('data-dir-missing')
  if (!checkLiveDataDir(dataDir).ok) throw new MaintenanceError('data-dir-refused')
  const release = acquireDataDirLock(dataDir) // the lock Live holds: DataDirInUseError while it runs
  try {
    return work()
  } finally {
    release()
  }
}

export function removeSideFiles(file: string, which: ('-wal' | '-shm')[] = ['-wal', '-shm']): void {
  for (const suffix of which) rmSync(`${file}${suffix}`, { force: true })
}

/** After read-only opens: drop a leftover -shm and an empty -wal. Only called with the lock held and nothing open. */
export function tidySideFiles(file: string): void {
  if (walSize(file) === 0) removeSideFiles(file)
}

/**
 * Evidence (not proof) that no other connection has the file open: a probe asks for the
 * exclusive lock without waiting. Writes nothing. Side files are tidied only when it passes,
 * because a holder may be using them.
 */
export function assertNoOtherConnections(file: string): void {
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


export function isHealthy(db: DatabaseSync): boolean {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') return false
    return db.prepare('PRAGMA foreign_key_check').all().length === 0
  } catch {
    return false
  }
}

export function closeQuietly(db: DatabaseSync | null): void {
  try {
    db?.close()
  } catch {
    // Already closed.
  }
}

export function uniqueStamp(maintenanceDir: string, now: Date): string {
  const base = stamped(now)
  let candidate = base
  for (let n = 2; existsSync(join(maintenanceDir, candidate)); n += 1) candidate = `${base}-${n}`
  return candidate
}
