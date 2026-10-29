import type { DatabaseSync } from 'node:sqlite'

// Forward-only schema migrations, tracked with PRAGMA user_version. Each one runs
// in its own transaction, so a failure leaves the database at the previous
// version. Never edit a released migration: add a new one.

export interface Migration {
  version: number
  name: string
  sql: string
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'clients',
    sql: `
      CREATE TABLE clients (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
        source TEXT NOT NULL CHECK (source IN ('fiverr', 'referral', 'direct', 'other')),
        source_detail TEXT CHECK (source_detail IS NULL OR length(source_detail) BETWEEN 1 AND 200),
        fiverr_username TEXT CHECK (fiverr_username IS NULL OR length(fiverr_username) BETWEEN 1 AND 60),
        email TEXT CHECK (email IS NULL OR length(email) BETWEEN 1 AND 254),
        other_contact TEXT CHECK (other_contact IS NULL OR length(other_contact) BETWEEN 1 AND 200),
        preferred_contact_channel TEXT NOT NULL DEFAULT 'unspecified'
          CHECK (preferred_contact_channel IN ('fiverr', 'email', 'other', 'unspecified')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        CHECK ((status = 'archived') = (archived_at IS NOT NULL))
      ) STRICT;

      CREATE INDEX clients_status_idx ON clients (status);

      -- Phase 1 never hard-deletes a client and ids are immutable (client-model/v1 §2.1).
      CREATE TRIGGER clients_no_delete BEFORE DELETE ON clients
      BEGIN
        SELECT RAISE(ABORT, 'clients are never deleted');
      END;

      CREATE TRIGGER clients_immutable_id BEFORE UPDATE OF id ON clients
      BEGIN
        SELECT RAISE(ABORT, 'client ids are immutable');
      END;
    `
  },
  {
    version: 2,
    name: 'client_notes',
    sql: `
      CREATE TABLE client_notes (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        client_id TEXT NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('note', 'contact', 'system')),
        occurred_at TEXT NOT NULL,
        channel TEXT CHECK (channel IS NULL OR channel IN ('fiverr', 'email', 'other')),
        direction TEXT CHECK (direction IS NULL OR direction IN ('inbound', 'outbound')),
        body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (kind = 'contact' OR (channel IS NULL AND direction IS NULL))
      ) STRICT;

      CREATE INDEX client_notes_client_idx ON client_notes (client_id, occurred_at);
    `
  }
]

/** The database was written by a newer app version. Opening it could lose data. */
export class DatabaseTooNewError extends Error {
  constructor(
    readonly databaseVersion: number,
    readonly supportedVersion: number
  ) {
    super(`Database schema version ${databaseVersion} is newer than supported version ${supportedVersion}`)
    this.name = 'DatabaseTooNewError'
  }
}

export class MigrationFailedError extends Error {
  constructor(
    readonly version: number,
    options: ErrorOptions
  ) {
    super(`Migration ${version} failed; the database was left at version ${version - 1}`, options)
    this.name = 'MigrationFailedError'
  }
}

export interface MigrationOutcome {
  from: number
  to: number
}

export interface MigrateOptions {
  /** Called once before upgrading an existing (non-empty) database, e.g. to copy it. */
  beforeUpgrade?: (from: number, to: number) => void
}

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

export function migrate(
  db: DatabaseSync,
  options: MigrateOptions = {},
  list: readonly Migration[] = migrations
): MigrationOutcome {
  list.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error('Migrations must be numbered 1..n without gaps')
  })

  const from = getSchemaVersion(db)
  const latest = list.length
  if (from > latest) throw new DatabaseTooNewError(from, latest)
  if (from === latest) return { from, to: from }

  if (from > 0) options.beforeUpgrade?.(from, latest)

  for (const migration of list.slice(from)) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      // user_version is part of the database header, so this is committed atomically with the schema.
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (cause) {
      db.exec('ROLLBACK')
      throw new MigrationFailedError(migration.version, { cause })
    }
  }
  return { from, to: latest }
}
