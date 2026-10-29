import type { Client, ClientInput, ClientSource, ContactChannel } from '../../../src/shared/client-model'

// 60 FICTIONAL clients for directory tests: accented and duplicate names,
// every source, sparse optional fields, and every seventh one archived.

const givenNames = ['María', 'José', 'Ana', 'Luis', 'Lucía', 'Andrés', 'Sofía', 'Héctor', 'Elena', 'Tomás']
const familyNames = ['López', 'Pérez', 'García', 'Ixcoy', 'Morales', 'Chávez']
const sources: ClientSource[] = ['fiverr', 'referral', 'direct', 'other']

export const MANY_CLIENTS = 60

export const isArchivedIndex = (i: number) => i % 7 === 3

export const ARCHIVED_COUNT = Array.from({ length: MANY_CLIENTS }, (_, i) => i).filter(isArchivedIndex).length

export function manyClientInputs(): ClientInput[] {
  return Array.from({ length: MANY_CLIENTS }, (_, i) => {
    const given = givenNames[i % givenNames.length]!
    const family = familyNames[Math.floor(i / givenNames.length) % familyNames.length]!
    const hasEmail = i % 3 !== 0
    const hasHandle = i % 4 !== 0
    const preferredContactChannel: ContactChannel = hasEmail ? 'email' : hasHandle ? 'fiverr' : 'unspecified'
    return {
      // Indexes 0, 20 and 40 share the name "María López" (duplicates are allowed).
      displayName: i % 20 === 0 ? 'María López' : `${given} ${family}`,
      source: sources[i % sources.length]!,
      sourceDetail: i % 4 === 1 ? 'Referred by a previous client' : null,
      fiverrUsername: hasHandle ? `demo_buyer_${String(i).padStart(2, '0')}` : null,
      email: hasEmail ? `client${String(i).padStart(2, '0')}@example.com` : null,
      otherContact: i % 5 === 0 ? 'WhatsApp, ask on Fiverr first' : null,
      preferredContactChannel
    }
  })
}

/** The same clients as stored records, created one minute apart. */
export function manyClients(): Client[] {
  return manyClientInputs().map((input, i) => {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 9, i)).toISOString()
    const archived = isArchivedIndex(i)
    return {
      ...input,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      status: archived ? 'archived' : 'active',
      createdAt,
      updatedAt: createdAt,
      archivedAt: archived ? createdAt : null
    }
  })
}
