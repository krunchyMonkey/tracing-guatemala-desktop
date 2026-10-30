import { describe, expect, it } from 'vitest'
import type { CaseBrief } from '../../src/shared/case-brief'
import type { JournalEntry } from '../../src/shared/case-journal'
import type { CaseEvent, ResearchCase } from '../../src/shared/case-model'
import {
  checkSummaryScope,
  composeCaseSummary,
  DEMO_SUMMARY_LINE,
  escapeLine,
  escapeText,
  HYPOTHESIS_PREFIX,
  summaryFileName,
  type CaseSummaryData
} from '../../src/shared/case-summary'
import type { CaseTask } from '../../src/shared/case-tasks'

// Case summary export (#20): the pure composer, the escaping, the scope check and
// the file name. Fictional data only.

const CLIENT_ID = '11111111-1111-4111-8111-111111111111'
const CASE_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_ID = '33333333-3333-4333-8333-333333333333'

const researchCase: ResearchCase = {
  id: CASE_ID,
  clientId: CLIENT_ID,
  title: 'Maternal grandparents',
  goal: 'Find where Rosa was born.\nAnd her parents’ names.',
  orderReference: 'FO-EXAMPLE-0042',
  dueDate: '2026-11-15',
  state: 'active',
  stateChangedAt: '2026-10-20T10:00:00.000Z',
  createdAt: '2026-10-18T09:00:00.000Z',
  updatedAt: '2026-10-25T16:30:00.000Z',
  archivedAt: null
}

const brief: CaseBrief = {
  caseId: CASE_ID,
  objective: 'Establish Rosa’s birthplace.',
  facts: 'The client says Rosa was born in 1931.',
  people: 'Rosa (grandmother)',
  hypotheses: 'She may have been born in Xela.\nOr nearby.\n\nHer father may be Teodoro.',
  questions: 'Which parish?',
  updatedAt: '2026-10-25T16:30:00.000Z'
}

const entry = (id: string, occurredAt: string, activity: string | null, body: string): JournalEntry => ({
  id,
  caseId: CASE_ID,
  occurredAt,
  activity,
  body,
  createdAt: occurredAt,
  updatedAt: occurredAt
})

const task = (id: string, title: string, over: Partial<CaseTask> = {}): CaseTask => ({
  id,
  caseId: CASE_ID,
  title,
  description: null,
  status: 'pending',
  dueDate: null,
  completedAt: null,
  createdAt: '2026-10-19T09:00:00.000Z',
  updatedAt: '2026-10-19T09:00:00.000Z',
  ...over
})

const events: CaseEvent[] = [
  { id: 'e2', caseId: CASE_ID, kind: 'state', fromState: 'intake', toState: 'active', occurredAt: '2026-10-20T10:00:00.000Z' },
  { id: 'e1', caseId: CASE_ID, kind: 'created', fromState: null, toState: 'intake', occurredAt: '2026-10-18T09:00:00.000Z' }
]

const data = (over: Partial<CaseSummaryData> = {}): CaseSummaryData => ({
  client: { id: CLIENT_ID, displayName: 'Ana Ejemplo' },
  case: researchCase,
  brief,
  journal: [
    entry('j1', '2026-10-21T15:00:00.000Z', 'Archive search', 'Checked the 1931 index.'),
    entry('j2', '2026-10-23T15:00:00.000Z', null, 'Wrote to the parish.')
  ],
  tasks: [
    task('t1', 'Done thing', { status: 'completed', completedAt: '2026-10-22T12:00:00.000Z', dueDate: '2026-10-21' }),
    task('t2', 'Late thing', { dueDate: '2026-10-01', description: 'Ask the archive.' }),
    task('t3', 'No date thing')
  ],
  events,
  ...over
})

