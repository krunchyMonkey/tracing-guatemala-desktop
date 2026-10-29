import type { Client, ClientNote, NoteChannel, NoteDirection } from '../../../shared/client-model'
import type { DemoData } from './demoApi'

// Entirely FICTIONAL starter data for the browser demo. Any resemblance to real
// people is coincidental; emails use the reserved example.com/example.org domains
// and no real records or documents are described. Dates are relative to page
// load so the demo always looks recent.

const DAY = 24 * 60 * 60 * 1000

/** Fixed ids so docs and tests can link to a profile (#/clients/<id>). */
export const demoClientIds = {
  lucia: 'de300000-0000-4000-8000-000000000001',
  daniel: 'de300000-0000-4000-8000-000000000002',
  mariaJose: 'de300000-0000-4000-8000-000000000003',
  sofia: 'de300000-0000-4000-8000-000000000004',
  grace: 'de300000-0000-4000-8000-000000000005',
  ethan: 'de300000-0000-4000-8000-000000000006',
  tomas: 'de300000-0000-4000-8000-000000000007',
  rosa: 'de300000-0000-4000-8000-000000000008'
} as const

export function buildDemoData(now: Date = new Date()): DemoData {
  const at = (daysAgo: number, hour = 15) => {
    const day = new Date(now.getTime() - daysAgo * DAY)
    day.setUTCHours(hour, 0, 0, 0)
    return day.toISOString()
  }

  const client = (
    partial: Partial<Client> & Pick<Client, 'id' | 'displayName' | 'source'>,
    createdDaysAgo: number,
    updatedDaysAgo = createdDaysAgo
  ): Client => ({
    sourceDetail: null,
    fiverrUsername: null,
    email: null,
    otherContact: null,
    preferredContactChannel: 'unspecified',
    status: 'active',
    archivedAt: null,
    createdAt: at(createdDaysAgo, 14),
    updatedAt: at(updatedDaysAgo, 16),
    ...partial
  })

  const ids = demoClientIds
  const clients: Client[] = [
    client(
      {
        id: ids.lucia,
        displayName: 'Lucía Fernández (Quetzaltenango line)',
        source: 'fiverr',
        fiverrUsername: 'lucia_roots_demo',
        email: 'lucia.fernandez@example.com',
        preferredContactChannel: 'fiverr'
      },
      240,
      3
    ),
    client(
      {
        id: ids.daniel,
        displayName: 'Daniel Ochoa',
        source: 'fiverr',
        fiverrUsername: 'dochoa_family',
        preferredContactChannel: 'fiverr'
      },
      190,
      20
    ),
    client(
      {
        id: ids.mariaJose,
        displayName: 'María José Alvarado',
        source: 'referral',
        sourceDetail: 'Referred by a previous Fiverr client',
        email: 'mj.alvarado@example.org',
        preferredContactChannel: 'email'
      },
      130,
      9
    ),
    client(
      {
        id: ids.sofia,
        displayName: 'Sofía Tzul',
        source: 'direct',
        sourceDetail: 'Found the website',
        otherContact: 'Prefers a phone call, evenings only',
        preferredContactChannel: 'other'
      },
      70
    ),
    client(
      { id: ids.grace, displayName: 'Grace Whitfield', source: 'fiverr', fiverrUsername: 'gracew_history' },
      45
    ),
    client(
      {
        id: ids.ethan,
        displayName: 'Ethan Morales-Reyes',
        source: 'fiverr',
        fiverrUsername: 'ethan_mr_demo',
        email: 'ethan.mr@example.com',
        preferredContactChannel: 'email'
      },
      110,
      1
    ),
    // A returning client: archived after the first project, restored for a second one.
    client(
      {
        id: ids.tomas,
        displayName: 'Tomás Recinos',
        source: 'other',
        sourceDetail: 'Met at a community heritage event',
        email: 'tomas.recinos@example.org',
        preferredContactChannel: 'email'
      },
      300,
      12
    ),
    client(
      {
        id: ids.rosa,
        displayName: 'Rosa Chávez Ixcoy',
        source: 'referral',
        sourceDetail: 'Friend of Sofía Tzul',
        email: 'rosa.chavez@example.com',
        preferredContactChannel: 'email',
        status: 'archived',
        archivedAt: at(60, 16)
      },
      160,
      60
    )
  ]

  let n = 0
  const entry = (
    clientId: string,
    daysAgo: number,
    body: string,
    contact?: { channel: NoteChannel; direction: NoteDirection }
  ): ClientNote => {
    const when = at(daysAgo, 13 + (n % 4))
    n += 1
    return {
      id: `de300000-0000-4000-8000-1000000000${String(n).padStart(2, '0')}`,
      clientId,
      kind: contact ? 'contact' : 'note',
      occurredAt: when,
      channel: contact?.channel ?? null,
      direction: contact?.direction ?? null,
      body,
      createdAt: when,
      updatedAt: when
    }
  }
  const system = (clientId: string, daysAgo: number, body: 'Archived.' | 'Restored.'): ClientNote => ({
    ...entry(clientId, daysAgo, body),
    kind: 'system',
    occurredAt: at(daysAgo, 16),
    createdAt: at(daysAgo, 16),
    updatedAt: at(daysAgo, 16)
  })

  const notes: ClientNote[] = [
    entry(ids.lucia, 240, 'First order: paternal line from Quetzaltenango, starting with the grandparents.', {
      channel: 'fiverr',
      direction: 'inbound'
    }),
    entry(ids.lucia, 200, 'Sent the first summary of what was found so far.', { channel: 'fiverr', direction: 'outbound' }),
    entry(ids.lucia, 3, 'Next step: check the civil registry index for the great-grandparents’ marriage.'),
    entry(ids.daniel, 190, 'Wants to know which town the family came from. Only has a surname and a decade.'),
    entry(ids.daniel, 20, 'Asked whether we can continue after the holidays.', { channel: 'fiverr', direction: 'inbound' }),
    entry(ids.mariaJose, 130, 'Introduced herself by email after a referral.', { channel: 'email', direction: 'inbound' }),
    entry(ids.mariaJose, 9, 'Shared a family tree draft (fictional demo entry).'),
    entry(ids.sofia, 70, 'Called to talk about her maternal grandmother’s side.', { channel: 'other', direction: 'inbound' }),
    entry(ids.ethan, 110, 'Interested in a second branch once the first report is done.'),
    entry(ids.ethan, 1, 'Sent the report and asked for feedback.', { channel: 'email', direction: 'outbound' }),
    entry(ids.tomas, 300, 'First project: a short family history for a reunion.'),
    system(ids.tomas, 220, 'Archived.'),
    system(ids.tomas, 12, 'Restored.'),
    entry(ids.tomas, 12, 'Came back for a second line. Restored the profile to keep the history together.', {
      channel: 'email',
      direction: 'inbound'
    }),
    entry(ids.rosa, 160, 'Small one-off request: spelling variations of a surname.'),
    system(ids.rosa, 60, 'Archived.')
  ]

  return { clients, notes }
}
