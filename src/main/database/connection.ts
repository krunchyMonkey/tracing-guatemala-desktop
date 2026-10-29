import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate, type MigrationOutcome } from './migrations'

// Driver: Node's built-in node:sqlite (see docs/architecture/client-storage.md for
// the spike). Only this module and the repositories import it, so a driver swap
// stays local to src/main/database.

export const DATABASE_FILE_NAME = 'tracing-guatemala.sqlite'

/** SQLite application_id ("TGD1"), so a backup can be told apart from any other SQLite file. */
export const APPLICATION_ID = 0x54474431

export interface OpenedDatabase {
  db: DatabaseSync
  file: string
  migration: MigrationOutcome
}

/** Path of the data directory inside Electron's per-user data directory. */
export function dataDirectory(userDataDir: string): string {
  return join(userDataDir, 'data')
}

function timestampForFileName(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * Open (creating if needed) the app database under `<userData>/data` and apply
 * pending migrations. Before upgrading an existing database, a consistent copy
 * is written to `<userData>/data/pre-migration/`.
 */
export function openAppDatabase(userDataDir: string, now: () => Date = () => new Date()): OpenedDatabase {
  const dir = dataDirectory(userDataDir)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, DATABASE_FILE_NAME)

  const db = new DatabaseSync(file)
  try {
    configureConnection(db)
    const migration = migrate(db, {
      beforeUpgrade: (from) => {
        const backupDir = join(dir, 'pre-migration')
        mkdirSync(backupDir, { recursive: true })
        const target = join(backupDir, `${DATABASE_FILE_NAME}.v${from}.${timestampForFileName(now())}.sqlite`)
        db.prepare('VACUUM INTO ?').run(target)
      }
    })
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
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
