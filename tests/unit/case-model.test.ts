import { describe, expect, it } from 'vitest'
import {
  canTransition,
  CASE_GOAL_MAX,
  CASE_STATES,
  CASE_TITLE_MAX,
  CASE_TRANSITIONS,
  checkCase,
  isOverdue,
  localDateString,
  needsConfirmation,
  ORDER_REFERENCE_MAX,
  queryCases,
  type CaseInput,
  type CaseQuery,
  type CaseState,
  type ResearchCase
} from '../../src/shared/case-model'

// Case rules (case-model/v1) without a database. Fictional data only.

const valid: CaseInput = {
  title: 'Maternal grandparents',
  goal: 'Find where my grandmother Rosa was born.',
  orderReference: 'FO-EXAMPLE-0042',
  dueDate: '2026-11-15'
}

const blank: CaseInput = { title: 'Case', goal: null, orderReference: null, dueDate: null }

describe('checkCase normalization', () => {
  it('accepts a complete case unchanged', () => {
    expect(checkCase(valid)).toEqual({ input: valid, issues: [] })
  })

  it('trims the title and collapses inner whitespace, including line breaks', () => {
    expect(checkCase({ ...valid, title: '  Maternal \t grandparents\n Quetzaltenango  ' }).input?.title).toBe(
      'Maternal grandparents Quetzaltenango'
    )
  })

  it('turns blank optional fields into null', () => {
    expect(checkCase({ title: 'Case', goal: '  \n ', orderReference: '   ', dueDate: ' ' }).input).toEqual(blank)
  })

  it('trims the goal, keeps its line breaks and tabs, and converts CRLF to LF', () => {
    expect(checkCase({ ...blank, goal: '  Line one\r\nLine two\n\tIndented  ' }).input?.goal).toBe('Line one\nLine two\n\tIndented')
  })

  it('trims the order reference and due date', () => {
    expect(checkCase({ ...blank, orderReference: ' FO-EXAMPLE-0001 ', dueDate: ' 2026-11-01 ' }).input).toMatchObject({
      orderReference: 'FO-EXAMPLE-0001',
      dueDate: '2026-11-01'
    })
  })
})

describe('checkCase issues', () => {
  it('requires a title', () => {
    expect(checkCase({ ...blank, title: '   ' })).toEqual({ input: null, issues: [{ field: 'title', code: 'required' }] })
  })

  it('limits each text field after normalization', () => {
    expect(checkCase({ ...blank, title: 'x'.repeat(CASE_TITLE_MAX) }).issues).toEqual([])
    expect(checkCase({ ...blank, title: 'x'.repeat(CASE_TITLE_MAX + 1) }).issues).toEqual([{ field: 'title', code: 'too-long' }])
    expect(checkCase({ ...blank, goal: 'x'.repeat(CASE_GOAL_MAX) }).issues).toEqual([])
    expect(checkCase({ ...blank, goal: 'x'.repeat(CASE_GOAL_MAX + 1) }).issues).toEqual([{ field: 'goal', code: 'too-long' }])
    expect(checkCase({ ...blank, orderReference: 'x'.repeat(ORDER_REFERENCE_MAX) }).issues).toEqual([])
    expect(checkCase({ ...blank, orderReference: 'x'.repeat(ORDER_REFERENCE_MAX + 1) }).issues).toEqual([
      { field: 'orderReference', code: 'too-long' }
    ])
  })

  it('counts a CRLF goal after conversion, not before', () => {
    const goal = 'x\r\n'.repeat(CASE_GOAL_MAX / 2 - 1) + 'x'
    expect(goal.length).toBeGreaterThan(CASE_GOAL_MAX)
    expect(checkCase({ ...blank, goal }).issues).toEqual([])
  })

  it('refuses control characters, except line breaks and tabs in the goal', () => {
    expect(checkCase({ ...blank, title: 'Bad\u0000title' }).issues).toEqual([{ field: 'title', code: 'invalid-characters' }])
    expect(checkCase({ ...blank, goal: 'Bad\u0007goal' }).issues).toEqual([{ field: 'goal', code: 'invalid-characters' }])
    expect(checkCase({ ...blank, goal: 'Bad\rgoal' }).issues).toEqual([{ field: 'goal', code: 'invalid-characters' }])
    expect(checkCase({ ...blank, orderReference: 'FO\u001b-1' }).issues).toEqual([{ field: 'orderReference', code: 'invalid-characters' }])
    expect(checkCase({ ...blank, orderReference: 'FO\n1' }).issues).toEqual([{ field: 'orderReference', code: 'invalid-characters' }])
  })

  it.each(['next friday', '2026/11/15', '15-11-2026', '2026-1-5', '20261115', '2026-11-15T00:00:00Z', '２０２６-11-15', '2026-11-1x'])(
    'rejects the due date format %j',
    (dueDate) => {
      expect(checkCase({ ...blank, dueDate }).issues).toEqual([{ field: 'dueDate', code: 'invalid-format' }])
    }
  )

  it.each(['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-11-00', '2026-11-31', '2100-02-29'])(
    'rejects the impossible calendar date %s',
    (dueDate) => {
      expect(checkCase({ ...blank, dueDate }).issues).toEqual([{ field: 'dueDate', code: 'invalid-date' }])
    }
  )

  it.each(['2028-02-29', '2000-02-29', '2026-02-28', '2026-12-31', '2026-01-01', '2020-04-30'])('accepts the real date %s', (dueDate) => {
    expect(checkCase({ ...blank, dueDate }).input?.dueDate).toBe(dueDate)
  })

  it('accepts a past due date (an order entered late)', () => {
    expect(checkCase({ ...blank, dueDate: '2001-01-01' }).input?.dueDate).toBe('2001-01-01')
  })

  it('reports every failing field and never carries a submitted value', () => {
    const marker = 'Fictional Secret Surname'
    const result = checkCase({ title: '', goal: `${marker}\u0000`, orderReference: 'x'.repeat(101), dueDate: marker })
    expect(result.input).toBeNull()
    expect(result.issues).toEqual([
      { field: 'title', code: 'required' },
      { field: 'goal', code: 'invalid-characters' },
      { field: 'orderReference', code: 'too-long' },
      { field: 'dueDate', code: 'invalid-format' }
    ])
    expect(JSON.stringify(result)).not.toContain(marker)
  })
})

