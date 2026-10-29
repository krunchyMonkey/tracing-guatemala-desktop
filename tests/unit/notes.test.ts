import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRepository } from '../../src/main/database/client-repository'
import { configureConnection, openAppDatabase } from '../../src/main/database/connection'
import { migrate } from '../../src/main/database/migrations'
import { NoteRepository } from '../../src/main/database/note-repository'
import { checkNote, type ClientInput, type NoteInput } from '../../src/shared/client-model'

// Notes and contact log through the real SQLite repositories. Fictional data only.

const clientInput: ClientInput = {
  displayName: 'Ana Ejemplo',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: null,
  email: null,
  otherContact: null,
  preferredContactChannel: 'unspecified'
}

const noteInput: NoteInput = {
  kind: 'note',
  occurredAt: '2026-10-20T10:00:00.000Z',
  channel: null,
  direction: null,
  body: 'Check both surname spellings in the baptism records.'
}

const contactInput: NoteInput = {
  kind: 'contact',
  occurredAt: '2026-10-21T15:30:00.000Z',
  channel: 'fiverr',
  direction: 'outbound',
  body: 'Sent a status update.'
}

const NOW = new Date('2026-10-29T12:00:00.000Z')

describe('checkNote', () => {
  it('trims the body and normalizes the date', () => {
    expect(checkNote({ ...noteInput, body: '  hello  ', occurredAt: '2026-10-20T12:00:00+02:00' }, NOW).input).toEqual({
      ...noteInput,
      body: 'hello',
      occurredAt: '2026-10-20T10:00:00.000Z'
    })
  })

  it('returns codes for blank, oversized, undated and future entries', () => {
    expect(checkNote({ ...noteInput, body: '   ' }, NOW).issues).toEqual([{ field: 'body', code: 'required' }])
    expect(checkNote({ ...noteInput, body: 'x'.repeat(10_001) }, NOW).issues).toEqual([{ field: 'body', code: 'too-long' }])
    expect(checkNote({ ...noteInput, occurredAt: 'yesterday' }, NOW).issues).toEqual([
      { field: 'occurredAt', code: 'invalid-format' }
    ])
    expect(checkNote({ ...noteInput, occurredAt: '2026-11-05T00:00:00.000Z' }, NOW).issues).toEqual([
      { field: 'occurredAt', code: 'in-future' }
    ])
    expect(checkNote({ ...noteInput, occurredAt: '2001-01-01T00:00:00.000Z' }, NOW).input).not.toBeNull()
  })

  it('requires channel and direction for contact entries and drops them from notes', () => {
    expect(checkNote({ ...contactInput, channel: null, direction: null }, NOW).issues).toEqual([
      { field: 'channel', code: 'required' },
      { field: 'direction', code: 'required' }
    ])
    expect(checkNote({ ...noteInput, channel: 'email', direction: 'inbound' }, NOW).input).toMatchObject({
      channel: null,
      direction: null
    })
  })
})

describe('NoteRepository', () => {
  let db: DatabaseSync
  let clients: ClientRepository
  let notes: NoteRepository
  let clientA: string
  let clientB: string

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    configureConnection(db)
    migrate(db)
    let second = 0
    const clock = { now: () => new Date(NOW.getTime() + 1000 * second++), newId: () => crypto.randomUUID() }
    clients = new ClientRepository(db, clock)
    notes = new NoteRepository(db, clock)
    const a = clients.create(clientInput)
    const b = clients.create({ ...clientInput, displayName: 'Bea Muestra' })
    if (!a.ok || !b.ok) throw new Error('fixture clients invalid')
    clientA = a.client.id
    clientB = b.client.id
  })

  it('creates entries and lists them newest first', () => {
    const first = notes.create(clientA, noteInput)
    const second = notes.create(clientA, contactInput)
    const backdated = notes.create(clientA, { ...noteInput, occurredAt: '2025-01-01T00:00:00.000Z', body: 'Old order note' })
    expect(first.ok && second.ok && backdated.ok).toBe(true)
    expect(notes.list(clientA).map((n) => n.body)).toEqual([contactInput.body, noteInput.body, 'Old order note'])
    expect(notes.list(clientA)[0]).toMatchObject({ kind: 'contact', channel: 'fiverr', direction: 'outbound' })
  })

  it('edits an entry, keeps its id and creation time, and marks it as edited', () => {
    const created = notes.create(clientA, noteInput)
    if (!created.ok) throw new Error('create failed')
    const updated = notes.update(clientA, created.note.id, { ...noteInput, body: 'Corrected note' })
    expect(updated).toMatchObject({
      ok: true,
      note: { id: created.note.id, body: 'Corrected note', createdAt: created.note.createdAt }
    })
    if (updated.ok) expect(updated.note.updatedAt > updated.note.createdAt).toBe(true)
  })

  it('never shows or changes one client’s entries through another client', () => {
    const created = notes.create(clientA, noteInput)
    if (!created.ok) throw new Error('create failed')

    expect(notes.list(clientB)).toEqual([])
    expect(notes.update(clientB, created.note.id, { ...noteInput, body: 'Hijacked' })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(notes.list(clientA)[0]?.body).toBe(noteInput.body)
  })

  it('rejects entries for unknown clients and invalid input without storing anything', () => {
    expect(notes.create(crypto.randomUUID(), noteInput)).toEqual({ ok: false, reason: 'not-found' })
    expect(notes.create(clientA, { ...noteInput, body: '' })).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [{ field: 'body', code: 'required' }]
    })
    expect(notes.list(clientA)).toEqual([])
  })

  it('keeps archived clients read-only and system entries uneditable', () => {
    const created = notes.create(clientA, noteInput)
    if (!created.ok) throw new Error('create failed')
    clients.archive(clientA)

    expect(notes.create(clientA, noteInput)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(notes.update(clientA, created.note.id, noteInput)).toEqual({ ok: false, reason: 'wrong-status' })
    const system = notes.list(clientA).find((n) => n.kind === 'system')
    expect(system?.body).toBe('Archived.')

    clients.restore(clientA)
    expect(notes.update(clientA, system!.id, noteInput)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(notes.list(clientA).map((n) => n.kind).sort()).toEqual(['note', 'system', 'system'])
  })
})

describe('notes across restarts', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'tg-notes-test-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('keeps entries and edits after reopening the database', () => {
    const first = openAppDatabase(userData)
    const client = new ClientRepository(first.db).create(clientInput)
    if (!client.ok) throw new Error('create failed')
    const repo = new NoteRepository(first.db)
    const created = repo.create(client.client.id, contactInput)
    if (!created.ok) throw new Error('note failed')
    repo.update(client.client.id, created.note.id, { ...contactInput, body: 'Edited before restart' })
    first.db.close()

    const second = openAppDatabase(userData)
    const [saved] = new NoteRepository(second.db).list(client.client.id)
    expect(saved).toMatchObject({ id: created.note.id, body: 'Edited before restart', kind: 'contact' })
    second.db.close()
  })
})