const options = { generatedAt: new Date('2026-10-30T18:00:00.000Z'), localToday: '2026-10-30', demo: false, timeZone: 'UTC' }
const compose = (over: Partial<CaseSummaryData> = {}, demo = false) => composeCaseSummary(data(over), { ...options, demo })
const headings = (text: string) => [...text.matchAll(/^(#{1,3}) (.*)$/gm)].map((m) => `${m[1]} ${m[2]}`)

describe('composeCaseSummary', () => {
  it('writes the sections in order', () => {
    const text = compose()
    expect(headings(text)).toEqual([
      '# Case summary: Maternal grandparents',
      "## Client's requested outcome",
      '## Research brief',
      '### Working objective',
      '### Known facts (as reported — not verified)',
      '### Known people and family context',
      '### Hypotheses',
      '### Open questions',
      '## Next steps',
      '## Research journal',
      '### Oct 23, 2026',
      '### Oct 21, 2026 — Archive search',
      '## Case history'
    ])
    expect(text.endsWith('\n')).toBe(true)
  })

  it('shows the fictional-data line only for the demo', () => {
    expect(compose({}, true).split('\n').slice(0, 3)).toEqual(['# Case summary: Maternal grandparents', '', DEMO_SUMMARY_LINE])
    expect(compose({}, false)).not.toContain('Fictional demo data')
  })

  it('lists the metadata with the client name, a state label, dates and generated time', () => {
    const text = compose()
    expect(text).toContain('- Client: Ana Ejemplo')
    expect(text).toContain('- State: Active')
    expect(text).toContain('- Order reference: FO-EXAMPLE-0042')
    expect(text).toContain('- Due date: 2026-11-15\n')
    expect(text).toContain('- Created: Oct 18, 2026, 9:00 AM')
    expect(text).toContain('- Last updated: Oct 25, 2026, 4:30 PM')
    expect(text).toContain('- Generated: Oct 30, 2026, 6:00 PM')
    expect(text).not.toContain('Archived')
  })

  it('marks an open case past its due date as overdue, and not a finished or archived one', () => {
    const late = { ...researchCase, dueDate: '2026-10-29' }
    expect(compose({ case: late })).toContain('- Due date: 2026-10-29 (overdue)')
    expect(compose({ case: { ...late, dueDate: '2026-10-30' } })).toContain('- Due date: 2026-10-30\n')
    expect(compose({ case: { ...late, state: 'delivered' } })).toContain('- Due date: 2026-10-29\n')
    const archived = compose({ case: { ...late, archivedAt: '2026-10-28T08:00:00.000Z' } })
    expect(archived).toContain('- Archived: yes, since Oct 28, 2026')
    expect(archived).toContain('- Due date: 2026-10-29\n')
  })

  it('writes date-only values exactly as stored, never shifted by a time zone', () => {
    for (const timeZone of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Guatemala']) {
      const text = composeCaseSummary(data({ case: { ...researchCase, dueDate: '2026-12-01' } }), { ...options, timeZone })
      expect(text).toContain('- Due date: 2026-12-01')
      expect(text).toContain('due 2026-10-01 (overdue)')
    }
  })

  it('omits the order reference and due date when there are none', () => {
    const text = compose({ case: { ...researchCase, orderReference: null, dueDate: null } })
    expect(text).not.toContain('Order reference')
    expect(text).not.toContain('Due date')
  })

  it('keeps the requested outcome verbatim and says so when there is none', () => {
    expect(compose()).toContain("## Client's requested outcome\n\nFind where Rosa was born.\nAnd her parents’ names.\n")
    expect(compose({ case: { ...researchCase, goal: null } })).toContain("## Client's requested outcome\n\nNot recorded.")
  })

  it('prefixes every hypothesis paragraph so it cannot read as a fact', () => {
    const text = compose()
    const section = text.split('### Hypotheses\n\n')[1]!.split('\n\n### ')[0]!
    expect(section).toBe(
      `${HYPOTHESIS_PREFIX} She may have been born in Xela.\nOr nearby.\n\n${HYPOTHESIS_PREFIX} Her father may be Teodoro.`
    )
    expect(text.split(HYPOTHESIS_PREFIX)).toHaveLength(3)
    // Not in the facts, and facts are labelled as reported.
    expect(text.split('### Known facts')[1]!.split('### ')[0]).not.toContain('Hypothesis')
    const odd = compose({ brief: { ...brief, hypotheses: '\n\n  One.  \n\n\n\nTwo\n- three\n' } })
    expect(odd).toContain(`${HYPOTHESIS_PREFIX} One.\n\n${HYPOTHESIS_PREFIX} Two\n\\- three`)
  })

  it('leaves out empty brief sections and says so when the whole brief is empty', () => {
    const partial = compose({ brief: { ...brief, facts: null, people: null, hypotheses: null, questions: null } })
    expect(headings(partial)).toContain('### Working objective')
    expect(partial).not.toContain('### Known facts')
    expect(partial).not.toContain('### Hypotheses')
    for (const none of [null, { ...brief, objective: null, facts: null, people: null, hypotheses: null, questions: null }]) {
      const text = compose({ brief: none })
      expect(text).toContain('## Research brief\n\nNo research brief yet.')
      expect(text).not.toContain('### Working objective')
    }
  })

  it('lists open next steps first, then done ones, with due and completion dates', () => {
    const text = compose()
    expect(text.split('## Next steps\n\n')[1]!.split('\n\n## ')[0]).toBe(
      [
        '- [ ] Late thing — due 2026-10-01 (overdue)',
        '  Ask the archive.',
        '- [ ] No date thing — no deadline',
        '- [x] Done thing — completed Oct 22, 2026'
      ].join('\n')
    )
    expect(compose({ tasks: [] })).toContain('## Next steps\n\nNo tasks.')
  })

  it('lists the journal and the history newest first', () => {
    const text = compose()
    expect(text.indexOf('Wrote to the parish.')).toBeLessThan(text.indexOf('Checked the 1931 index.'))
    expect(text).toContain('### Oct 21, 2026 — Archive search\n\nChecked the 1931 index.')
    expect(text.split('## Case history\n\n')[1]).toBe('- Oct 20, 2026, 10:00 AM: Research started\n- Oct 18, 2026, 9:00 AM: Case created\n')
    const none = compose({ journal: [], events: [] })
    expect(none).toContain('## Research journal\n\nNo journal entries yet.')
    expect(none).toContain('## Case history\n\nNo history yet.')
  })

  it('does not mention research hours', () => {
    expect(compose().toLowerCase()).not.toContain('hours')
  })

  it('keeps accented and emoji text as typed', () => {
    const text = compose({ case: { ...researchCase, title: 'Niño “Ángel” 🌽' } })
    expect(text).toContain('# Case summary: Niño “Ángel” 🌽')
  })

  it('escapes user text so it cannot break the document structure', () => {
    const hostile = '# Fake heading\n> quote\n- item\n<script>alert(1)</script>\n1. one'
    const text = compose({
      case: { ...researchCase, title: '# Sneaky', goal: hostile, orderReference: '- ref' },
      brief: { ...brief, objective: hostile, facts: hostile, people: hostile, questions: hostile, hypotheses: hostile },
      journal: [entry('j', '2026-10-23T15:00:00.000Z', '# act', hostile)],
      tasks: [task('t', '# task', { description: hostile })]
    })
    expect(text).not.toMatch(/<script/i)
    expect(text).toContain('&lt;script>alert(1)&lt;/script>')
    // Only the composer's own headings exist.
    expect(headings(text)).toEqual([
      '# Case summary: \\# Sneaky',
      "## Client's requested outcome",
      '## Research brief',
      '### Working objective',
      '### Known facts (as reported — not verified)',
      '### Known people and family context',
      '### Hypotheses',
      '### Open questions',
      '## Next steps',
      '## Research journal',
      '### Oct 23, 2026 — \\# act',
      '## Case history'
    ])
    expect(text).not.toMatch(/^> quote$/m)
    expect(text).not.toMatch(/^\s*- item$/m)
    expect(text).toContain('\\> quote')
    expect(text).toContain('- Order reference: \\- ref')
  })
})

describe('escaping', () => {
  const table: [string, string][] = [
    ['# heading', '\\# heading'],
    ['## heading', '\\## heading'],
    ['> quote', '\\> quote'],
    ['- item', '\\- item'],
    ['---', '\\---'],
    ['+ item', '\\+ item'],
    ['* item', '\\* item'],
    ['===', '\\==='],
    ['| a | b |', '\\| a | b |'],
    ['`code`', '\\`code`'],
    ['```js', '\\```js'],
    ['_ _ _', '\\_ _ _'],
    ['~~~', '\\~~~'],
    ['1. first', '1\\. first'],
    ['42) answer', '42\\) answer'],
    ['   # indented', '   \\# indented'],
    ['<script>x</script>', '&lt;script>x&lt;/script>'],
    ['a < b', 'a &lt; b'],
    ['plain text', 'plain text'],
    ['not # leading', 'not # leading'],
    ['2026-10-20 was a Tuesday', '2026-10-20 was a Tuesday'],
    ['1931 register', '1931 register']
  ]
  it.each(table)('escapes %j as %j', (input, expected) => {
    expect(escapeLine(input)).toBe(expected)
  })

  it('escapes every line of multi-line text and normalizes line breaks', () => {
    expect(escapeText('# a\r\n- b\rc\n\n> d')).toBe('\\# a\n\\- b\nc\n\n\\> d')
  })
})

describe('checkSummaryScope', () => {
  it('accepts data that all belongs to the case and its client', () => {
    expect(checkSummaryScope(data())).toBe(true)
    expect(checkSummaryScope(data({ brief: null, journal: [], tasks: [], events: [] }))).toBe(true)
  })

  it('rejects any record from another case, or another client', () => {
    const mismatches: Partial<CaseSummaryData>[] = [
      { client: { id: OTHER_ID, displayName: 'Ana Ejemplar' } },
      { brief: { ...brief, caseId: OTHER_ID } },
      { journal: [entry('x', '2026-10-23T15:00:00.000Z', null, 'ok'), { ...entry('y', '2026-10-23T15:00:00.000Z', null, 'other'), caseId: OTHER_ID }] },
      { tasks: [{ ...task('x', 'other'), caseId: OTHER_ID }] },
      { events: [{ ...events[0]!, caseId: OTHER_ID }] },
      { case: { ...researchCase, clientId: OTHER_ID } }
    ]
    for (const mismatch of mismatches) expect(checkSummaryScope(data(mismatch))).toBe(false)
  })

  it('makes composeCaseSummary throw without producing output', () => {
    expect(() => compose({ tasks: [{ ...task('x', 'other'), caseId: OTHER_ID }] })).toThrow('does not all belong to one case')
    expect(() => compose({ client: { id: OTHER_ID, displayName: 'Someone else' } })).toThrow()
  })
})

describe('client privacy', () => {
  it('contains the display name and no other client field, even if extra fields are passed along', () => {
    const rich = {
      id: CLIENT_ID,
      displayName: 'Ana Ejemplo',
      email: 'ana.private@example.com',
      fiverrUsername: 'private_fiverr_name',
      otherContact: '+502 5555 0100',
      notes: 'private client note'
    }
    const text = composeCaseSummary(data({ client: rich }), options)
    for (const secret of ['ana.private@example.com', 'private_fiverr_name', '+502 5555 0100', 'private client note']) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain('Ana Ejemplo')
  })
})

describe('summaryFileName', () => {
  const today = '2026-10-30'
  it.each([
    ['Maternal grandparents', 'case-summary-maternal-grandparents-2026-10-30.md'],
    ['Paternal line — Totonicapán, 1880s', 'case-summary-paternal-line-totonicapan-1880s-2026-10-30.md'],
    ['Niño Ángel', 'case-summary-nino-angel-2026-10-30.md'],
    ['🌽🌽', 'case-summary-case-2026-10-30.md'],
    ['', 'case-summary-case-2026-10-30.md'],
    ['   ', 'case-summary-case-2026-10-30.md'],
    ['a/b\\c:d*e?"f<g>h|i', 'case-summary-a-b-c-d-e-f-g-h-i-2026-10-30.md'],
    ['../../etc/passwd', 'case-summary-etc-passwd-2026-10-30.md'],
    ['..', 'case-summary-case-2026-10-30.md'],
    ['CON', 'case-summary-con-2026-10-30.md']
  ])('turns %j into %j', (title, expected) => {
    expect(summaryFileName(title, today)).toBe(expected)
  })

  it('caps a long title at 50 characters of slug without a trailing dash', () => {
    const name = summaryFileName('word '.repeat(40), today)
    const slug = name.slice('case-summary-'.length, -'-2026-10-30.md'.length)
    expect(slug.length).toBeLessThanOrEqual(50)
    expect(slug.endsWith('-')).toBe(false)
    expect(summaryFileName('x'.repeat(200), today)).toBe(`case-summary-${'x'.repeat(50)}-2026-10-30.md`)
  })

  it('never contains separators, extra dots or reserved characters', () => {
    for (const title of ['a/b', '..\\..', 'x\u0000y', 'q"r', 'ok.md', '‮evil']) {
      expect(summaryFileName(title, today)).toMatch(/^case-summary-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/)
    }
  })
})
