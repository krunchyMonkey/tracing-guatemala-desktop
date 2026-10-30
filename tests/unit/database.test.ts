import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRepository } from '../../src/main/database/client-repository'
import { configureConnection, dataDirectory, DATABASE_FILE_NAME, openAppDatabase } from '../../src/main/database/connection'
import {
  DatabaseTooNewError,
  getSchemaVersion,
  migrate,
  MigrationFailedError,
  migrations
} from '../../src/main/database/migrations'
import { defaultQuery, type ClientInput } from '../../src/shared/client-model'

// All data below is fictional.

const input: ClientInput = {
  displayName: 'Ana Ejemplo',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: 'fictional_buyer_01',
  email: 'ana.example@example.com',
  otherContact: null,
  preferredContactChannel: 'email'
}

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'tg-db-test-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  configureConnection(db)
  return db
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (row) => row.name
  )
}

describe('migrate', () => {
  it('creates the schema on an empty database and is idempotent', () => {
    const db = memoryDb()
    expect(migrate(db)).toEqual({ from: 0, to: migrations.length })
    expect(tableNames(db)).toEqual(['case_briefs', 'case_events', 'case_journal_entries', 'case_tasks', 'client_notes', 'clients', 'research_cases'])
    expect(migrate(db)).toEqual({ from: migrations.length, to: migrations.length })
  })

  it('refuses a database written by a newer app without changing it', () => {
    const db = memoryDb()
    db.exec('PRAGMA user_version = 99')
    expect(() => migrate(db)).toThrow(DatabaseTooNewError)
    expect(getSchemaVersion(db)).toBe(99)
    expect(tableNames(db)).toEqual([])
  })

  it('rolls back a failing migration and keeps the previous version', () => {
    const db = memoryDb()
    migrate(db)
    const broken = [
      ...migrations,
      { version: migrations.length + 1, name: 'broken', sql: 'CREATE TABLE half_done (x TEXT); SELECT * FROM missing_table;' }
    ]
    expect(() => migrate(db, {}, broken)).toThrow(MigrationFailedError)
    expect(getSchemaVersion(db)).toBe(migrations.length)
    expect(tableNames(db)).not.toContain('half_done')
  })

  it('rejects migration lists with gaps', () => {
    expect(() => migrate(memoryDb(), {}, [{ version: 2, name: 'gap', sql: '' }])).toThrow(/without gaps/)
  })

  it('enforces schema constraints independently of the app rules', () => {
    const db = memoryDb()
    migrate(db)
    const repo = new ClientRepository(db)
    const created = repo.create(input)
    if (!created.ok) throw new Error('create failed')
    const id = created.client.id

    expect(() => db.prepare('DELETE FROM clients WHERE id = ?').run(id)).toThrow(/never deleted/)
    expect(() => db.prepare('UPDATE clients SET id = ? WHERE id = ?').run(crypto.randomUUID(), id)).toThrow(/immutable/)
    expect(() => db.prepare("UPDATE clients SET status = 'archived' WHERE id = ?").run(id)).toThrow(/CHECK/)
    expect(() => db.prepare("UPDATE clients SET source = 'web' WHERE id = ?").run(id)).toThrow(/CHECK/)
    expect(() =>
      db
        .prepare(
          `INSERT INTO client_notes (id, client_id, kind, occurred_at, body, created_at, updated_at)
           VALUES (?, ?, 'note', 'x', 'body', 'x', 'x')`
        )
        .run(crypto.randomUUID(), crypto.randomUUID())
    ).toThrow(/FOREIGN KEY/)
  })
})