describe('transitions', () => {
  const allowed: Record<CaseState, CaseState[]> = {
    intake: ['active', 'waiting', 'closed'],
    active: ['waiting', 'delivered', 'closed'],
    waiting: ['active', 'delivered', 'closed'],
    delivered: ['active', 'closed'],
    closed: ['active']
  }
  const confirmed = new Set([
    'intake>closed',
    'active>delivered',
    'active>closed',
    'waiting>delivered',
    'waiting>closed',
    'delivered>active',
    'delivered>closed',
    'closed>active'
  ])

  const pairs = CASE_STATES.flatMap((from) => CASE_STATES.map((to) => [from, to] as const))

  it('covers the full 5x5 matrix', () => {
    expect(pairs).toHaveLength(25)
    expect(CASE_TRANSITIONS).toEqual(allowed)
  })

  it.each(pairs)('%s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(allowed[from].includes(to))
  })

  it('never allows a state to itself', () => {
    for (const state of CASE_STATES) expect(canTransition(state, state)).toBe(false)
  })

  it('asks for confirmation exactly on the destructive-looking changes', () => {
    for (const [from, to] of pairs) {
      expect(needsConfirmation(from, to)).toBe(confirmed.has(`${from}>${to}`))
      // Only changes that can happen need a confirmation rule.
      if (needsConfirmation(from, to)) expect(canTransition(from, to)).toBe(true)
    }
  })

  it('refuses an unknown state', () => {
    expect(canTransition('intake', 'paused' as CaseState)).toBe(false)
    expect(canTransition('paused' as CaseState, 'active')).toBe(false)
  })
})

describe('isOverdue', () => {
  const base = { dueDate: '2026-10-28', state: 'active' as CaseState, archivedAt: null }

  it('is true for an open case due before today', () => {
    for (const state of ['intake', 'active', 'waiting'] as const) expect(isOverdue({ ...base, state }, '2026-10-29')).toBe(true)
  })

  it('is false on the due date itself and before it', () => {
    expect(isOverdue(base, '2026-10-28')).toBe(false)
    expect(isOverdue(base, '2026-10-27')).toBe(false)
  })

  it('is false for delivered and closed cases, archived cases and cases without a due date', () => {
    expect(isOverdue({ ...base, state: 'delivered' }, '2026-10-29')).toBe(false)
    expect(isOverdue({ ...base, state: 'closed' }, '2026-10-29')).toBe(false)
    expect(isOverdue({ ...base, archivedAt: '2026-10-01T00:00:00.000Z' }, '2026-10-29')).toBe(false)
    expect(isOverdue({ ...base, dueDate: null }, '2026-10-29')).toBe(false)
  })

  it('compares calendar dates as text across months and years', () => {
    expect(isOverdue({ ...base, dueDate: '2026-09-30' }, '2026-10-01')).toBe(true)
    expect(isOverdue({ ...base, dueDate: '2025-12-31' }, '2026-01-01')).toBe(true)
    expect(isOverdue({ ...base, dueDate: '2027-01-01' }, '2026-12-31')).toBe(false)
  })
})

