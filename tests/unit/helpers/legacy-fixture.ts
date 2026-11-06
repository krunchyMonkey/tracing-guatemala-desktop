import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { APPLICATION_ID, configureConnection, dataDirectory, DATABASE_FILE_NAME } from '../../../src/main/database/connection'
import { migrate, migrations } from '../../../src/main/database/migrations'

// Builds a fictional database as an OLDER app version would have left it (v9 by default),
// using raw SQL only so no current repository can touch tables that do not exist yet.
// Every name, subject and body below is made up.

/** Deterministic 36-character ids: 00000000-0000-4000-8000-<12 digits>. */
export const fid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export interface LegacyIds {
  users: { owner: string; researcher: string; disabled: string; pending: string }
  clients: { ana: string; beto: string; carla: string }
  cases: { anaActive: string; anaIntake: string; betoDelivered: string; betoArchived: string; carlaClosed: string }
  notebooks: { ana: string; beto: string }
  sections: { anaNotes: string; anaArchived: string; betoNotes: string }
  pages: { anaMain: string; anaArchived: string; anaInArchivedSection: string; betoMain: string }
}

export const LEGACY: LegacyIds = {
  users: { owner: fid(101), researcher: fid(102), disabled: fid(103), pending: fid(104) },
  clients: { ana: fid(201), beto: fid(202), carla: fid(203) },
  cases: { anaActive: fid(301), anaIntake: fid(302), betoDelivered: fid(303), betoArchived: fid(304), carlaClosed: fid(305) },
  notebooks: { ana: fid(401), beto: fid(402) },
  sections: { anaNotes: fid(411), anaArchived: fid(412), betoNotes: fid(413) },
  pages: { anaMain: fid(421), anaArchived: fid(422), anaInArchivedSection: fid(423), betoMain: fid(424) }
}

type Value = string | number | null

function insert(db: DatabaseSync, table: string, row: Record<string, Value>): void {
  const columns = Object.keys(row)
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row))
}

const T0 = '2026-09-01T10:00:00.000Z'
const T1 = '2026-09-02T10:00:00.000Z'
const T2 = '2026-09-03T10:00:00.000Z'
const T3 = '2026-09-04T10:00:00.000Z'

const doc = (text: string) => JSON.stringify({ version: 1, blocks: [{ id: 'b1', type: 'paragraph', text }] })

/**
 * Fills `db` (already migrated to `version`, 7..9) with a small but complete fictional research
 * database. Notebook rows need version >= 8, user rows version >= 9.
 */
