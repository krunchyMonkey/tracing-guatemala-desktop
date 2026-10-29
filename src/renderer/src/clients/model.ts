// Renderer view of client-model/v1. The types and rules live in src/shared so the
// main process can re-run them (#5); this file adds form state and the
// plain-language messages for each rule code. Renderer checks are a convenience,
// not a security boundary.

import {
  checkClient,
  NAME_MAX,
  SHORT_TEXT_MAX,
  type Client,
  type ClientInput,
  type ClientIssue,
  type ClientSource,
  type ContactChannel
} from '../../../shared/client-model'

export {
  defaultQuery,
  findDuplicates,
  foldText,
  NAME_MAX,
  NOTE_MAX,
  queryClients,
  SHORT_TEXT_MAX
} from '../../../shared/client-model'
export type {
  Client,
  ClientInput,
  ClientSource,
  ClientStatus,
  ContactChannel,
  DirectoryQuery,
  DuplicateCandidate,
  DuplicateSignal,
  Severity,
  SortOrder,
  StatusFilter
} from '../../../shared/client-model'

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

// ---------- validation messages ----------

export type FieldName = keyof ClientFormValues

export interface ValidationIssue {
  field: FieldName | null
  severity: ClientIssue['severity']
  message: string
}

export interface ValidationResult {
  input: ClientInput | null
  issues: ValidationIssue[]
}

const fieldMessages: Partial<Record<FieldName, Partial<Record<ClientIssue['code'], string>>>> = {
  displayName: {
    required: 'Add a name so you can find this client later.',
    'too-long': `Keep the name under ${NAME_MAX} characters.`,
    'invalid-characters': 'Remove the unusual characters from the name.'
  },
  source: { required: 'Choose where this client came from.' },
  sourceDetail: {
    'too-long': `Keep this under ${SHORT_TEXT_MAX} characters.`,
    'invalid-characters': 'Remove the unusual characters from this field.'
  },
  fiverrUsername: {
    'contains-spaces': "Fiverr usernames don't contain spaces.",
    'too-long': 'This username is too long.',
    'missing-for-channel': 'No Fiverr username yet. You can add it later.'
  },
  email: {
    'invalid-format': "This email address doesn't look complete.",
    'required-for-channel': 'Add an email address, or choose a different preferred contact method.'
  },
  otherContact: {
    'too-long': `Keep this under ${SHORT_TEXT_MAX} characters.`,
    'invalid-characters': 'Remove the unusual characters from this field.',
    'missing-for-channel': 'Add a note on how to reach this client.'
  }
}

/** Plain-language text for a rule code (also used for issues returned by the main process). */
export function issueMessage(issue: Pick<ClientIssue, 'field' | 'code'>): string {
  if (issue.field === null) return "No contact details yet. That's fine, you can add them later."
  return fieldMessages[issue.field]?.[issue.code] ?? 'Check this field.'
}

export function toValidationIssues(issues: ClientIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({ field: issue.field, severity: issue.severity, message: issueMessage(issue) }))
}

export function validateClient(values: ClientFormValues): ValidationResult {
  const { input, issues } = checkClient(values)
  return { input, issues: toValidationIssues(issues) }
}