describe('localDateString', () => {
  it('uses the local calendar date, with zero padding', () => {
    expect(localDateString(new Date(2026, 0, 5, 23, 59, 59))).toBe('2026-01-05')
    expect(localDateString(new Date(2026, 11, 31, 0, 0, 0))).toBe('2026-12-31')
    expect(localDateString(new Date(2028, 1, 29, 12))).toBe('2028-02-29')
  })

  it('pads short years', () => {
    const date = new Date(2000, 0, 1)
    date.setFullYear(999)
    expect(localDateString(date)).toBe('0999-01-01')
  })
})

describe('queryCases', () => {
  const CLIENT_A = '11111111-1111-4111-8111-111111111111'
  const CLIENT_B = '22222222-2222-4222-8222-222222222222'

  const make = (id: string, overrides: Partial<ResearchCase>): ResearchCase => ({
    id,
    clientId: CLIENT_A,
    title: id,
    goal: null,
    orderReference: null,
    dueDate: null,
    state: 'intake',
    stateChangedAt: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    archivedAt: null,
    ...overrides
  })

  const cases: ResearchCase[] = [
    make('c1', {
      title: 'Álvarez family tree',
      orderReference: 'FO-EXAMPLE-0001',
      dueDate: '2026-11-20',
      state: 'active',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z'
    }),
    make('c2', {
      title: 'Baptism records',
      clientId: CLIENT_B,
      dueDate: '2026-11-05',
      state: 'waiting',
      createdAt: '2026-10-02T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z'
    }),
    make('c3', {
      title: 'Census search',
      orderReference: 'FO-EXAMPLE-0003',
      state: 'closed',
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-07T00:00:00.000Z'
    }),
    make('c4', {
      title: 'Archived order',
      dueDate: '2026-10-01',
      state: 'delivered',
      archivedAt: '2026-10-20T00:00:00.000Z',
      createdAt: '2026-10-04T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z'
    }),
    make('c5', {
      title: 'Another undated case',
      state: 'intake',
      createdAt: '2026-10-06T00:00:00.000Z',
      updatedAt: '2026-10-06T00:00:00.000Z'
    })
  ]

  const query = (overrides: Partial<CaseQuery> = {}): CaseQuery => ({
    clientId: null,
    archived: 'all',
    states: [],
    text: '',
    sort: 'title',
    ...overrides
  })
  const ids = (result: ResearchCase[]) => result.map((c) => c.id)

  it('filters by client', () => {
    expect(ids(queryCases(cases, query({ clientId: CLIENT_B })))).toEqual(['c2'])
    expect(ids(queryCases(cases, query({ clientId: '33333333-3333-4333-8333-333333333333' })))).toEqual([])
  })

  it('filters by the case’s own archive flag', () => {
    expect(ids(queryCases(cases, query({ archived: 'active' })))).not.toContain('c4')
    expect(ids(queryCases(cases, query({ archived: 'archived' })))).toEqual(['c4'])
    expect(queryCases(cases, query({ archived: 'all' }))).toHaveLength(5)
  })

  it('filters by any of the chosen states, and by none', () => {
    expect(ids(queryCases(cases, query({ states: ['active', 'waiting'] })))).toEqual(['c1', 'c2'])
    expect(ids(queryCases(cases, query({ states: ['closed'] })))).toEqual(['c3'])
  })

  it('matches title and order reference without regard to accents or case', () => {
    expect(ids(queryCases(cases, query({ text: 'alvarez' })))).toEqual(['c1'])
    expect(ids(queryCases(cases, query({ text: 'ÁLVAREZ' })))).toEqual(['c1'])
    expect(ids(queryCases(cases, query({ text: 'fo-example-0003' })))).toEqual(['c3'])
    expect(ids(queryCases(cases, query({ text: 'FO-EXAMPLE' })))).toEqual(['c1', 'c3'])
    expect(ids(queryCases(cases, query({ text: 'no such case' })))).toEqual([])
  })

  it('combines filters', () => {
    expect(ids(queryCases(cases, query({ text: 'fo-example', states: ['active'], clientId: CLIENT_A })))).toEqual(['c1'])
  })

  it('sorts by due date, earliest first, with undated cases last (by title)', () => {
    expect(ids(queryCases(cases, query({ sort: 'due' })))).toEqual(['c4', 'c2', 'c1', 'c5', 'c3'])
  })

  it('sorts by last update or creation, newest first', () => {
    expect(ids(queryCases(cases, query({ sort: 'updated' })))).toEqual(['c4', 'c2', 'c3', 'c5', 'c1'])
    expect(ids(queryCases(cases, query({ sort: 'created' })))).toEqual(['c5', 'c4', 'c3', 'c2', 'c1'])
  })

  it('sorts by title, ignoring accents and case', () => {
    expect(ids(queryCases(cases, query({ sort: 'title' })))).toEqual(['c1', 'c5', 'c4', 'c2', 'c3'])
  })

  it('does not change the list it was given', () => {
    const copy = [...cases]
    queryCases(cases, query({ sort: 'due' }))
    expect(cases).toEqual(copy)
  })
})
