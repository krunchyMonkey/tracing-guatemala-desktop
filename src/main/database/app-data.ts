import { randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CaseBriefRepository } from './case-brief-repository'
import { CaseJournalRepository } from './case-journal-repository'
import { CaseTaskRepository } from './case-task-repository'
import { CaseTimeRepository } from './case-time-repository'
import { StudioSummaryRepository } from './studio-summary-repository'
import { CaseRepository } from './case-repository'
import { ClientRepository } from './client-repository'
import { APPLICATION_ID, configureConnection, dataDirectory, openAppDatabase, type OpenedDatabase, type OpenOptions } from './connection'
import { getSchemaVersion, migrate, migrations, type Migration } from './migrations'
import { NoteRepository } from './note-repository'
import { NotebookRepository } from './notebook-repository'
import { UserRepository } from './user-repository'

// Owns the live database connection and its repositories, and makes and
// restores backups (#11). A backup is one self-contained SQLite file. Restore
// never touches the live file until the backup has been checked, copied and
// migrated, keeps a safety copy of the current data, and puts the original
// back if anything fails after the swap.

export interface BackupSummary {
  clients: number
  notes: number
  schemaVersion: number
}

export type BackupProblem = 'not-a-backup' | 'damaged' | 'too-new'

/** The file is not a usable backup. Carries no path or content. */
export class BackupInvalidError extends Error {
  constructor(readonly problem: BackupProblem) {
    super(`Backup rejected: ${problem}`)
    this.name = 'BackupInvalidError'
  }
}

/** Restoring failed; the previous data was put back. */
export class RestoreFailedError extends Error {
  constructor(options: ErrorOptions) {
    super('Restore failed; the previous data was kept', options)
    this.name = 'RestoreFailedError'
  }
}

const SQLITE_HEADER = 'SQLite format 3\u0000'
const MAX_BACKUP_BYTES = 2 * 1024 ** 3

