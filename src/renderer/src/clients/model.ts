// PROVISIONAL client model for the #3 prototype. Mirrors the draft in
// docs/client-data-model.md (#2), which the researcher has not yet approved.
// Pure functions only, so the same rules can move to the main process in #5/#10.

export type ClientSource = 'fiverr' | 'referral' | 'direct' | 'other'
export type ContactChannel = 'fiverr' | 'email' | 'other' | 'unspecified'
export type ClientStatus = 'active' | 'archived'

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

export type ClientInput = Pick<
  Client,
  'displayName' | 'source' | 'sourceDetail' | 'fiverrUsername' | 'email' | 'otherContact' | 'preferredContactChannel'
>

/** Raw form values: every field is a string while the user is typing. */
export interface ClientFormValues {
  displayName: string
  source: ClientSource | ''
  sourceDetail: string
  fiverrUsername: string
  email: string
  otherContact: string
  preferredContactChannel: ContactChannel
}

export type NoteKind = 'note' | 'contact' | 'system'
export type NoteChannel = 'fiverr' | 'email' | 'other'
export type NoteDirection = 'inbound' | 'outbound'

export interface ClientNote {
  id: string
  clientId: string
  kind: NoteKind
  occurredAt: string
  channel: NoteChannel | null
  direction: NoteDirection | null
  body: string
}

export const sourceLabels: Record<ClientSource, string> = {
  fiverr: 'Fiverr',
  referral: 'Referral',
  direct: 'Direct',
  other: 'Other'
}

export const channelLabels: Record<ContactChannel, string> = {
  fiverr: 'Fiverr messages',
  email: 'Email',
  other: 'Other',
  unspecified: 'Not specified'
}

export const NAME_MAX = 120
export const SHORT_TEXT_MAX = 200
export const NOTE_MAX = 10_000

export const emptyFormValues: ClientFormValues = {
  displayName: '',
  source: '',
  sourceDetail: '',
  fiverrUsername: '',
  email: '',
  otherContact: '',
  preferredContactChannel: 'unspecified'
}

export function toFormValues(client: Client): ClientFormValues {
  return {
    displayName: client.displayName,
    source: client.source,
    sourceDetail: client.sourceDetail ?? '',
    fiverrUsername: client.fiverrUsername ?? '',
    email: client.email ?? '',
    otherContact: client.otherContact ?? '',
    preferredContactChannel: client.preferredContactChannel
  }
}

// ---------- normalization and validation ----------

const CONTROL_CHARS = /\p{Cc}/u
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function optional(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export type FieldName = keyof ClientFormValues
export type Severity = 'error' | 'warning' | 'info'

export interface ValidationIssue {
  field: FieldName | null
  severity: Severity
  message: string
}

export interface ValidationResult {
  input: ClientInput | null
  issues: ValidationIssue[]
}

export function validateClient(values: ClientFormValues): ValidationResult {
  const issues: ValidationIssue[] = []
  const error = (field: FieldName, message: string) => issues.push({ field, severity: 'error', message })

  const displayName = values.displayName.trim().replace(/\s+/g, ' ')
  const fiverrUsername = optional(values.fiverrUsername.trim().replace(/^@/, ''))
  const email = optional(values.email)
  const otherContact = optional(values.otherContact)
  const sourceDetail = optional(values.sourceDetail)

  if (displayName === '') error('displayName', 'Add a name so you can find this client later.')
  else if (displayName.length > NAME_MAX) error('displayName', `Keep the name under ${NAME_MAX} characters.`)
  else if (CONTROL_CHARS.test(displayName)) error('displayName', 'Remove the unusual characters from the name.')

  if (values.source === '') error('source', 'Choose where this client came from.')

  if (sourceDetail && sourceDetail.length > SHORT_TEXT_MAX)
    error('sourceDetail', `Keep this under ${SHORT_TEXT_MAX} characters.`)

  if (fiverrUsername && /\s/.test(fiverrUsername)) error('fiverrUsername', "Fiverr usernames don't contain spaces.")
  else if (fiverrUsername && fiverrUsername.length > 60) error('fiverrUsername', 'This username is too long.')

  if (email && (email.length > 254 || !EMAIL_SHAPE.test(email)))
    error('email', "This email address doesn't look complete.")

  if (otherContact && otherContact.length > SHORT_TEXT_MAX)
    error('otherContact', `Keep this under ${SHORT_TEXT_MAX} characters.`)

  const channel = values.preferredContactChannel
  if (channel === 'email' && !email)
    error('email', 'Add an email address, or choose a different preferred contact method.')
  if (channel === 'fiverr' && !fiverrUsername)
    issues.push({ field: 'fiverrUsername', severity: 'warning', message: 'No Fiverr username yet. You can add it later.' })
  if (channel === 'other' && !otherContact)
    issues.push({ field: 'otherContact', severity: 'warning', message: 'Add a note on how to reach this client.' })
  if (!email && !fiverrUsername && !otherContact)
    issues.push({
      field: null,
      severity: 'info',
      message: "No contact details yet. That's fine, you can add them later."
    })

  const hasErrors = issues.some((issue) => issue.severity === 'error')
  return {
    issues,
    input:
      hasErrors || values.source === ''
        ? null
        : {
            displayName,
            source: values.source,
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
