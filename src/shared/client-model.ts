// client-model/v1 (docs/client-data-model.md): types and pure rules shared by the
// main process (the authority) and the renderer (convenience checks only).
// No runtime dependencies, so the sandboxed preload can import types from here.

export type ClientSource = 'fiverr' | 'referral' | 'direct' | 'other'
export type ContactChannel = 'fiverr' | 'email' | 'other' | 'unspecified'
export type ClientStatus = 'active' | 'archived'

export const CLIENT_SOURCES: readonly ClientSource[] = ['fiverr', 'referral', 'direct', 'other']
export const CONTACT_CHANNELS: readonly ContactChannel[] = ['fiverr', 'email', 'other', 'unspecified']
export const CLIENT_STATUSES: readonly ClientStatus[] = ['active', 'archived']

export interface Client {
  id: string
  displayName: string
  source: ClientSource
  sourceDetail: string | null
  fiverrUsername: string | null
  email: string | null
  otherContact: string | null
  preferredContactChannel: ContactChannel
  status: ClientStatus
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

/** What the renderer may send on create/edit. System fields are never accepted from it. */
export type ClientInput = Pick<
  Client,
  'displayName' | 'source' | 'sourceDetail' | 'fiverrUsername' | 'email' | 'otherContact' | 'preferredContactChannel'
>

export const NAME_MAX = 120
export const SHORT_TEXT_MAX = 200
export const FIVERR_USERNAME_MAX = 60
export const EMAIL_MAX = 254
export const NOTE_MAX = 10_000

// ---------- normalization and validation ----------

/** Input before normalization: text fields may be blank or padded, source may be unset. */
export interface ClientDraft {
  displayName: string
  source: ClientSource | ''
  sourceDetail: string | null
  fiverrUsername: string | null
  email: string | null
  otherContact: string | null
  preferredContactChannel: ContactChannel
}

export type ClientField = keyof ClientInput
export type Severity = 'error' | 'warning' | 'info'
export type IssueCode =
  | 'required'
  | 'too-long'
  | 'invalid-characters'
  | 'invalid-format'
  | 'contains-spaces'
  | 'required-for-channel'
  | 'missing-for-channel'
  | 'no-contact-details'

/** A rule outcome. Carries only a field name and a code, never the submitted value. */
export interface ClientIssue {
  field: ClientField | null
  severity: Severity
  code: IssueCode
}

export interface ClientCheck {
  input: ClientInput | null
  issues: ClientIssue[]
}

const CONTROL_CHARS = /\p{Cc}/u
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function optional(value: string | null): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** Normalize and validate a draft (§4.1, §4.2). `input` is null whenever there is an error. */
export function checkClient(draft: ClientDraft): ClientCheck {
  const issues: ClientIssue[] = []
  const error = (field: ClientField, code: IssueCode) => issues.push({ field, severity: 'error', code })

  const displayName = draft.displayName.trim().replace(/\s+/g, ' ')
  const fiverrUsername = optional((draft.fiverrUsername ?? '').trim().replace(/^@/, ''))
  const email = optional(draft.email)
  const otherContact = optional(draft.otherContact)
  const sourceDetail = optional(draft.sourceDetail)

  if (displayName === '') error('displayName', 'required')
  else if (displayName.length > NAME_MAX) error('displayName', 'too-long')
  else if (CONTROL_CHARS.test(displayName)) error('displayName', 'invalid-characters')

  if (draft.source === '') error('source', 'required')

  if (sourceDetail && sourceDetail.length > SHORT_TEXT_MAX) error('sourceDetail', 'too-long')
  else if (sourceDetail && CONTROL_CHARS.test(sourceDetail)) error('sourceDetail', 'invalid-characters')

  if (fiverrUsername && /\s/.test(fiverrUsername)) error('fiverrUsername', 'contains-spaces')
  else if (fiverrUsername && fiverrUsername.length > FIVERR_USERNAME_MAX) error('fiverrUsername', 'too-long')

  if (email && (email.length > EMAIL_MAX || !EMAIL_SHAPE.test(email))) error('email', 'invalid-format')

  if (otherContact && otherContact.length > SHORT_TEXT_MAX) error('otherContact', 'too-long')
  else if (otherContact && CONTROL_CHARS.test(otherContact)) error('otherContact', 'invalid-characters')

  const channel = draft.preferredContactChannel
  if (channel === 'email' && !email) error('email', 'required-for-channel')
  if (channel === 'fiverr' && !fiverrUsername)
    issues.push({ field: 'fiverrUsername', severity: 'warning', code: 'missing-for-channel' })
  if (channel === 'other' && !otherContact)
    issues.push({ field: 'otherContact', severity: 'warning', code: 'missing-for-channel' })
  if (!email && !fiverrUsername && !otherContact)
    issues.push({ field: null, severity: 'info', code: 'no-contact-details' })

  const hasErrors = issues.some((issue) => issue.severity === 'error')
  return {
    issues,
    input:
      hasErrors || draft.source === ''
        ? null
        : {
            displayName,
            source: draft.source,
            sourceDetail,
            fiverrUsername,
            email,
            otherContact,
            preferredContactChannel: channel
          }
  }
}

// ---------- duplicate advisory ----------

/** Accent-, case- and whitespace-insensitive comparison key. */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export type DuplicateSignal = 'email' | 'fiverrUsername' | 'displayName'

export interface DuplicateCandidate {
  client: Client
  signals: DuplicateSignal[]
}

export function findDuplicates(input: ClientInput, clients: Client[], excludeId?: string): DuplicateCandidate[] {
  const name = foldText(input.displayName)
  const email = input.email?.toLowerCase()
  const handle = input.fiverrUsername?.toLowerCase()

  return clients.flatMap((client) => {
    if (client.id === excludeId) return []
    const signals: DuplicateSignal[] = []
    if (email && client.email?.toLowerCase() === email) signals.push('email')
    if (handle && client.fiverrUsername?.toLowerCase() === handle) signals.push('fiverrUsername')
    if (foldText(client.displayName) === name) signals.push('displayName')
    return signals.length > 0 ? [{ client, signals }] : []
  })
}

// ---------- directory query ----------

export type StatusFilter = 'active' | 'archived' | 'all'
export type SortOrder = 'name' | 'updated' | 'created'

export interface DirectoryQuery {
  text: string
  status: StatusFilter
  sources: ClientSource[]
  sort: SortOrder
}

export const defaultQuery: DirectoryQuery = { text: '', status: 'active', sources: [], sort: 'name' }

const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export function queryClients(clients: Client[], query: DirectoryQuery): Client[] {
  const needle = foldText(query.text)
  const matches = clients.filter((client) => {
    if (query.status !== 'all' && client.status !== query.status) return false
    if (query.sources.length > 0 && !query.sources.includes(client.source)) return false
    if (needle === '') return true
    return [client.displayName, client.fiverrUsername, client.email, client.otherContact].some(
      (field) => field !== null && foldText(field).includes(needle)
    )
  })

  const byName = (a: Client, b: Client) =>
    nameCollator.compare(a.displayName, b.displayName) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

  return matches.sort((a, b) => {
    if (query.sort === 'updated') return b.updatedAt.localeCompare(a.updatedAt) || byName(a, b)
    if (query.sort === 'created') return b.createdAt.localeCompare(a.createdAt) || byName(a, b)
    return byName(a, b)
  })
}
