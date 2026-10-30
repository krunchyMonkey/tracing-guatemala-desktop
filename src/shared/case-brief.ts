// Case research brief rules (case-brief/v1, docs/case-data-model.md): shapes and
// field validation for the researcher's working material on one case. Shared by
// the host's repository (authoritative) and the browser (instant feedback, demo).
// No Node imports: the renderer bundles this file.

export const BRIEF_OBJECTIVE_MAX = 4_000
export const BRIEF_SECTION_MAX = 10_000

export const BRIEF_FIELDS = ['objective', 'facts', 'people', 'hypotheses', 'questions'] as const
export type BriefField = (typeof BRIEF_FIELDS)[number]

export const BRIEF_LIMITS: Record<BriefField, number> = {
  objective: BRIEF_OBJECTIVE_MAX,
  facts: BRIEF_SECTION_MAX,
  people: BRIEF_SECTION_MAX,
  hypotheses: BRIEF_SECTION_MAX,
  questions: BRIEF_SECTION_MAX
}

/** What the browser may send. Strict: the case id and timestamps are never accepted here. */
export type CaseBriefInput = Record<BriefField, string | null>

export interface CaseBrief extends CaseBriefInput {
  caseId: string
  /** null = never saved: every section is empty. */
  updatedAt: string | null
}

export type BriefIssueCode = 'too-long' | 'invalid-characters'

/** A rule outcome. Carries only a field name and a code, never the submitted value. */
export interface BriefIssue {
  field: BriefField
  code: BriefIssueCode
}

export interface BriefCheck {
  input: CaseBriefInput | null
  issues: BriefIssue[]
}

export type CaseBriefMutationResult =
  | { ok: true; brief: CaseBrief }
  | { ok: false; reason: 'invalid'; issues: BriefIssue[] }
  /** The case does not exist. */
  | { ok: false; reason: 'not-found' }
  /** The case or its client is archived. */
  | { ok: false; reason: 'wrong-status' }

const CONTROL_CHARS = /\p{Cc}/u

/** Normalize and validate a brief draft. `input` is null whenever there is an issue. */
export function checkCaseBrief(raw: CaseBriefInput): BriefCheck {
  const issues: BriefIssue[] = []
  const input = {} as CaseBriefInput

  for (const field of BRIEF_FIELDS) {
    const trimmed = (raw[field] ?? '').replace(/\r\n/g, '\n').trim()
    const value = trimmed === '' ? null : trimmed
    input[field] = value
    if (value === null) continue
    if (value.length > BRIEF_LIMITS[field]) issues.push({ field, code: 'too-long' })
    else if (CONTROL_CHARS.test(value.replace(/[\n\t]/g, ''))) issues.push({ field, code: 'invalid-characters' })
  }

  return { issues, input: issues.length > 0 ? null : input }
}

/** A brief with nothing in it, for a case that has none yet. */
export const emptyBrief = (caseId: string): CaseBrief => ({
  caseId,
  objective: null,
  facts: null,
  people: null,
  hypotheses: null,
  questions: null,
  updatedAt: null
})

export const briefIsEmpty = (brief: CaseBriefInput): boolean => BRIEF_FIELDS.every((field) => brief[field] === null)
