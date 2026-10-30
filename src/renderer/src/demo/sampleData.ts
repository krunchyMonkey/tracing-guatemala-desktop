import type { CaseBrief } from '../../../shared/case-brief'
import type { CaseTask } from '../../../shared/case-tasks'
import type { ActivityType, TimeEntry } from '../../../shared/case-time'
import type { JournalEntry } from '../../../shared/case-journal'
import type { NotebookPage, NotebookSection, PageRevision } from '../../../shared/notebook'
import { localDateString, type CaseEvent, type CaseState, type ResearchCase } from '../../../shared/case-model'
import type { Client, ClientNote, NoteChannel, NoteDirection } from '../../../shared/client-model'
import { portfolioCases, portfolioClients } from './portfolioData'

// The fixture shapes, written with the shared model types only. The fixtures must not
// pull in the runtime (demoApi, demoCases), so the Node-side unit tests can import them.
type DemoClientFixtures = { clients: Client[]; notes: ClientNote[] }
export type DemoNotebookFixtures = {
  notebooks: { id: string; caseId: string }[]
  sections: NotebookSection[]
  pages: NotebookPage[]
  revisions: PageRevision[]
}
type DemoCaseFixtures = {
  cases: ResearchCase[]
  events: CaseEvent[]
  briefs: CaseBrief[]
  journal: JournalEntry[]
  tasks: CaseTask[]
  timeEntries: TimeEntry[]
  notebook: DemoNotebookFixtures
}

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