describe('openAppDatabase', () => {
  it('creates the database under <userData>/data', () => {
    const { db, file, migration } = openAppDatabase(userData)
    db.close()
    expect(file).toBe(join(dataDirectory(userData), DATABASE_FILE_NAME))
    expect(existsSync(file)).toBe(true)
    expect(migration).toEqual({ from: 0, to: migrations.length })
  })

  it('upgrades an older database in place, keeping data and a pre-migration copy', () => {
    const first = openAppDatabase(userData)
    first.db.close()
    // Simulate a database left by an app version that only knew migration 1.
    const old = new DatabaseSync(first.file)
    old.exec('DROP TABLE case_tasks; DROP TABLE case_journal_entries; DROP TABLE case_briefs; DROP TABLE case_events; DROP TABLE research_cases; DROP TABLE client_notes; PRAGMA user_version = 1;')
    old
      .prepare(
        `INSERT INTO clients (id, display_name, source, created_at, updated_at)
         VALUES ('00000000-0000-4000-8000-000000000001', 'Older Record', 'direct', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    old.close()

    const upgraded = openAppDatabase(userData, () => new Date('2026-10-29T12:00:00.000Z'))
    expect(upgraded.migration).toEqual({ from: 1, to: migrations.length })
    const repo = new ClientRepository(upgraded.db)
    expect(repo.get('00000000-0000-4000-8000-000000000001')?.displayName).toBe('Older Record')
    expect(repo.archive('00000000-0000-4000-8000-000000000001').ok).toBe(true)
    upgraded.db.close()

    const backups = readdirSync(join(dataDirectory(userData), 'pre-migration'))
    expect(backups).toEqual([`${DATABASE_FILE_NAME}.v1.2026-10-29T12-00-00-000Z.sqlite`])
    const backup = new DatabaseSync(join(dataDirectory(userData), 'pre-migration', backups[0]!))
    expect(getSchemaVersion(backup)).toBe(1)
    expect(tableNames(backup)).toEqual(['clients'])
    backup.close()
  })

  it('does not take a pre-migration copy of a brand-new database', () => {
    openAppDatabase(userData).db.close()
    expect(existsSync(join(dataDirectory(userData), 'pre-migration'))).toBe(false)
  })
})

describe('ClientRepository', () => {
  let db: DatabaseSync
  let repo: ClientRepository
  let tick: number

  beforeEach(() => {
    db = memoryDb()
    migrate(db)
    tick = 0
    repo = new ClientRepository(db, {
      now: () => new Date(Date.UTC(2026, 9, 29, 12, 0, tick++)),
      newId: () => crypto.randomUUID()
    })
  })

  function create(overrides: Partial<ClientInput> = {}) {
    const result = repo.create({ ...input, ...overrides })
    if (!result.ok) throw new Error(`create failed: ${result.reason}`)
    return result.client
  }

  it('creates an active client with system fields set by the main process', () => {
    const client = create({ displayName: '  Ana   Ejemplo ', fiverrUsername: ' @fictional_buyer_01 ', sourceDetail: '  ' })
    expect(client).toMatchObject({
      displayName: 'Ana Ejemplo',
      fiverrUsername: 'fictional_buyer_01',
      sourceDetail: null,
      status: 'active',
      archivedAt: null,
      createdAt: '2026-10-29T12:00:00.000Z',
      updatedAt: '2026-10-29T12:00:00.000Z'
    })
    expect(client.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(repo.get(client.id)).toEqual(client)
  })

  it('returns rule codes, never values, for invalid input and stores nothing', () => {
    const secret = 'Fictional Secret Name'
    const result = repo.create({ ...input, displayName: `${secret}\u0007`, email: 'not-an-email' })
    expect(result).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [
        { field: 'displayName', severity: 'error', code: 'invalid-characters' },
        { field: 'email', severity: 'error', code: 'invalid-format' }
      ]
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(repo.list({ ...defaultQuery, status: 'all' })).toEqual([])
  })

  it('stores SQL-like text literally', () => {
    const client = create({ displayName: "Robert'); DROP TABLE clients;--" })
    expect(repo.get(client.id)?.displayName).toBe("Robert'); DROP TABLE clients;--")
    expect(tableNames(db)).toContain('clients')
  })

  it('updates active clients and keeps id and createdAt', () => {
    const client = create()
    const result = repo.update(client.id, { ...input, displayName: 'Ana E.', email: null, preferredContactChannel: 'fiverr' })
    expect(result).toMatchObject({
      ok: true,
      client: { id: client.id, displayName: 'Ana E.', email: null, createdAt: client.createdAt }
    })
    if (result.ok) expect(result.client.updatedAt > client.updatedAt).toBe(true)
  })

  it('reports unknown ids and invalid edits', () => {
    const missing = crypto.randomUUID()
    expect(repo.update(missing, input)).toEqual({ ok: false, reason: 'not-found' })
    expect(repo.archive(missing)).toEqual({ ok: false, reason: 'not-found' })
    expect(repo.get(missing)).toBeNull()

    const client = create()
    expect(repo.update(client.id, { ...input, displayName: ' ' })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(repo.get(client.id)).toEqual(client)
  })

  it('archives and restores with system notes, and keeps archived clients read-only', () => {
    const client = create()
    const archived = repo.archive(client.id)
    expect(archived).toMatchObject({ ok: true, client: { status: 'archived', archivedAt: expect.any(String) } })
    expect(repo.archive(client.id)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(repo.update(client.id, input)).toEqual({ ok: false, reason: 'wrong-status' })

    const restored = repo.restore(client.id)
    expect(restored).toMatchObject({ ok: true, client: { id: client.id, status: 'active', archivedAt: null } })
    expect(repo.restore(client.id)).toEqual({ ok: false, reason: 'wrong-status' })

    const notes = db
      .prepare("SELECT kind, body FROM client_notes WHERE client_id = ? ORDER BY occurred_at")
      .all(client.id)
      .map((row) => ({ ...row }))
    expect(notes).toEqual([
      { kind: 'system', body: 'Archived.' },
      { kind: 'system', body: 'Restored.' }
    ])
  })

  it('lists with the directory rules (status, source, accent-insensitive search, sort)', () => {
    const ana = create({ displayName: 'Ána Ejemplo' })
    const bea = create({ displayName: 'Bea Muestra', source: 'referral', email: null, preferredContactChannel: 'unspecified' })
    const carl = create({ displayName: 'Carlos Ficticio', fiverrUsername: 'other_handle' })
    repo.archive(carl.id)

    expect(repo.list(defaultQuery).map((c) => c.id)).toEqual([ana.id, bea.id])
    expect(repo.list({ ...defaultQuery, status: 'archived' }).map((c) => c.id)).toEqual([carl.id])
    expect(repo.list({ ...defaultQuery, sources: ['referral'] }).map((c) => c.id)).toEqual([bea.id])
    expect(repo.list({ ...defaultQuery, text: 'ana' }).map((c) => c.id)).toEqual([ana.id])
    expect(repo.list({ ...defaultQuery, status: 'all', sort: 'updated' }).map((c) => c.id)).toEqual([carl.id, bea.id, ana.id])
  })

  it('persists across reopening the database file', () => {
    const first = openAppDatabase(userData)
    const created = new ClientRepository(first.db).create(input)
    first.db.close()
    if (!created.ok) throw new Error('create failed')

    const second = openAppDatabase(userData)
    expect(second.migration).toEqual({ from: migrations.length, to: migrations.length })
    expect(new ClientRepository(second.db).get(created.client.id)).toEqual(created.client)
    second.db.close()
  })
})