function populate(db: DatabaseSync, version: number): void {
  const { clients, cases, users, notebooks, sections, pages } = LEGACY

  const client = (id: string, name: string, source: string, status: 'active' | 'archived', createdAt: string) =>
    insert(db, 'clients', {
      id,
      display_name: name,
      source,
      source_detail: source === 'other' ? 'Fictional detail' : null,
      fiverr_username: source === 'fiverr' ? `fictional_${name.split(' ')[0]!.toLowerCase()}` : null,
      email: source === 'direct' ? `${name.split(' ')[0]!.toLowerCase()}@example.test` : null,
      other_contact: null,
      preferred_contact_channel: source === 'fiverr' ? 'fiverr' : source === 'direct' ? 'email' : 'unspecified',
      status,
      created_at: createdAt,
      updated_at: createdAt,
      archived_at: status === 'archived' ? T3 : null
    })
  client(clients.ana, 'Ana Fictional', 'fiverr', 'active', T0)
  client(clients.beto, 'Beto Fictional', 'direct', 'active', T1)
  client(clients.carla, 'Carla Fictional', 'other', 'archived', T2)

  insert(db, 'client_notes', { id: fid(211), client_id: clients.ana, kind: 'note', occurred_at: T0, channel: null, direction: null, body: 'Fictional intake note.', created_at: T0, updated_at: T0 })
  insert(db, 'client_notes', { id: fid(212), client_id: clients.ana, kind: 'contact', occurred_at: T1, channel: 'fiverr', direction: 'inbound', body: 'Fictional message from the buyer.', created_at: T1, updated_at: T1 })
  insert(db, 'client_notes', { id: fid(213), client_id: clients.beto, kind: 'contact', occurred_at: T1, channel: 'email', direction: 'outbound', body: 'Fictional reply.', created_at: T1, updated_at: T1 })
  insert(db, 'client_notes', { id: fid(214), client_id: clients.carla, kind: 'system', occurred_at: T3, channel: null, direction: null, body: 'Archived.', created_at: T3, updated_at: T3 })

  const research = (id: string, clientId: string, title: string, state: string, archivedAt: string | null, due: string | null) =>
    insert(db, 'research_cases', {
      id,
      client_id: clientId,
      title,
      goal: `Fictional goal for ${title}.`,
      order_reference: `FO-FICTION-${id.slice(-3)}`,
      due_date: due,
      state,
      state_changed_at: T2,
      created_at: T0,
      updated_at: T2,
      archived_at: archivedAt
    })
  research(cases.anaActive, clients.ana, 'Fictional grandparents', 'active', null, '2026-12-01')
  research(cases.anaIntake, clients.ana, 'Fictional second branch', 'intake', null, null)
  research(cases.betoDelivered, clients.beto, 'Fictional village records', 'delivered', null, '2026-11-15')
  research(cases.betoArchived, clients.beto, 'Fictional shelved question', 'closed', T3, null)
  research(cases.carlaClosed, clients.carla, 'Fictional old order', 'closed', null, null)

  const event = (n: number, caseId: string, kind: string, from: string | null, to: string | null, at: string) =>
    insert(db, 'case_events', { id: fid(n), case_id: caseId, kind, from_state: from, to_state: to, occurred_at: at })
  event(311, cases.anaActive, 'created', null, 'intake', T0)
  event(312, cases.anaActive, 'state', 'intake', 'active', T1)
  event(313, cases.anaIntake, 'created', null, 'intake', T0)
  event(314, cases.betoDelivered, 'created', null, 'intake', T0)
  event(315, cases.betoArchived, 'created', null, 'intake', T0)
  event(316, cases.betoArchived, 'archived', null, null, T3)
  event(317, cases.carlaClosed, 'created', null, 'intake', T0)

  const brief = (caseId: string, objective: string) =>
    insert(db, 'case_briefs', { case_id: caseId, objective, facts: 'Fictional facts.', people: 'Fictional relatives.', hypotheses: null, questions: 'Fictional open question?', created_at: T1, updated_at: T2 })
  brief(cases.anaActive, 'Fictional objective A')
  brief(cases.betoDelivered, 'Fictional objective B')

  const journal = (n: number, caseId: string, activity: string | null, body: string, at: string) =>
    insert(db, 'case_journal_entries', { id: fid(n), case_id: caseId, occurred_at: at, activity, body, created_at: at, updated_at: at })
  journal(321, cases.anaActive, 'research', 'Fictional journal entry one.', T1)
  journal(322, cases.anaActive, null, 'Fictional journal entry two.', T2)
  journal(323, cases.betoDelivered, 'writing', 'Fictional journal entry three.', T2)

  const task = (n: number, caseId: string, title: string, completedAt: string | null) =>
    insert(db, 'case_tasks', {
      id: fid(n),
      case_id: caseId,
      title,
      description: null,
      status: completedAt ? 'completed' : 'pending',
      due_date: null,
      completed_at: completedAt,
      created_at: T1,
      updated_at: completedAt ?? T1
    })
  task(331, cases.anaActive, 'Fictional open task', null)
  task(332, cases.anaActive, 'Fictional done task', T2)
  task(333, cases.betoDelivered, 'Fictional pending task', null)

  const time = (n: number, caseId: string, clientId: string, minutes: number, source: 'timer' | 'manual') =>
    insert(db, 'case_time_entries', { id: fid(n), case_id: caseId, client_id: clientId, work_date: '2026-09-02', duration_minutes: minutes, activity_type: 'research', note: null, source, created_at: T2, updated_at: T2 })
  time(341, cases.anaActive, clients.ana, 45, 'timer')
  time(342, cases.anaActive, clients.ana, 30, 'manual')
  time(343, cases.betoDelivered, clients.beto, 90, 'manual')

  insert(db, 'case_active_timer', {
    id: 1,
    case_id: cases.anaIntake,
    client_id: clients.ana,
    state: 'running',
    accumulated_seconds: 120,
    segment_started_at: T3,
    last_heartbeat_at: T3,
    started_at: T3,
    version: 1
  })

  if (version >= 8) {
    insert(db, 'case_notebooks', { id: notebooks.ana, case_id: cases.anaActive, client_id: clients.ana, created_at: T1, updated_at: T2 })
    insert(db, 'case_notebooks', { id: notebooks.beto, case_id: cases.betoDelivered, client_id: clients.beto, created_at: T1, updated_at: T2 })

    const section = (id: string, notebookId: string, caseId: string, title: string, position: number, archivedAt: string | null) =>
      insert(db, 'notebook_sections', { id, notebook_id: notebookId, case_id: caseId, title, position, archived_at: archivedAt, created_at: T1, updated_at: T2 })
    section(sections.anaNotes, notebooks.ana, cases.anaActive, 'Fictional notes', 0, null)
    section(sections.anaArchived, notebooks.ana, cases.anaActive, 'Fictional archived section', 1, T3)
    section(sections.betoNotes, notebooks.beto, cases.betoDelivered, 'Fictional notes', 0, null)

    const page = (id: string, sectionId: string, caseId: string, title: string, position: number, pageVersion: number, text: string, archivedAt: string | null) =>
      insert(db, 'notebook_pages', { id, section_id: sectionId, case_id: caseId, title, position, version: pageVersion, content: doc(text), content_version: 1, archived_at: archivedAt, created_at: T1, updated_at: T2 })
    page(pages.anaMain, sections.anaNotes, cases.anaActive, 'Fictional main page', 0, 3, 'Third fictional draft.', null)
    page(pages.anaArchived, sections.anaNotes, cases.anaActive, 'Fictional archived page', 1, 1, 'Fictional archived text.', T3)
    page(pages.anaInArchivedSection, sections.anaArchived, cases.anaActive, 'Fictional page in archived section', 0, 1, 'Fictional text.', null)
    page(pages.betoMain, sections.betoNotes, cases.betoDelivered, 'Fictional main page', 0, 1, 'Fictional page body.', null)

    const revision = (n: number, pageId: string, caseId: string, revisionVersion: number, title: string, text: string, reason: string, at: string) =>
      insert(db, 'notebook_page_revisions', { id: fid(n), page_id: pageId, case_id: caseId, version: revisionVersion, title, content: doc(text), content_version: 1, reason, created_at: at })
    revision(431, pages.anaMain, cases.anaActive, 1, 'Fictional main page', 'First fictional draft.', 'autosave', T1)
    revision(432, pages.anaMain, cases.anaActive, 2, 'Fictional main page', 'Second fictional draft.', 'restore-point', T2)
    revision(433, pages.anaMain, cases.anaActive, 3, 'Fictional main page', 'First fictional draft.', 'restored', T3)
    revision(434, pages.betoMain, cases.betoDelivered, 1, 'Fictional main page', 'Fictional page body.', 'autosave', T1)
  }

  if (version >= 9) {
    const user = (id: string, name: string, role: string, status: string, disabledAt: string | null) =>
      insert(db, 'app_users', {
        id,
        display_name: name,
        role,
        status,
        contact_email: `${name.split(' ')[0]!.toLowerCase()}@example.test`,
        auth_version: 1,
        version: 1,
        created_at: T0,
        updated_at: T1,
        last_sign_in_at: status === 'active' ? T2 : null,
        disabled_at: disabledAt
      })
    user(users.owner, 'Olga Fictional', 'owner', 'active', null)
    user(users.researcher, 'Rafa Fictional', 'researcher', 'active', null)
    user(users.disabled, 'Dani Fictional', 'researcher', 'disabled', T3)
    user(users.pending, 'Pia Fictional', 'researcher', 'pending', null)

    const identity = (userId: string, subject: string) =>
      insert(db, 'user_identities', { provider: 'google', subject, user_id: userId, email: `${subject}@example.test`, email_authoritative: 0, name: 'Fictional Person', bound_at: T1, last_seen_at: T2 })
    identity(users.owner, 'fixture-sub-owner')
    identity(users.researcher, 'fixture-sub-researcher')
    identity(users.disabled, 'fixture-sub-disabled')

    insert(db, 'sign_in_requests', { id: fid(111), provider: 'google', subject: 'fixture-sub-stranger', email: 'stranger@example.test', email_authoritative: 0, name: 'Stranger Fictional', first_seen_at: T2, last_seen_at: T3, attempts: 2 })

    const userEvent = (n: number, userId: string, action: string, at: string) =>
      insert(db, 'user_events', { id: fid(n), user_id: userId, at, action, actor: 'host' })
    userEvent(121, users.owner, 'created', T0)
    userEvent(122, users.owner, 'identity-bound', T1)
    userEvent(123, users.owner, 'activated', T1)
    userEvent(124, users.researcher, 'created', T0)
    userEvent(125, users.disabled, 'disabled', T3)
    userEvent(126, users.pending, 'created', T0)
  }
}