export function buildDemoData(now: Date = new Date()): DemoClientFixtures {
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

  const portfolio = buildPortfolioClients(now)
  return { clients: [...clients, ...portfolio.clients], notes: [...notes, ...portfolio.notes] }
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

export function buildDemoCases(now: Date = new Date()): DemoCaseFixtures {
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

  // Fictional research hours, dated relative to today (local calendar dates), so the
  // week and month totals always have something to add up.
  const hours = (
    number: number,
    caseId: string,
    daysAgo: number,
    durationMinutes: number,
    activityType: ActivityType | null,
    note: string | null = null
  ): TimeEntry => ({
    id: `de500000-0000-4000-8000-5000000000${String(number).padStart(2, '0')}`,
    caseId,
    workDate: due(-daysAgo),
    durationMinutes,
    activityType,
    note,
    source: number % 2 === 0 ? 'timer' : 'manual',
    createdAt: at(daysAgo, 17),
    updatedAt: at(daysAgo, 17)
  })
  const timeEntries: TimeEntry[] = [
    hours(1, caseIds.paternal, 1, 90, 'research', 'Went through the diocesan baptism index, 1880 to 1890.'),
    hours(2, caseIds.paternal, 3, 120, 'analysis', 'Compared the two possible baptisms.'),
    hours(3, caseIds.paternal, 9, 45, 'correspondence'),
    hours(4, caseIds.paternal, 40, 195, 'research', 'First pass through the family papers.'),
    hours(5, caseIds.maternal, 6, 60, 'research'),
    hours(6, caseIds.maternal, 2, 50, 'correspondence', 'Wrote to the municipal archive.')
  ]

  // A small fictional notebook on the first case: one section, one page with a heading, a
  // paragraph and a checklist. Other cases start without a notebook.
  const nid = (n: number) => `de600000-0000-4000-8000-6000000000${String(n).padStart(2, '0')}`
  const run = (text: string) => [{ text }]
  const notebook: DemoNotebookFixtures = {
    notebooks: [{ id: nid(1), caseId: caseIds.paternal }],
    sections: [
      {
        id: nid(2),
        notebookId: nid(1),
        caseId: caseIds.paternal,
        title: 'Archive visits',
        position: 0,
        archivedAt: null,
        createdAt: at(12, 9),
        updatedAt: at(12, 9)
      }
    ],
    pages: [
      {
        id: nid(3),
        sectionId: nid(2),
        caseId: caseIds.paternal,
        title: 'Diocesan archive, first visit',
        position: 0,
        version: 1,
        archivedAt: null,
        createdAt: at(12, 9),
        updatedAt: at(12, 9),
        content: {
          format: 'tg-note',
          version: 1,
          blocks: [
            { id: nid(10), type: 'heading', level: 1, content: run('Diocesan archive, first visit') },
            {
              id: nid(11),
              type: 'paragraph',
              indent: 0,
              content: run('Fictional notes: the baptism index for 1880 to 1890 is on open shelves; the registers themselves need a request slip.')
            },
            { id: nid(12), type: 'check', indent: 0, checked: true, content: run('Ask for the Ejemplo family baptisms') },
            { id: nid(13), type: 'check', indent: 0, checked: false, content: run('Copy the index page for the second parish') },
            { id: nid(14), type: 'check', indent: 0, checked: false, content: run('Ask about opening hours in December') }
          ]
        }
      }
    ],
    revisions: []
  }

  const portfolio = buildPortfolioCases(now)
  return {
    cases: [...cases, ...portfolio.cases],
    events: [...events, ...portfolio.events],
    briefs: [...briefs, ...portfolio.briefs],
    journal: [...journal, ...portfolio.journal],
    tasks: [...tasks, ...portfolio.tasks],
    timeEntries: [...timeEntries, ...portfolio.timeEntries],
    notebook
  }
}

// ---------- the 48-client portfolio (#115) ----------
// The eight clients and cases above keep their ids, names and records. The rows
// below (portfolioData.ts) add 40 clients and 38 cases with the same rules, built
// without randomness: the same `now` always gives the same data.

/** Fixed ids for the portfolio's records, in the same pattern as the original sample. */
const portfolioClientId = (number: number) => `de300000-0000-4000-8000-${String(number).padStart(12, '0')}`
/** Records other than clients: the first group carries a two-digit kind code (10 case, 11 event, 12 journal, 13 task, 14 time, 15 note). */
const portfolioId = (kind: number, number: number) => `de31${String(kind).padStart(2, '0')}00-0000-4000-8000-${String(number).padStart(12, '0')}`

const JOURNAL_TEMPLATES: readonly [string | null, string][] = [
  ['Archive search', 'Searched the fictional parish index for baptisms in the target decade. Two possible entries, and neither names a father.'],
  ['Record analysis', 'Compared the candidate records with what the client reported. One entry spells the surname differently.'],
  ['Client communication', 'Sent a short progress update and a list of what is still missing.'],
  ['Online database search', 'Checked an online index of fictional civil records. No match under the first spelling; trying variants.'],
  ['Document review', 'Read the family letters the client sent. Two dates still need checking against a second source.'],
  ['Source evaluation', 'Noted how reliable each source is: a transcription, a family story, and one original entry.'],
  ['Writing the report', 'Drafted the outline of the findings summary for review.'],
  [null, 'Wrote down the next search windows and the parishes still to check.']
]

const TASK_TITLES = [
  'Request the civil register extract',
  'Check the municipal index for the marriage year',
  'Draft the interim summary for the client',
  'Ask the client for family photographs',
  'Compare spelling variants of the surname',
  'Confirm the birth year from a second source',
  'Send the progress update',
  'Review the transcription against the original',
  'Prepare the list of open questions',
  'Write the findings summary'
]

const TASK_DESCRIPTIONS = [
  'Keep it short; note what is confirmed and what is still reported.',
  null,
  'Fictional next step: the client may already have the document.'
] as const

const BRIEF_FACTS = [
  'The client reports the family story as told at the first meeting.\nDates are as the client remembers them; none are confirmed yet.',
  'Two family documents were mentioned, and the client has promised copies.\nThe client remembers a move to another town but not the year.',
  'Only the surname and a rough decade are known, as reported.\nNo original record has been seen yet.'
] as const
const BRIEF_PEOPLE = [
  'Names are as the client gave them (fictional).\nOne sibling is mentioned, with no dates.',
  'The great-grandmother is mentioned in two letters, with different first names.',
  'A godparent is mentioned in the story, but not named.'
] as const
const BRIEF_HYPOTHESES = [
  'The surname may have been recorded with a different spelling. Not established.',
  'The family may have moved before the first recorded baptism. Not established.',
  'A second parish may hold the marriage entry. Not established.'
] as const
const BRIEF_QUESTIONS = [
  'Which office or parish holds the earliest record?\nIs there an older relative the client can ask?',
  'Can the client send the letters, or describe them?\nWhich year did the move happen?',
  'Are the registers for that decade available for this municipality?'
] as const

const TIME_DURATIONS = [45, 60, 90, 120, 30, 75, 150, 210] as const
const TIME_ACTIVITIES: readonly ActivityType[] = ['research', 'analysis', 'correspondence', 'writing', 'other']
const TIME_NOTES = [
  'Went through the parish index for the decade.',
  'Compared two transcriptions with the original.',
  'Wrote the client update.',
  'Checked a municipal index online.',
  'Sorted the family letters by date.',
  null
] as const

export function buildPortfolioClients(now: Date): { clients: Client[]; notes: ClientNote[] } {
  const at = (daysAgo: number, hour: number) => {
    const day = new Date(now.getTime() - daysAgo * DAY)
    day.setUTCHours(hour, 0, 0, 0)
    return day.toISOString()
  }
  const clients: Client[] = []
  const notes: ClientNote[] = []

  portfolioClients.forEach((row, index) => {
    const [displayName, source, sourceDetail, fiverrUsername, email, otherContact, channel, status, created, updated, note] = row
    const number = index + 9
    const id = portfolioClientId(number)
    clients.push({
      id,
      displayName,
      source,
      sourceDetail,
      fiverrUsername,
      email,
      otherContact,
      preferredContactChannel: channel,
      status,
      createdAt: at(created, 14),
      updatedAt: at(updated, 16),
      archivedAt: status === 'archived' ? at(updated, 16) : null
    })
    if (note !== null) {
      notes.push({
        id: portfolioId(15, number),
        clientId: id,
        kind: 'note',
        occurredAt: at(Math.max(created - 1, 0), 13),
        channel: null,
        direction: null,
        body: note,
        createdAt: at(Math.max(created - 1, 0), 13),
        updatedAt: at(Math.max(created - 1, 0), 13)
      })
    }
    if (status === 'archived') {
      notes.push({
        id: portfolioId(15, 100 + number),
        clientId: id,
        kind: 'system',
        occurredAt: at(updated, 16),
        channel: null,
        direction: null,
        body: 'Archived.',
        createdAt: at(updated, 16),
        updatedAt: at(updated, 16)
      })
    }
  })
  return { clients, notes }
}

export function buildPortfolioCases(now: Date): Omit<DemoCaseFixtures, 'notebook'> {
  const at = (daysAgo: number, hour = 15) => {
    const day = new Date(now.getTime() - daysAgo * DAY)
    day.setUTCHours(hour, 0, 0, 0)
    return day.toISOString()
  }
  const dateOffset = (days: number) => localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days))

  const cases: ResearchCase[] = []
  const events: CaseEvent[] = []
  const briefs: CaseBrief[] = []
  const journal: JournalEntry[] = []
  const tasks: CaseTask[] = []
  const timeEntries: TimeEntry[] = []
  const dueOffsets: readonly (number | null)[] = [-3, 1, null, 2, 12, 0]

  portfolioCases.forEach((row, index) => {
    const [clientNumber, title, goal, state, path, dueInDays, created, updated, archived] = row
    const k = index + 1
    const caseId = portfolioId(10, k)
    const states = path.split('>') as CaseState[]

    cases.push({
      id: caseId,
      clientId: portfolioClientId(clientNumber),
      title,
      goal,
      orderReference: k % 2 === 0 ? `FO-DEMO-${100 + k}` : null,
      dueDate: dueInDays === null ? null : dateOffset(dueInDays),
      state,
      stateChangedAt: at(updated),
      createdAt: at(created),
      updatedAt: at(updated),
      archivedAt: archived ? at(updated) : null
    })

    // History: created, then one event per step, spread from creation to the last change.
    let eventSeq = 0
    const addEvent = (kind: CaseEvent['kind'], from: CaseState | null, to: CaseState | null, daysAgo: number) => {
      eventSeq += 1
      events.push({ id: portfolioId(11, k * 10 + eventSeq), caseId, kind, fromState: from, toState: to, occurredAt: at(daysAgo) })
    }
    addEvent('created', null, 'intake', created)
    const steps = states.length - 1
    for (let i = 0; i < steps; i += 1) {
      const daysAgo = created - Math.round(((created - updated) * (i + 1)) / steps)
      addEvent('state', states[i]!, states[i + 1]!, daysAgo)
    }
    if (archived) addEvent('archived', null, null, updated)

    // Briefs: most cases have one (every fourth case does not).
    if (k % 4 !== 0) {
      briefs.push({
        caseId,
        objective: goal,
        facts: BRIEF_FACTS[k % 3]!,
        people: k % 3 === 2 ? null : BRIEF_PEOPLE[k % 3]!,
        hypotheses: BRIEF_HYPOTHESES[k % 3]!,
        questions: BRIEF_QUESTIONS[k % 3]!,
        updatedAt: at(updated, 12)
      })
    }

    // Research journal: more entries on open cases.
    const journalCount = state === 'intake' ? k % 2 : state === 'active' || state === 'waiting' ? 1 + (k % 4) : 1 + (k % 2)
    for (let j = 0; j < journalCount; j += 1) {
      const [activity, body] = JOURNAL_TEMPLATES[(k + j) % JOURNAL_TEMPLATES.length]!
      const when = at(Math.max(created - 2 * (j + 1), 0), 10 + j)
      journal.push({ id: portfolioId(12, k * 10 + j), caseId, occurredAt: when, activity, body, createdAt: when, updatedAt: when })
    }

    // Next steps: open cases get 1 to 5, some overdue, due soon, undated or done.
    const taskCount = state === 'active' || state === 'waiting' ? 1 + (k % 5) : state === 'intake' ? k % 2 : k % 3
    const openWork = state === 'active' || state === 'waiting' || state === 'intake'
    for (let j = 0; j < taskCount; j += 1) {
      const doneNow = openWork ? (k + j) % 6 === 0 : true
      const offset: number | null = openWork ? dueOffsets[(k + j) % dueOffsets.length]! : -(4 + j)
      const dueDate = openWork && state === 'intake' ? dateOffset(10) : offset === null ? null : dateOffset(offset)
      const completedDaysAgo = Math.min(created - 1, updated + j)
      const createdAt = at(Math.max(created - 1, 0), 9)
      tasks.push({
        id: portfolioId(13, k * 10 + j),
        caseId,
        title: TASK_TITLES[(k + j * 3) % TASK_TITLES.length]!,
        description: TASK_DESCRIPTIONS[(k + j) % TASK_DESCRIPTIONS.length]!,
        status: doneNow ? 'completed' : 'pending',
        dueDate,
        completedAt: doneNow ? at(completedDaysAgo, 11) : null,
        createdAt,
        updatedAt: doneNow ? at(completedDaysAgo, 11) : createdAt
      })
    }

    // Research hours: open cases carry the most time; every entry is 1 to 720 minutes.
    const hourCount = state === 'active' || state === 'waiting' ? k % 7 : state === 'intake' ? 0 : k % 3
    for (let j = 0; j < hourCount; j += 1) {
      const daysAgo = Math.min(created - 1, 2 + 5 * j)
      const when = at(daysAgo, 17)
      timeEntries.push({
        id: portfolioId(14, k * 10 + j),
        caseId,
        workDate: dateOffset(-daysAgo),
        durationMinutes: TIME_DURATIONS[(k + j) % TIME_DURATIONS.length]!,
        activityType: (k + j) % 7 === 0 ? null : TIME_ACTIVITIES[(k + j) % TIME_ACTIVITIES.length]!,
        note: j % 3 === 0 ? TIME_NOTES[(k + j) % TIME_NOTES.length]! : null,
        source: (k + j) % 2 === 0 ? 'timer' : 'manual',
        createdAt: when,
        updatedAt: when
      })
    }
  })

  return { cases, events, briefs, journal, tasks, timeEntries }
}
