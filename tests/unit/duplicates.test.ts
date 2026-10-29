import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { ClientRepository } from '../../src/main/database/client-repository'
import { configureConnection } from '../../src/main/database/connection'
import { migrate } from '../../src/main/database/migrations'
import { duplicateNameKey, type Client, type ClientInput } from '../../src/shared/client-model'

// Duplicate advisory (client-model/v1 §4.3) through the real SQLite repository.
// Fictional data only.

const blank: ClientInput = {
  displayName: '',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: null,
  email: null,
  otherContact: null,
  preferredContactChannel: 'unspecified'
}

let repo: ClientRepository
let rosa: Client
let tomas: Client

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  configureConnection(db)
  migrate(db)
  repo = new ClientRepository(db)
  const create = (input: Partial<ClientInput>) => {
    const result = repo.create({ ...blank, ...input })
    if (!result.ok) throw new Error('fixture invalid')
    return result.client
  }
  rosa = create({ displayName: 'Rosa M. (Quetzaltenango line)', fiverrUsername: 'Rosa_Roots_01', email: 'rosa.example@example.com' })
  tomas = create({ displayName: 'Tomás Herrera', source: 'referral' })
  repo.archive(tomas.id)
  create({ displayName: 'María-José Pérez' })
})

const check = (input: Partial<ClientInput>, excludeId: string | null = null) =>
  repo.findDuplicates({ ...blank, displayName: 'Someone New', ...input }, excludeId).map((m) => ({
    name: m.client.displayName,
    signals: m.signals
  }))

describe('duplicateNameKey', () => {
  it('ignores accents, case, spacing and punctuation', () => {
    expect(duplicateNameKey('  María-José   PÉREZ ')).toBe('maria jose perez')
    expect(duplicateNameKey('Rosa M. (Quetzaltenango line)')).toBe(duplicateNameKey('rosa m quetzaltenango line'))
    expect(duplicateNameKey("O'Brien")).toBe(duplicateNameKey('O Brien'))
  })
})

describe('ClientRepository.findDuplicates', () => {
  it('flags the same Fiverr username, ignoring case and a leading @', () => {
    expect(check({ fiverrUsername: '@rosa_roots_01' })).toEqual([{ name: rosa.displayName, signals: ['fiverrUsername'] }])
  })

  it('flags the same email, ignoring case and surrounding spaces', () => {
    expect(check({ email: '  ROSA.Example@EXAMPLE.com ' })).toEqual([{ name: rosa.displayName, signals: ['email'] }])
  })

  it('flags near-identical names: accents, case, spacing and punctuation', () => {
    expect(check({ displayName: 'rosa m quetzaltenango line' })).toEqual([
      { name: rosa.displayName, signals: ['displayName'] }
    ])
    expect(check({ displayName: 'Maria Jose  Perez' })).toEqual([{ name: 'María-José Pérez', signals: ['displayName'] }])
  })

  it('includes archived clients', () => {
    const [match] = repo.findDuplicates({ ...blank, displayName: 'tomas herrera' }, null)
    expect(match?.client).toMatchObject({ id: tomas.id, status: 'archived' })
  })

  it('reports every matching signal on one candidate', () => {
    expect(
      check({ displayName: 'Rosa M (Quetzaltenango line)', email: 'rosa.example@example.com', fiverrUsername: 'rosa_roots_01' })
    ).toEqual([{ name: rosa.displayName, signals: ['email', 'fiverrUsername', 'displayName'] }])
  })

  it('does not flag the client being edited', () => {
    expect(check({ displayName: rosa.displayName, fiverrUsername: 'rosa_roots_01' }, rosa.id)).toEqual([])
  })

  it.each([
    ['a longer name', { displayName: 'Tomás Herrera López' }],
    ['a shorter name', { displayName: 'Rosa M.' }],
    ['a one-letter difference', { displayName: 'Tomás Herreras' }],
    ['a similar handle', { fiverrUsername: 'rosa_roots_011' }],
    ['the same email domain', { email: 'someone.else@example.com' }],
    ['the same other-contact text', { otherContact: 'WhatsApp' }]
  ])('does not flag %s (false positive)', (_label, input) => {
    expect(check(input)).toEqual([])
  })

  it('returns nothing for invalid input instead of guessing', () => {
    expect(repo.findDuplicates({ ...blank, displayName: '   ' }, null)).toEqual([])
    expect(repo.findDuplicates({ ...blank, displayName: 'Tomás Herrera', email: 'not-an-email' }, null)).toEqual([])
  })

  it('never changes stored clients', () => {
    const before = repo.list({ text: '', status: 'all', sources: [], sort: 'name' })
    repo.findDuplicates({ ...blank, displayName: 'Tomás Herrera' }, null)
    expect(repo.list({ text: '', status: 'all', sources: [], sort: 'name' })).toEqual(before)
  })
})
