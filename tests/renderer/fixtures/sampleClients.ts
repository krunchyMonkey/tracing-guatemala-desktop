import type { Client, ClientNote } from '../../../src/renderer/src/clients/model'

// Entirely FICTIONAL sample clients used by tests and screenshots. Any resemblance to real
// people is coincidental. Emails use the reserved example.com/example.org domains.

function client(partial: Partial<Client> & Pick<Client, 'id' | 'displayName' | 'source' | 'createdAt'>): Client {
  return {
    sourceDetail: null,
    fiverrUsername: null,
    email: null,
    otherContact: null,
    preferredContactChannel: 'unspecified',
    status: 'active',
    updatedAt: partial.createdAt,
    archivedAt: null,
    ...partial
  }
}

export const sampleClients: Client[] = [
  client({
    id: '7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a01',
    displayName: 'Lucía Fernández (Quetzaltenango line)',
    source: 'fiverr',
    fiverrUsername: 'lucia_roots_demo',
    email: 'lucia.fernandez@example.com',
    preferredContactChannel: 'fiverr',
    createdAt: '2026-02-03T15:20:00.000Z',
    updatedAt: '2026-10-21T18:05:00.000Z'
  }),
  client({
    id: '7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a02',
    displayName: 'Daniel Ochoa',
    source: 'fiverr',
    fiverrUsername: 'dochoa_family',
    preferredContactChannel: 'fiverr',
    createdAt: '2026-04-11T09:00:00.000Z',
    updatedAt: '2026-09-30T14:12:00.000Z'
  }),
  client({
    id: '7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a03',
    displayName: 'María José Alvarado',
    source: 'referral',
    sourceDetail: 'Referred by a previous Fiverr client',
    email: 'mj.alvarado@example.org',
    preferredContactChannel: 'email',
    createdAt: '2026-06-18T20:45:00.000Z',
    updatedAt: '2026-10-02T16:30:00.000Z'
  }),
  client({
    id: '7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a04',
    displayName: 'Ethan Morales-Reyes',
    source: 'fiverr',
    fiverrUsername: 'ethan_mr_demo',
    email: 'ethan.mr@example.com',
    preferredContactChannel: 'email',
    createdAt: '2026-07-07T12:00:00.000Z',
    updatedAt: '2026-10-25T10:15:00.000Z'
  }),
  client({
    id: '7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a05',
    displayName: 'Sofía Tzul',
    source: 'direct',
    sourceDetail: 'Found the website',
    otherContact: 'Prefers a call over WhatsApp, evenings only',
    preferredContactChannel: 'other',
    createdAt: '2026-08-22T17:10:00.000Z'
  }),
  client({
    id: '7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a06',
    displayName: 'Grace Whitfield',
    source: 'fiverr',
    fiverrUsername: 'gracew_history',
    createdAt: '2026-09-14T08:40:00.000Z'
  }),
  client({
    id: '7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a07',
    displayName: 'Andrés Cifuentes',
    source: 'other',
    sourceDetail: 'Met at a community heritage event',
    createdAt: '2026-10-27T19:00:00.000Z'
  }),
  client({
    id: '7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a08',
    displayName: 'Rebecca Ixcot',
    source: 'fiverr',
    fiverrUsername: 'becca_ixcot_demo',
    preferredContactChannel: 'fiverr',
    status: 'archived',
    createdAt: '2025-11-02T13:00:00.000Z',
    updatedAt: '2026-05-01T11:00:00.000Z',
    archivedAt: '2026-05-01T11:00:00.000Z'
  }),
  client({
    id: '7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a09',
    displayName: 'Tomás Herrera',
    source: 'referral',
    email: 'tomas.h@example.com',
    preferredContactChannel: 'email',
    status: 'archived',
    createdAt: '2025-12-15T10:30:00.000Z',
    updatedAt: '2026-03-20T09:00:00.000Z',
    archivedAt: '2026-03-20T09:00:00.000Z'
  })
]

const lucia = '7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a01'
const daniel = '7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a02'
const rebecca = '7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a08'

const rawNotes: Omit<ClientNote, 'createdAt' | 'updatedAt'>[] = [
  {
    id: '9e0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a01',
    clientId: lucia,
    kind: 'contact',
    occurredAt: '2026-02-03T15:30:00.000Z',
    channel: 'fiverr',
    direction: 'inbound',
    body: 'First order: Standard package. Wants to trace her great-grandmother’s family in Quetzaltenango.'
  },
  {
    id: '9e0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a02',
    clientId: lucia,
    kind: 'note',
    occurredAt: '2026-02-10T21:00:00.000Z',
    channel: null,
    direction: null,
    body: 'Questionnaire lists two possible spellings of the surname. Check both in baptism records.'
  },
  {
    id: '9e0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a03',
    clientId: lucia,
    kind: 'contact',
    occurredAt: '2026-03-01T16:00:00.000Z',
    channel: 'fiverr',
    direction: 'outbound',
    body: 'Delivered final report through Fiverr.'
  },
  {
    id: '9e0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a04',
    clientId: lucia,
    kind: 'contact',
    occurredAt: '2026-10-21T18:00:00.000Z',
    channel: 'email',
    direction: 'outbound',
    body: 'Repeat client: sent a custom offer (Premium package, adjusted price) for the paternal line.'
  },
  {
    id: '9e0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a05',
    clientId: daniel,
    kind: 'note',
    occurredAt: '2026-09-30T14:10:00.000Z',
    channel: null,
    direction: null,
    body: 'Waiting on the scanned family bible pages he mentioned.'
  },
  {
    id: '9e0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a06',
    clientId: rebecca,
    kind: 'system',
    occurredAt: '2026-05-01T11:00:00.000Z',
    channel: null,
    direction: null,
    body: 'Archived.'
  }
]

/** Written when they happened and never edited. */
export const sampleNotes: ClientNote[] = rawNotes.map((note) => ({
  ...note,
  createdAt: note.occurredAt,
  updatedAt: note.occurredAt
}))
