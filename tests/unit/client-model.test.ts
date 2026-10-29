import { describe, expect, it } from 'vitest'
import {
  defaultQuery,
  emptyFormValues,
  findDuplicates,
  foldText,
  queryClients,
  validateClient,
  type ClientFormValues
} from '../../src/renderer/src/clients/model'
import { sampleClients } from '../renderer/fixtures/sampleClients'

const valid: ClientFormValues = { ...emptyFormValues, displayName: '  Ana   Ejemplo ', source: 'fiverr' }

function errorFields(values: ClientFormValues) {
  return validateClient(values)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.field)
}

describe('validateClient', () => {
  it('requires only a name and a source', () => {
    expect(errorFields(emptyFormValues)).toEqual(['displayName', 'source'])
    const { input } = validateClient(valid)
    expect(input).toEqual({
      displayName: 'Ana Ejemplo',
      source: 'fiverr',
      sourceDetail: null,
      fiverrUsername: null,
      email: null,
      otherContact: null,
      preferredContactChannel: 'unspecified'
    })
  })

  it('normalizes the Fiverr username and blank optional fields', () => {
    const { input } = validateClient({ ...valid, fiverrUsername: ' @demo_user ', email: '   ' })
    expect(input?.fiverrUsername).toBe('demo_user')
    expect(input?.email).toBeNull()
  })

  it('rejects malformed values', () => {
    expect(errorFields({ ...valid, email: 'ana@example' })).toEqual(['email'])
    expect(errorFields({ ...valid, fiverrUsername: 'has space' })).toEqual(['fiverrUsername'])
    expect(errorFields({ ...valid, displayName: 'x'.repeat(121) })).toEqual(['displayName'])
    expect(errorFields({ ...valid, displayName: 'Tab\tName' })).toEqual([])
    expect(errorFields({ ...valid, displayName: 'Bell\u0007Name' })).toEqual(['displayName'])
  })

  it('requires an email when email is the preferred channel, but only warns for Fiverr', () => {
    expect(errorFields({ ...valid, preferredContactChannel: 'email' })).toEqual(['email'])

    const fiverr = validateClient({ ...valid, preferredContactChannel: 'fiverr' })
    expect(fiverr.input).not.toBeNull()
    expect(fiverr.issues).toContainEqual(expect.objectContaining({ field: 'fiverrUsername', severity: 'warning' }))
  })
})

describe('findDuplicates', () => {
  const input = validateClient(valid).input!

  it('matches names regardless of accents, case and spacing, including archived clients', () => {
    const matches = findDuplicates({ ...input, displayName: 'tomas  HERRERA' }, sampleClients)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.client.status).toBe('archived')
    expect(matches[0]!.signals).toEqual(['displayName'])
  })

  it('matches email and Fiverr username case-insensitively', () => {
    const matches = findDuplicates(
      { ...input, email: 'LUCIA.FERNANDEZ@example.com', fiverrUsername: 'Lucia_Roots_Demo' },
      sampleClients
    )
    expect(matches.map((m) => m.signals)).toEqual([['email', 'fiverrUsername']])
  })

  it('ignores the record being edited', () => {
    const daniel = sampleClients.find((c) => c.displayName === 'Daniel Ochoa')!
    expect(findDuplicates({ ...input, displayName: 'Daniel Ochoa' }, sampleClients, daniel.id)).toEqual([])
  })
})

describe('queryClients', () => {
  const names = (q: Partial<typeof defaultQuery>) =>
    queryClients(sampleClients, { ...defaultQuery, ...q }).map((c) => c.displayName)

  it('shows only active clients by default, sorted by name', () => {
    const result = names({})
    expect(result).not.toContain('Tomás Herrera')
    expect(result[0]).toBe('Andrés Cifuentes')
    expect([...result].sort((a, b) => foldText(a).localeCompare(foldText(b)))).toEqual(result)
  })

  it('searches without regard to accents across name, username and email', () => {
    expect(names({ text: 'lucia' })).toEqual(['Lucía Fernández (Quetzaltenango line)'])
    expect(names({ text: 'dochoa' })).toEqual(['Daniel Ochoa'])
    expect(names({ text: 'example.org' })).toEqual(['María José Alvarado'])
  })

  it('filters by status and source', () => {
    expect(names({ status: 'archived' })).toEqual(['Rebecca Ixcot', 'Tomás Herrera'])
    expect(names({ status: 'all', sources: ['referral'] })).toEqual(['María José Alvarado', 'Tomás Herrera'])
  })

  it('sorts by most recently updated', () => {
    expect(names({ sort: 'updated' })[0]).toBe('Andrés Cifuentes')
  })
})
