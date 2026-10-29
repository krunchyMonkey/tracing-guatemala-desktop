import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { ClientRepository } from '../../src/main/database/client-repository'
import { configureConnection } from '../../src/main/database/connection'
import { migrate } from '../../src/main/database/migrations'
import { defaultQuery, type Client, type DirectoryQuery } from '../../src/shared/client-model'
import { ARCHIVED_COUNT, isArchivedIndex, MANY_CLIENTS, manyClientInputs } from '../renderer/fixtures/manyClients'

// Directory queries through the real SQLite repository with 60 fictional clients.

let repo: ClientRepository
let created: Client[]

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  configureConnection(db)
  migrate(db)
  let minute = 0
  repo = new ClientRepository(db, {
    now: () => new Date(Date.UTC(2026, 0, 1, 9, minute++)),
    newId: () => crypto.randomUUID()
  })
  created = manyClientInputs().map((input, i) => {
    const result = repo.create(input)
    if (!result.ok) throw new Error(`fixture ${i} invalid`)
    if (isArchivedIndex(i)) repo.archive(result.client.id)
    return result.client
  })
})

const list = (query: Partial<DirectoryQuery>) => repo.list({ ...defaultQuery, ...query })

describe('directory queries (60 fictional clients)', () => {
  it('shows active clients by default, with archived and all options', () => {
    expect(list({})).toHaveLength(MANY_CLIENTS - ARCHIVED_COUNT)
    expect(list({ status: 'archived' })).toHaveLength(ARCHIVED_COUNT)
    expect(list({ status: 'all' })).toHaveLength(MANY_CLIENTS)
    expect(list({ status: 'archived' }).every((c) => c.status === 'archived')).toBe(true)
  })

  it('searches trimmed, accent- and case-insensitively across name, handle, email and other contact', () => {
    const accented = list({ status: 'all', text: 'maria lopez' })
    expect(accented.map((c) => c.displayName)).toEqual(['María López', 'María López', 'María López'])
    expect(list({ status: 'all', text: '  MARÍA   LÓPEZ  ' })).toEqual(accented)

    expect(list({ status: 'all', text: 'demo_buyer_07' }).map((c) => c.fiverrUsername)).toEqual(['demo_buyer_07'])
    expect(list({ status: 'all', text: 'CLIENT08@EXAMPLE' }).map((c) => c.email)).toEqual(['client08@example.com'])
    expect(list({ status: 'all', text: 'whatsapp' })).toHaveLength(MANY_CLIENTS / 5)
  })

  it('does not search source details', () => {
    expect(list({ status: 'all', text: 'previous client' })).toEqual([])
  })

  it('combines source and status filters', () => {
    const result = list({ status: 'all', sources: ['referral', 'other'] })
    expect(result).toHaveLength(MANY_CLIENTS / 2)
    expect(new Set(result.map((c) => c.source))).toEqual(new Set(['referral', 'other']))
    const archivedDirect = list({ status: 'archived', sources: ['direct'] })
    expect(archivedDirect.length).toBeGreaterThan(0)
    expect(archivedDirect.every((c) => c.source === 'direct' && c.status === 'archived')).toBe(true)
  })

  it('sorts by name deterministically, breaking ties by creation time', () => {
    const byName = list({ status: 'all' })
    expect(list({ status: 'all' })).toEqual(byName)
    const marias = byName.filter((c) => c.displayName === 'María López')
    expect(marias.map((c) => c.createdAt)).toEqual(marias.map((c) => c.createdAt).sort())
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
    const names = byName.map((c) => c.displayName)
    expect([...names].sort(collator.compare)).toEqual(names)
  })

  it('sorts by recently added and recently updated', () => {
    expect(list({ status: 'all', sort: 'created' })[0]?.id).toBe(created[MANY_CLIENTS - 1]!.id)

    const target = created[5]!
    repo.update(target.id, { ...manyClientInputs()[5]!, otherContact: 'Edited' })
    expect(list({ status: 'all', sort: 'updated' })[0]?.id).toBe(target.id)
  })

  it('returns no matches without error, and treats SQL-like text as plain text', () => {
    expect(list({ status: 'all', text: 'zzz-no-such-client' })).toEqual([])
    expect(list({ status: 'all', text: "'; DROP TABLE clients; --" })).toEqual([])
    expect(list({ status: 'all' })).toHaveLength(MANY_CLIENTS)
  })
})