/**
 * Migrates `db` to `version` with the real migration list prefix and fills it with fictional data.
 * `version` 9 is the legacy shape that ships on main before ownership; 7 and 8 are older supported shapes.
 */
export function buildLegacyDatabase(db: DatabaseSync, version: 7 | 8 | 9 = 9): LegacyIds {
  migrate(db, {}, migrations.slice(0, version))
  populate(db, version)
  return LEGACY
}

/** Same, but as a profile on disk under `<userDataDir>/data`, closed (checkpointed) before returning. */
export function buildLegacyProfile(userDataDir: string, version: 7 | 8 | 9 = 9): { file: string; ids: LegacyIds } {
  const dir = dataDirectory(userDataDir)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, DATABASE_FILE_NAME)
  const db = new DatabaseSync(file)
  try {
    configureConnection(db)
    const ids = buildLegacyDatabase(db, version)
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    return { file, ids }
  } finally {
    db.close()
  }
}

/** A single-file legacy database (journal mode DELETE) usable as a restore source. */
export function buildLegacyBackupFile(file: string, version: 7 | 8 | 9 = 9): LegacyIds {
  const db = new DatabaseSync(file)
  try {
    configureConnection(db)
    const ids = buildLegacyDatabase(db, version)
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    db.exec('PRAGMA journal_mode = DELETE')
    return ids
  } finally {
    db.close()
  }
}

/** Counts of the fictional rows a full v9 fixture holds, for assertions. */
export const LEGACY_COUNTS = { clients: 3, cases: 5, users: 4 } as const
