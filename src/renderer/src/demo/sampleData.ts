import type { CaseBrief } from '../../../shared/case-brief'
import type { CaseTask } from '../../../shared/case-tasks'
import type { JournalEntry } from '../../../shared/case-journal'
import { localDateString, type CaseEvent, type CaseState, type ResearchCase } from '../../../shared/case-model'
import type { Client, ClientNote, NoteChannel, NoteDirection } from '../../../shared/client-model'
import type { DemoCaseData } from './demoCases'
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

/**
 * Fictional research cases. Due dates are relative to today, so one is always
 * overdue and another is due soon. Ids are fixed (#/cases/<id>) for docs and tests.
 */
export const demoCaseIds = {
  paternal: 'de300000-0000-4000-8000-200000000001',
  maternal: 'de300000-0000-4000-8000-200000000002',
  baptism: 'de300000-0000-4000-8000-200000000003',
  surname: 'de300000-0000-4000-8000-200000000004',
  secondBranch: 'de300000-0000-4000-8000-200000000005',
  reunion: 'de300000-0000-4000-8000-200000000006',
  spelling: 'de300000-0000-4000-8000-200000000007'
} as const

export function buildDemoCases(now: Date = new Date()): DemoCaseData {
  const at = (daysAgo: number, hour = 15) => {
    const day = new Date(now.getTime() - daysAgo * DAY)
    day.setUTCHours(hour, 0, 0, 0)
    return day.toISOString()
  }
  const due = (daysFromToday: number) => localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday))

  const ids = demoClientIds
  const caseIds = demoCaseIds
  let eventNumber = 0
  const events: CaseEvent[] = []
  const history = (caseId: string, steps: [CaseState, CaseEvent['kind'], number][]) => {
    let from: CaseState | null = null
    for (const [to, kind, daysAgo] of steps) {
      eventNumber += 1
      events.push({
        id: `de300000-0000-4000-8000-3000000000${String(eventNumber).padStart(2, '0')}`,
        caseId,
        kind,
        fromState: from,
        toState: to,
        occurredAt: at(daysAgo)
      })
      from = to
    }
  }

  const make = (
    partial: Pick<ResearchCase, 'id' | 'clientId' | 'title' | 'state'> & Partial<ResearchCase>,
    createdDaysAgo: number,
    updatedDaysAgo: number
  ): ResearchCase => ({
    goal: null,
    orderReference: null,
    dueDate: null,
    stateChangedAt: at(updatedDaysAgo),
    createdAt: at(createdDaysAgo),
    updatedAt: at(updatedDaysAgo),
    archivedAt: null,
    ...partial
  })

  const cases: ResearchCase[] = [
    make(
      {
        id: caseIds.paternal,
        clientId: ids.lucia,
        title: 'Paternal line — Quetzaltenango, 1880s',
        state: 'active',
        goal: 'I would like to know where my great-grandfather was born and the names of his parents.\nAny photographs would be a wonderful bonus.',
        orderReference: 'FO-DEMO-0042',
        dueDate: due(6)
      },
      40,
      3
    ),
    make(
      {
        id: caseIds.maternal,
        clientId: ids.lucia,
        title: 'Maternal grandparents — Totonicapán',
        state: 'waiting',
        goal: 'Confirm the marriage year and the grandmother’s maiden name.',
        orderReference: 'FO-DEMO-0039',
        dueDate: due(-4)
      },
      75,
      9
    ),
    make(
      {
        id: caseIds.baptism,
        clientId: ids.lucia,
        title: 'Baptism search — San Pedro (fictional parish)',
        state: 'closed',
        orderReference: 'FO-DEMO-0021',
        dueDate: due(-60)
      },
      200,
      90
    ),
    make(
      {
        id: caseIds.surname,
        clientId: ids.daniel,
        title: 'Surname origin — one family, one town',
        state: 'intake',
        goal: 'Which town did the family come from? We only know the surname and the decade.'
      },
      6,
      6
    ),
    make(
      {
        id: caseIds.secondBranch,
        clientId: ids.ethan,
        title: 'Second branch report',
        state: 'delivered',
        orderReference: 'FO-DEMO-0044',
        dueDate: due(-2)
      },
      45,
      1
    ),
    make(
      {
        id: caseIds.reunion,
        clientId: ids.tomas,
        title: 'Short family history for a reunion',
        state: 'closed',
        archivedAt: at(30),
        dueDate: due(-120)
      },
      300,
      30
    ),
    make(
      {
        id: caseIds.spelling,
        clientId: ids.rosa,
        title: 'Surname spelling variations',
        state: 'closed',
        dueDate: due(-150)
      },
      160,
      100
    )
  ]

  history(caseIds.paternal, [['intake', 'created', 40], ['active', 'state', 30]])
  history(caseIds.maternal, [['intake', 'created', 75], ['active', 'state', 70], ['waiting', 'state', 9]])
  history(caseIds.baptism, [['intake', 'created', 200], ['active', 'state', 195], ['delivered', 'state', 120], ['closed', 'state', 90]])
  history(caseIds.surname, [['intake', 'created', 6]])
  history(caseIds.secondBranch, [['intake', 'created', 45], ['active', 'state', 40], ['delivered', 'state', 1]])
  history(caseIds.reunion, [['intake', 'created', 300], ['active', 'state', 290], ['delivered', 'state', 260], ['closed', 'state', 250]])
  history(caseIds.spelling, [['intake', 'created', 160], ['active', 'state', 150], ['closed', 'state', 100]])
  events.push({
    id: 'de300000-0000-4000-8000-300000000099',
    caseId: caseIds.reunion,
    kind: 'archived',
    fromState: null,
    toState: null,
    occurredAt: at(30)
  })

  // Fictional working material: invented people and places, "as reported" facts only.
  const briefs: CaseBrief[] = [
    {
      caseId: caseIds.paternal,
      objective:
        'Identify the birthplace and parents of Teodoro Ejemplo (born about 1884) and test whether the family moved from the highlands before 1900.',
      facts:
        'The client says Teodoro was born in a village near Quetzaltenango.\nThe client has a family story that he worked as a muleteer.\nA photograph is said to exist, but the client has not sent it yet.',
      people:
        'Teodoro Ejemplo (great-grandfather, about 1884 to unknown).\nHis wife, reported as Rosalía, married in the 1900s.\nThe client’s grandfather, Ismael, was the eldest son.',
      hypotheses:
        'Teodoro may be the son of a Julián Ejemplo listed in a fictional parish book.\nThe family may have spelled the surname “Exemplo” before 1900.',
      questions:
        'Which parish covered the village in the 1880s?\nIs there a marriage record naming Teodoro’s parents?\nCan the client send the photograph?',
      updatedAt: at(3)
    },
    {
      caseId: caseIds.maternal,
      objective: 'Confirm the marriage year and the grandmother’s maiden name for the Totonicapán branch.',
      facts: 'The client reports the marriage took place around 1931.\nThe grandmother’s name is reported as María Ejemplo.',
      people: null,
      hypotheses: 'Her maiden name may be “Sample”, a surname common in the fictional parish.',
      questions: 'Are civil marriage registers for 1931 available for this municipality?',
      updatedAt: at(9)
    },
    {
      caseId: caseIds.surname,
      objective: null,
      facts: 'Only the surname and a decade (the 1920s) are known, as reported by the client.',
      people: null,
      hypotheses: null,
      questions: 'Which towns record this surname most often? Is there any older relative the client can ask?',
      updatedAt: at(6)
    }
  ]

  // Fictional research log. The first two entries share a time to show the tie order
  // (the one written last is listed first). Two cases of the same client have entries.
  const logTime = at(4, 10)
  const entry = (number: number, caseId: string, occurredAt: string, activity: string | null, body: string, editedAt?: string): JournalEntry => ({
    id: `de300000-0000-4000-8000-4000000000${String(number).padStart(2, '0')}`,
    caseId,
    occurredAt,
    activity,
    body,
    createdAt: occurredAt,
    updatedAt: editedAt ?? occurredAt
  })
  const journal: JournalEntry[] = [
    entry(1, caseIds.paternal, at(20, 16), 'Archive search', 'Searched the fictional diocesan index for baptisms of the Ejemplo family, 1880 to 1890.\nFound two possible entries; neither names a father.'),
    {
      ...entry(2, caseIds.paternal, logTime, 'Record analysis', 'Compared the two possible baptisms with the family story.\nThe second one fits the date the client gave.'),
      createdAt: at(4, 11),
      updatedAt: at(4, 11)
    },
    {
      ...entry(3, caseIds.paternal, logTime, 'Client communication', 'Asked the client for the photograph and any letters. Waiting for a reply.'),
      createdAt: at(4, 12),
      updatedAt: at(3, 9)
    },
    entry(4, caseIds.maternal, at(12, 15), 'Online database search', 'Looked for the 1931 marriage in an online index of fictional civil records. No match under “Ejemplo”; trying spelling variants next.'),
    entry(5, caseIds.maternal, at(8, 15), null, 'Wrote down the variants to try: Ejemplos, Exemplo, Egemplo.')
  ]

  // Fictional next steps, with deadlines relative to today: one overdue, one due
  // today, one due soon, one later, some without a date, and one already done.
  const task = (
    number: number,
    caseId: string,
    title: string,
    dueInDays: number | null,
    description: string | null = null,
    completedDaysAgo?: number
  ): CaseTask => ({
    id: `de400000-0000-4000-8000-4000000000${String(number).padStart(2, '0')}`,
    caseId,
    title,
    description,
    status: completedDaysAgo === undefined ? 'pending' : 'completed',
    dueDate: dueInDays === null ? null : due(dueInDays),
    completedAt: completedDaysAgo === undefined ? null : at(completedDaysAgo, 11),
    createdAt: at(12, 9),
    updatedAt: completedDaysAgo === undefined ? at(12, 9) : at(completedDaysAgo, 11)
  })
  const tasks: CaseTask[] = [
    task(1, caseIds.paternal, 'Ask the client for the photograph and letters', -2, 'They mentioned a photograph of Teodoro; ask whether any letters survive too.'),
    task(2, caseIds.paternal, 'Search the 1880s baptism index for the second parish', 0),
    task(3, caseIds.paternal, 'Compare spelling variants of the surname', 2),
    task(4, caseIds.paternal, 'Draft the interim findings summary', 14, 'Keep it to one page; list what is confirmed and what is still reported.'),
    task(5, caseIds.paternal, 'Note down archive opening hours', null),
    task(6, caseIds.paternal, 'Confirm the client’s grandfather’s birth year', -20, null, 15),
    task(7, caseIds.maternal, 'Request 1931 civil marriage register extract', -4),
    task(8, caseIds.maternal, 'Try the spelling variants in the online index', 5)
  ]

  return { cases, events, briefs, journal, tasks }
}
