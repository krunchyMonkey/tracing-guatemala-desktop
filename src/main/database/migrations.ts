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
  },
  {
    version: 3,
    name: 'research_cases',
    // case-model/v1 §5. No cascades: cases and their events are never deleted.
    sql: `
      CREATE TABLE research_cases (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        client_id TEXT NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
        goal TEXT CHECK (goal IS NULL OR length(goal) BETWEEN 1 AND 4000),
        order_reference TEXT CHECK (order_reference IS NULL OR length(order_reference) BETWEEN 1 AND 100),
        due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        state TEXT NOT NULL DEFAULT 'intake'
          CHECK (state IN ('intake', 'active', 'waiting', 'delivered', 'closed')),
        state_changed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      ) STRICT;

      CREATE INDEX research_cases_client_idx ON research_cases (client_id, updated_at);
      CREATE INDEX research_cases_due_idx ON research_cases (due_date) WHERE due_date IS NOT NULL;

      CREATE TRIGGER research_cases_no_delete BEFORE DELETE ON research_cases
      BEGIN
        SELECT RAISE(ABORT, 'research cases are never deleted');
      END;

      CREATE TRIGGER research_cases_immutable_keys BEFORE UPDATE OF id, client_id ON research_cases
      BEGIN
        SELECT RAISE(ABORT, 'case id and client are immutable');
      END;

      CREATE TABLE case_events (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        case_id TEXT NOT NULL REFERENCES research_cases (id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('created', 'state', 'archived', 'unarchived')),
        from_state TEXT CHECK (from_state IS NULL OR from_state IN ('intake', 'active', 'waiting', 'delivered', 'closed')),
        to_state TEXT CHECK (to_state IS NULL OR to_state IN ('intake', 'active', 'waiting', 'delivered', 'closed')),
        occurred_at TEXT NOT NULL,
        CHECK ((kind = 'state') = (from_state IS NOT NULL)),
        CHECK ((kind IN ('created', 'state')) = (to_state IS NOT NULL))
      ) STRICT;

      CREATE INDEX case_events_case_idx ON case_events (case_id, occurred_at);

      CREATE TRIGGER case_events_append_only_update BEFORE UPDATE ON case_events
      BEGIN
        SELECT RAISE(ABORT, 'case events are append-only');
      END;

      CREATE TRIGGER case_events_append_only_delete BEFORE DELETE ON case_events
      BEGIN
        SELECT RAISE(ABORT, 'case events are append-only');
      END;
    `
  },
  {
    version: 4,
    name: 'case_briefs',
    sql: `
      CREATE TABLE case_briefs (
        case_id TEXT PRIMARY KEY NOT NULL REFERENCES research_cases (id) ON DELETE RESTRICT,
        objective TEXT CHECK (objective IS NULL OR length(objective) BETWEEN 1 AND 4000),
        facts TEXT CHECK (facts IS NULL OR length(facts) BETWEEN 1 AND 10000),
        people TEXT CHECK (people IS NULL OR length(people) BETWEEN 1 AND 10000),
        hypotheses TEXT CHECK (hypotheses IS NULL OR length(hypotheses) BETWEEN 1 AND 10000),
        questions TEXT CHECK (questions IS NULL OR length(questions) BETWEEN 1 AND 10000),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER case_briefs_no_delete BEFORE DELETE ON case_briefs
      BEGIN
        SELECT RAISE(ABORT, 'case briefs are never deleted');
      END;

      CREATE TRIGGER case_briefs_immutable_case BEFORE UPDATE OF case_id ON case_briefs
      BEGIN
        SELECT RAISE(ABORT, 'a brief belongs to one case');
      END;
    `
  },
  {
    version: 5,
    name: 'case_journal_entries',
    sql: `
      CREATE TABLE case_journal_entries (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        case_id TEXT NOT NULL REFERENCES research_cases (id) ON DELETE RESTRICT,
        occurred_at TEXT NOT NULL,
        activity TEXT CHECK (activity IS NULL OR length(activity) BETWEEN 1 AND 60),
        body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX case_journal_entries_case_idx ON case_journal_entries (case_id, occurred_at);

      CREATE TRIGGER case_journal_entries_no_delete BEFORE DELETE ON case_journal_entries
      BEGIN
        SELECT RAISE(ABORT, 'journal entries are never deleted');
      END;

      CREATE TRIGGER case_journal_entries_immutable_keys BEFORE UPDATE OF id, case_id ON case_journal_entries
      BEGIN
        SELECT RAISE(ABORT, 'journal entry id and case are immutable');
      END;
    `
  },
  {
    version: 6,
    name: 'case_tasks',
    sql: `
      CREATE TABLE case_tasks (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        case_id TEXT NOT NULL REFERENCES research_cases (id) ON DELETE RESTRICT,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
        description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 2000),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
        due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((status = 'completed') = (completed_at IS NOT NULL))
      ) STRICT;

      CREATE INDEX case_tasks_case_idx ON case_tasks (case_id, status);

      CREATE TRIGGER case_tasks_no_delete BEFORE DELETE ON case_tasks
      BEGIN
        SELECT RAISE(ABORT, 'case tasks are never deleted');
      END;

      CREATE TRIGGER case_tasks_immutable_keys BEFORE UPDATE OF id, case_id ON case_tasks
      BEGIN
        SELECT RAISE(ABORT, 'task id and case are immutable');
      END;
    `
  },
  {
    version: 7,
    name: 'case_time',
    sql: `
      CREATE TABLE case_time_entries (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        case_id TEXT NOT NULL REFERENCES research_cases (id) ON DELETE RESTRICT,
        client_id TEXT NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
        work_date TEXT NOT NULL CHECK (work_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 1 AND 720),
        activity_type TEXT CHECK (activity_type IS NULL OR activity_type IN ('research', 'correspondence', 'analysis', 'writing', 'other')),
        note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
        source TEXT NOT NULL CHECK (source IN ('timer', 'manual')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX case_time_entries_case_idx ON case_time_entries (case_id, work_date);

      CREATE TRIGGER case_time_entries_client_matches BEFORE INSERT ON case_time_entries
      WHEN (SELECT client_id FROM research_cases WHERE id = NEW.case_id) IS NOT NEW.client_id
      BEGIN
        SELECT RAISE(ABORT, 'time entry client must be the case client');
      END;

      CREATE TRIGGER case_time_entries_immutable_keys BEFORE UPDATE OF id, case_id, client_id, source ON case_time_entries
      BEGIN
        SELECT RAISE(ABORT, 'time entry id, case, client and source are immutable');
      END;

      CREATE TABLE case_active_timer (
        id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        case_id TEXT NOT NULL REFERENCES research_cases (id) ON DELETE RESTRICT,
        client_id TEXT NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN ('running', 'paused')),
        accumulated_seconds INTEGER NOT NULL CHECK (accumulated_seconds >= 0),
        segment_started_at TEXT,
        last_heartbeat_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        CHECK ((state = 'running') = (segment_started_at IS NOT NULL))
      ) STRICT;
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
