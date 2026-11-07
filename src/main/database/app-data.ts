import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CaseBriefRepository } from './case-brief-repository'
import { CaseJournalRepository } from './case-journal-repository'
import { CaseTaskRepository } from './case-task-repository'
import { CaseTimeRepository } from './case-time-repository'
import { StudioSummaryRepository } from './studio-summary-repository'
import { CaseRepository } from './case-repository'
import { ClientRepository } from './client-repository'
import { BackupInvalidError, openBackupReadOnly, tableExists } from './backup-file'
import { APPLICATION_ID, configureConnection, dataDirectory, openAppDatabase, type OpenedDatabase } from './connection'
import { getSchemaVersion, migrate } from './migrations'
import { NoteRepository } from './note-repository'
import { NotebookRepository } from './notebook-repository'
import { SCOPE_ALL } from './research-access'
import { OwnershipRepository } from './ownership-repository'
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

// Defined in backup-file.ts (shared with the legacy ownership claim); re-exported for existing callers.
export { BackupInvalidError }
export type { BackupProblem } from './backup-file'

/** Restoring failed; the previous data was put back. */
export class RestoreFailedError extends Error {
  constructor(options: ErrorOptions) {
    super('Restore failed; the previous data was kept', options)
    this.name = 'RestoreFailedError'
  }
}

function timestampForFileName(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

function removeDatabaseFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${file}${suffix}`, { force: true })
}

type CountedTable =
  | 'clients'
  | 'client_notes'
  | 'research_cases'
  | 'notebook_pages'
  | 'app_users'
  | 'client_ownership'
  | 'client_grants'
  | 'case_grants'
  | 'ownership_events'

/** Tables added by migration 10; absent (counted as 0) in backups from older versions. */
const OWNERSHIP_TABLES = ['client_ownership', 'client_grants', 'case_grants', 'ownership_events'] as const

function count(db: DatabaseSync, table: CountedTable): number {
  if (!tableExists(db, table)) return 0
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
}

/** Checks that `file` is an intact Tracing Guatemala database this app can read, and summarizes it. */
export function inspectBackup(file: string): BackupSummary {
  const { clients, notes, schemaVersion } = inspectBackupContents(file)
  return { clients, notes, schemaVersion }
}

/** inspectBackup plus the counts that restore verifies but the public summary doesn't carry. */
function inspectBackupContents(file: string): BackupSummary & {
  cases: number
  notebookPages: number
  users: number
  ownership: Record<(typeof OWNERSHIP_TABLES)[number], number>
} {
  const { db, schemaVersion } = openBackupReadOnly(file)
  try {
    return {
      clients: count(db, 'clients'),
      notes: count(db, 'client_notes'),
      cases: count(db, 'research_cases'),
      notebookPages: count(db, 'notebook_pages'),
      users: count(db, 'app_users'),
      ownership: {
        client_ownership: count(db, 'client_ownership'),
        client_grants: count(db, 'client_grants'),
        case_grants: count(db, 'case_grants'),
        ownership_events: count(db, 'ownership_events')
      },
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

export class AppData {
  private opened: OpenedDatabase
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
  ownership: OwnershipRepository

  constructor(
    private readonly userDataDir: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.opened = openAppDatabase(userDataDir, now)
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
    this.ownership = new OwnershipRepository(this.opened.db, { now: () => this.now(), newId: () => randomUUID() })
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
    try {
      copyFileSync(file, staging)
      const db = new DatabaseSync(staging)
      try {
        configureConnection(db)
        migrate(db)
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
      this.reopen()
      const restoredClients = this.clients.list({ text: '', status: 'all', sources: [], sort: 'name' }, SCOPE_ALL).length
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
      for (const table of OWNERSHIP_TABLES) {
        if (count(this.opened.db, table) !== expected.ownership[table]) {
          throw new Error(`restored ${table} count differs from the backup`)
        }
      }
      options.verify?.(this)
    } catch (error) {
      try {
        this.opened.db.close()
      } catch {
        // Already closed if reopening failed.
      }
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

  private reopen(): void {
    this.opened = openAppDatabase(this.userDataDir, this.now)
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
    this.ownership = new OwnershipRepository(this.opened.db, { now: () => this.now(), newId: () => randomUUID() })
  }
}