function timestampForFileName(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

function removeDatabaseFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${file}${suffix}`, { force: true })
}

function readsAsSqlite(file: string): boolean {
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

type CountedTable = 'clients' | 'client_notes' | 'research_cases' | 'notebook_pages' | 'app_users'

function hasTable(db: DatabaseSync, table: CountedTable): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
}

function count(db: DatabaseSync, table: CountedTable): number {
  if (!hasTable(db, table)) return 0
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
}

/** Checks that `file` is an intact Tracing Guatemala database this app can read, and summarizes it. */
export function inspectBackup(file: string): BackupSummary {
  const { clients, notes, schemaVersion } = inspectBackupContents(file)
  return { clients, notes, schemaVersion }
}

/** inspectBackup plus the case and notebook page counts, which restore verifies but the public summary doesn't carry. */
function inspectBackupContents(file: string): BackupSummary & { cases: number; notebookPages: number; users: number } {
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
    if (schemaVersion < 1 || !hasTable(db, 'clients')) throw new BackupInvalidError('not-a-backup')

    return {
      clients: count(db, 'clients'),
      notes: count(db, 'client_notes'),
      cases: count(db, 'research_cases'),
      notebookPages: count(db, 'notebook_pages'),
      users: count(db, 'app_users'),
      schemaVersion
    }
  } finally {
    db.close()
  }
}

export interface RestoreOptions {
  /** Extra check of the restored data before the old data is discarded (tests use it to force a rollback). */
  verify?: (data: AppData) => void
}

export interface AppDataOptions {
  now?: () => Date
  /** In-code test seam only (see OpenOptions). */
  migrations?: readonly Migration[]
}

export class AppData {
  private opened: OpenedDatabase
  private readonly now: () => Date
  private readonly migrationList: readonly Migration[] | undefined
  clients: ClientRepository
  notes: NoteRepository
  cases: CaseRepository
  briefs: CaseBriefRepository
  journal: CaseJournalRepository
  tasks: CaseTaskRepository
  time: CaseTimeRepository
  notebook: NotebookRepository
  studio: StudioSummaryRepository
  users: UserRepository

  constructor(
    private readonly userDataDir: string,
    options: AppDataOptions | (() => Date) = {}
  ) {
    const resolved: AppDataOptions = typeof options === 'function' ? { now: options } : options
    this.now = resolved.now ?? (() => new Date())
    this.migrationList = resolved.migrations
    this.opened = openAppDatabase(userDataDir, this.openOptions())
    this.clients = new ClientRepository(this.opened.db)
    this.notes = new NoteRepository(this.opened.db)
    this.cases = new CaseRepository(this.opened.db)
    this.briefs = new CaseBriefRepository(this.opened.db)
    this.journal = new CaseJournalRepository(this.opened.db)
    this.tasks = new CaseTaskRepository(this.opened.db)
    this.time = new CaseTimeRepository(this.opened.db)
    this.notebook = new NotebookRepository(this.opened.db)
    this.studio = new StudioSummaryRepository(this.opened.db)
    this.users = new UserRepository(this.opened.db, { now: () => this.now(), newId: () => randomUUID() })
  }

  private openOptions(tolerate?: OpenOptions['tolerate']): OpenOptions {
    return {
      now: this.now,
      ...(this.migrationList ? { migrations: this.migrationList } : {}),
      ...(tolerate ? { tolerate } : {})
    }
  }

  get file(): string {
    return this.opened.file
  }

  get db(): DatabaseSync {
    return this.opened.db
  }

  close(): void {
    this.opened.db.close()
  }

  /** Writes a verified, self-contained copy of all data to `target` (replacing it if it exists). */
  createBackup(target: string): BackupSummary {
    const partial = join(dirname(target), `.${basename(target)}.partial-${randomUUID()}`)
    try {
      this.opened.db.prepare('VACUUM INTO ?').run(partial)
      // A backup must be a single file: switch it out of WAL mode.
      const copy = new DatabaseSync(partial)
      try {
        copy.exec('PRAGMA journal_mode = DELETE')
      } finally {
        copy.close()
      }
      const summary = inspectBackup(partial)
      renameSync(partial, target)
      return summary
    } catch (error) {
      removeDatabaseFiles(partial)
      throw error
    }
  }

  /** Replaces all data with the backup in `file`. Throws BackupInvalidError or RestoreFailedError. */
  restoreBackup(file: string, options: RestoreOptions = {}): BackupSummary {
    const expected = inspectBackupContents(file)
    const dir = dataDirectory(this.userDataDir)
    const stamp = timestampForFileName(this.now())
    const staging = join(dir, `restore-staging-${randomUUID()}.sqlite`)

    // 1. Copy and bring the backup up to the current schema, away from the live file.
    // An older backup is migrated as this staging copy only: neither the live file nor the
    // backup file is ever migrated in place (#248), and the staging copy is what gets swapped in.
    try {
      copyFileSync(file, staging)
      const db = new DatabaseSync(staging)
      try {
        configureConnection(db)
        migrate(db, {}, this.migrationList ?? migrations)
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
        if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new BackupInvalidError('damaged')
      } finally {
        db.close()
      }
    } catch (error) {
      removeDatabaseFiles(staging)
      if (error instanceof BackupInvalidError) throw error
      throw new RestoreFailedError({ cause: error })
    }

    // 2. Keep a safety copy of the current data.
    const safetyDir = join(dir, 'pre-restore')
    mkdirSync(safetyDir, { recursive: true })
    this.opened.db.prepare('VACUUM INTO ?').run(join(safetyDir, `${basename(this.file)}.${stamp}.sqlite`))

    // 3. Swap the files, then reopen and verify. Any failure puts the original back.
    const live = this.file
    const replaced = `${live}.replaced-${randomUUID()}`
    this.opened.db.close()
    renameSync(live, replaced)
    for (const suffix of ['-wal', '-shm']) rmSync(`${live}${suffix}`, { force: true })
    try {
      renameSync(staging, live)
      // The replaced file is still here until the restore is verified; startup would refuse
      // it (restore-interrupted), so this reopen names it as known.
      this.reopen({ replacedFile: basename(replaced) })
      const restoredClients = this.clients.list({ text: '', status: 'all', sources: [], sort: 'name' }).length
      if (restoredClients !== expected.clients) throw new Error('restored client count differs from the backup')
      if (count(this.opened.db, 'research_cases') !== expected.cases) {
        throw new Error('restored case count differs from the backup')
      }
      if (count(this.opened.db, 'notebook_pages') !== expected.notebookPages) {
        throw new Error('restored notebook page count differs from the backup')
      }
      if (count(this.opened.db, 'app_users') !== expected.users) {
        throw new Error('restored user count differs from the backup')
      }
      options.verify?.(this)
    } catch (error) {
      try {
        this.opened.db.close()
      } catch {
        // Already closed if reopening failed.
      }
      // Never leave neither file: the live file is only removed right before the original
      // is renamed back, and a failure here leaves the .replaced-* file, which the next
      // start reports as an interrupted restore instead of creating an empty database.
      removeDatabaseFiles(live)
      removeDatabaseFiles(staging)
      renameSync(replaced, live)
      this.reopen()
      throw new RestoreFailedError({ cause: error })
    }
    removeDatabaseFiles(replaced)
    return {
      clients: expected.clients,
      notes: count(this.opened.db, 'client_notes'),
      schemaVersion: getSchemaVersion(this.opened.db)
    }
  }

  private reopen(tolerate?: OpenOptions['tolerate']): void {
    this.opened = openAppDatabase(this.userDataDir, this.openOptions(tolerate))
    this.clients = new ClientRepository(this.opened.db)
    this.notes = new NoteRepository(this.opened.db)
    this.cases = new CaseRepository(this.opened.db)
    this.briefs = new CaseBriefRepository(this.opened.db)
    this.journal = new CaseJournalRepository(this.opened.db)
    this.tasks = new CaseTaskRepository(this.opened.db)
    this.time = new CaseTimeRepository(this.opened.db)
    this.notebook = new NotebookRepository(this.opened.db)
    this.studio = new StudioSummaryRepository(this.opened.db)
    this.users = new UserRepository(this.opened.db, { now: () => this.now(), newId: () => randomUUID() })
  }
}
