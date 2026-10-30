// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createDemoApi, defaultClock } from '../../src/renderer/src/demo/demoApi'
import { createDemoCases } from '../../src/renderer/src/demo/demoCases'
import { buildDemoCases, buildDemoData, demoCaseIds, demoClientIds } from '../../src/renderer/src/demo/sampleData'
import type { AppRuntime, CaseApi } from '../../src/renderer/src/runtime/AppRuntime'
import type { CaseBriefInput } from '../../src/shared/case-brief'

// The research brief on the case screens (#17) against the demo's in-memory
// adapters, which follow the same shared rules as the host. Fictional data only.

const appInfo = { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999'

function setup() {
  const data = createDemoApi(buildDemoData(), appInfo)
  const cases = createDemoCases(buildDemoCases(), data.getClient, defaultClock)
  const runtime: AppRuntime = {
    mode: 'live',
    switcher: { kind: 'unavailable', reason: 'not-available' },
    data,
    backup: { createBackup: vi.fn(), chooseBackupToRestore: vi.fn(), restoreBackup: vi.fn() } as never,
    cases
  }
  return { data, cases, runtime }
}

function openAt(hash: string, runtime: AppRuntime) {
  window.location.hash = hash
  return render(<App runtime={runtime} />)
}

const nothing: CaseBriefInput = { objective: null, facts: null, people: null, hypotheses: null, questions: null }
const dialog = () => screen.getByRole('alertdialog')
const briefCard = async () => within(await screen.findByRole('region', { name: 'Research brief' }))
const field = (name: RegExp) => screen.getByLabelText(name) as HTMLTextAreaElement

afterEach(cleanup)
beforeEach(() => {
  window.location.hash = ''
})

describe('brief on the case page', () => {
  it('shows each filled section with its heading, the client’s outcome and the hypotheses label', async () => {
    openAt(`#/cases/${demoCaseIds.paternal}`, setup().runtime)
    const card = await briefCard()
    expect(await card.findByRole('heading', { level: 3, name: 'Client’s requested outcome' })).toBeTruthy()
    expect(card.getByText(/where my great-grandfather was born/)).toBeTruthy()
    for (const name of [
      'Working research objective',
      'Known facts (as reported)',
      'Known people and family context',
      'Hypotheses',
      'Open questions'
    ]) {
      expect(card.getByRole('heading', { level: 3, name: name })).toBeTruthy()
    }
    expect(card.getByText('Recorded from the client or sources; not verified by the app.')).toBeTruthy()
    expect(card.getByText('Hypothesis — not established')).toBeTruthy()
    expect(card.getByRole('link', { name: 'Edit brief' }).getAttribute('href')).toBe(`#/cases/${demoCaseIds.paternal}/brief`)
  })

  it('makes the hypotheses section visually distinct from the facts', async () => {
    openAt(`#/cases/${demoCaseIds.paternal}`, setup().runtime)
    const card = await briefCard()
    const hypotheses = (await card.findByRole('heading', { name: 'Hypotheses' })).closest('section')!
    const facts = card.getByRole('heading', { name: 'Known facts (as reported)' }).closest('section')!
    expect(hypotheses.className).toContain('brief-hypotheses')
    expect(facts.className).not.toContain('brief-hypotheses')
    expect(within(facts).queryByText('Hypothesis — not established')).toBeNull()
    expect(within(hypotheses).getByText('Hypothesis — not established')).toBeTruthy()
  })

  it('omits empty sections and shows a friendly empty state with a way to write one', async () => {
    openAt(`#/cases/${demoCaseIds.surname}`, setup().runtime)
    let card = await briefCard()
    expect(await card.findByRole('heading', { name: 'Open questions' })).toBeTruthy()
    expect(card.queryByRole('heading', { name: 'Hypotheses' })).toBeNull()
    expect(card.queryByRole('heading', { name: 'Working research objective' })).toBeNull()
    cleanup()

    openAt(`#/cases/${demoCaseIds.secondBranch}`, setup().runtime)
    card = await briefCard()
    expect(await card.findByText('No research brief yet.')).toBeTruthy()
    expect(card.getByRole('link', { name: 'Write the brief' }).getAttribute('href')).toBe(`#/cases/${demoCaseIds.secondBranch}/brief`)
    expect(card.queryByRole('link', { name: 'Edit brief' })).toBeNull()
  })

  it('is read-only with an explanation when the case or its client is archived', async () => {
    openAt(`#/cases/${demoCaseIds.reunion}`, setup().runtime)
    let card = await briefCard()
    expect(await card.findByText('No research brief yet.')).toBeTruthy()
    expect(card.getByText('This case is archived, so its brief can’t be changed.')).toBeTruthy()
    expect(card.queryByRole('link', { name: /Write the brief|Edit brief/ })).toBeNull()
    cleanup()

    // An archived client with a saved brief: still readable, not editable.
    const { runtime, data, cases } = setup()
    await cases.saveCaseBrief(demoCaseIds.surname, { ...nothing, facts: 'Reported by the client.' })
    await data.archiveClient(demoClientIds.daniel)
    openAt(`#/cases/${demoCaseIds.surname}`, runtime)
    card = await briefCard()
    expect(await card.findByText('Reported by the client.')).toBeTruthy()
    expect(card.getByText(/This client is archived, so the brief can’t be changed/)).toBeTruthy()
    expect(card.queryByRole('link', { name: /Write the brief|Edit brief/ })).toBeNull()
  })

  it('shows saved text as plain text, never as markup', async () => {
    const { runtime, cases } = setup()
    await cases.saveCaseBrief(demoCaseIds.surname, { ...nothing, hypotheses: '<script>window.__pwned = 1</script><b>bold?</b> “Ángel” & co' })
    openAt(`#/cases/${demoCaseIds.surname}`, runtime)
    const card = await briefCard()
    expect(await card.findByText('<script>window.__pwned = 1</script><b>bold?</b> “Ángel” & co')).toBeTruthy()
    expect(document.querySelector('.brief script, .brief b')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('offers a retry when the brief can’t be loaded', async () => {
    const { runtime, cases } = setup()
    let fail = true
    const flaky: CaseApi = {
      ...cases,
      getCaseBrief: (id) => (fail ? Promise.reject(new Error('down')) : cases.getCaseBrief(id))
    }
    openAt(`#/cases/${demoCaseIds.paternal}`, { ...runtime, cases: flaky } as AppRuntime)
    expect(await screen.findByText('The research brief couldn’t be loaded')).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Open questions' })).toBeTruthy()
  })
})

describe('writing and editing the brief', () => {
  it('writes a first brief from the empty state, then shows it with a flash message', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    fireEvent.click(await screen.findByRole('link', { name: 'Write the brief' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Research brief' })).toBeTruthy()
    // Five labeled textareas with help text.
    for (const label of [/^Working research objective/, /^Known facts \(as reported\)/, /^Known people and family context/, /^Hypotheses/, /^Open questions/]) {
      const box = field(label)
      expect(box.tagName).toBe('TEXTAREA')
      expect(box.getAttribute('aria-describedby')).toBeTruthy()
    }
    expect(screen.getByText(/Client’s requested outcome/)).toBeTruthy()

    fireEvent.change(field(/^Working research objective/), { target: { value: '  Find the second branch.  ' } })
    fireEvent.change(field(/^Hypotheses/), { target: { value: 'Maybe they moved north.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Second branch report' })).toBeTruthy()
    expect(screen.getByText('Brief saved.')).toBeTruthy()
    const card = await briefCard()
    expect(card.getByText('Find the second branch.')).toBeTruthy()
    expect(card.getByText('Maybe they moved north.')).toBeTruthy()
    expect(card.queryByRole('heading', { name: 'Open questions' })).toBeNull()
    expect(await cases.getCaseBrief(demoCaseIds.secondBranch)).toMatchObject({ objective: 'Find the second branch.', facts: null })
  })

  it('edits an existing brief, clears a section and keeps line breaks', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}/brief`, runtime)
    const facts = await waitFor(() => {
      const box = field(/^Known facts/)
      expect(box.value).toContain('muleteer')
      return box
    })
    expect(facts.value.split('\n')).toHaveLength(3)

    fireEvent.change(facts, { target: { value: 'Line one\nLine two' } })
    fireEvent.change(field(/^Hypotheses/), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }))
    expect(await screen.findByText('Brief saved.')).toBeTruthy()
    const saved = await cases.getCaseBrief(demoCaseIds.paternal)
    expect(saved).toMatchObject({ facts: 'Line one\nLine two', hypotheses: null })
    const card = await briefCard()
    expect(card.queryByText('Hypothesis — not established')).toBeNull()
  })

  it('validates inline, keeps what was typed, and focuses the summary', async () => {
    openAt(`#/cases/${demoCaseIds.secondBranch}/brief`, setup().runtime)
    const box = await waitFor(() => field(/^Open questions/))
    fireEvent.change(box, { target: { value: `${'x'.repeat(10_001)}` } })
    fireEvent.change(field(/^Hypotheses/), { target: { value: 'bad\u0000text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }))

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('2 things need fixing before saving:')).toBeTruthy()
    expect(within(alert).getByRole('link', { name: /Keep “open questions” under 10,000 characters/ })).toBeTruthy()
    expect(within(alert).getByRole('link', { name: /“hypotheses” has a character that can’t be saved/ })).toBeTruthy()
    expect(field(/^Open questions/).getAttribute('aria-invalid')).toBe('true')
    expect(field(/^Open questions/).value).toHaveLength(10_001)
    expect(field(/^Hypotheses/).value).toBe('bad\u0000text')
    expect(field(/^Working research objective/).getAttribute('aria-invalid')).toBe('false')
  })

  it('shows the host’s issues when it rejects a draft the browser accepted, and keeps the input', async () => {
    const { runtime, cases } = setup()
    const rejecting: CaseApi = {
      ...cases,
      saveCaseBrief: async () => ({ ok: false, reason: 'invalid', issues: [{ field: 'facts', code: 'too-long' }] })
    }
    openAt(`#/cases/${demoCaseIds.secondBranch}/brief`, { ...runtime, cases: rejecting } as AppRuntime)
    fireEvent.change(await waitFor(() => field(/^Known facts/)), { target: { value: 'My careful notes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }))
    expect(await screen.findByText(/Keep “known facts \(as reported\)” under 10,000 characters/, { selector: 'a' })).toBeTruthy()
    expect(field(/^Known facts/).value).toBe('My careful notes')
  })

  it('does not lose input when saving fails, or when the case was archived meanwhile', async () => {
    const { runtime, cases, data } = setup()
    let fail = true
    const flaky: CaseApi = {
      ...cases,
      saveCaseBrief: (id, input) => (fail ? Promise.reject(new Error('down')) : cases.saveCaseBrief(id, input))
    }
    openAt(`#/cases/${demoCaseIds.secondBranch}/brief`, { ...runtime, cases: flaky } as AppRuntime)
    fireEvent.change(await waitFor(() => field(/^Open questions/)), { target: { value: 'Keep me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }))
    expect(await screen.findByText(/Something went wrong while saving/)).toBeTruthy()
    expect(field(/^Open questions/).value).toBe('Keep me')

    fail = false
    await data.archiveClient(demoClientIds.ethan)
    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }))
    expect(await screen.findByText(/was archived, so its brief can’t be changed/)).toBeTruthy()
    expect(field(/^Open questions/).value).toBe('Keep me')
  })

  it('asks before discarding unsaved changes, and leaves without asking when nothing changed', async () => {
    openAt(`#/cases/${demoCaseIds.paternal}/brief`, setup().runtime)
    await waitFor(() => expect(field(/^Known facts/).value).toContain('muleteer'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(await screen.findByRole('heading', { level: 1, name: /Paternal line/ })).toBeTruthy()
    cleanup()

    openAt(`#/cases/${demoCaseIds.paternal}/brief`, setup().runtime)
    await waitFor(() => expect(field(/^Known facts/).value).toContain('muleteer'))
    fireEvent.change(field(/^Known facts/), { target: { value: 'changed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(within(dialog()).getByText('Discard your changes?')).toBeTruthy()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(field(/^Known facts/).value).toBe('changed')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Discard changes' }))
    expect(await screen.findByRole('heading', { level: 1, name: /Paternal line/ })).toBeTruthy()
    const card = await briefCard()
    expect(await card.findByText(/muleteer/)).toBeTruthy()
  })

  it('is read-only for archived cases and clients, and not found for unknown ids', async () => {
    openAt(`#/cases/${demoCaseIds.reunion}/brief`, setup().runtime)
    expect(await screen.findByText('This case is archived')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save brief' })).toBeNull()
    cleanup()

    openAt(`#/cases/${demoCaseIds.spelling}/brief`, setup().runtime)
    expect(await screen.findByText('This client is archived')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save brief' })).toBeNull()
    cleanup()

    for (const hash of [`#/cases/${UNKNOWN_ID}/brief`, '#/cases/not-an-id/brief']) {
      openAt(hash, setup().runtime)
      expect(await screen.findByRole('heading', { level: 1, name: 'Case not found' })).toBeTruthy()
      cleanup()
    }
  })

  it('edits two cases of different clients independently', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.surname}/brief`, runtime)
    fireEvent.change(await waitFor(() => field(/^Working research objective/)), { target: { value: 'Daniel’s objective' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }))
    await screen.findByText('Brief saved.')
    cleanup()

    openAt(`#/cases/${demoCaseIds.secondBranch}/brief`, runtime)
    expect((await waitFor(() => field(/^Working research objective/))).value).toBe('')
    fireEvent.change(field(/^Working research objective/), { target: { value: 'Ethan’s objective' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }))
    await screen.findByText('Brief saved.')

    expect((await cases.getCaseBrief(demoCaseIds.surname))?.objective).toBe('Daniel’s objective')
    expect((await cases.getCaseBrief(demoCaseIds.secondBranch))?.objective).toBe('Ethan’s objective')
    expect((await cases.getCaseBrief(demoCaseIds.paternal))?.objective).toContain('Teodoro')
  })
})

describe('demo brief adapter', () => {
  it('follows the repository’s rules and check order', async () => {
    const { data, cases } = setup()
    expect(await cases.getCaseBrief(UNKNOWN_ID)).toBeNull()
    expect(await cases.getCaseBrief(demoCaseIds.secondBranch)).toEqual({
      caseId: demoCaseIds.secondBranch,
      ...nothing,
      updatedAt: null
    })
    expect(await cases.saveCaseBrief(UNKNOWN_ID, nothing)).toEqual({ ok: false, reason: 'not-found' })
    // Archived is reported before invalid input.
    expect(await cases.saveCaseBrief(demoCaseIds.reunion, { ...nothing, facts: '\u0000' })).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await cases.saveCaseBrief(demoCaseIds.spelling, nothing)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await cases.saveCaseBrief(demoCaseIds.secondBranch, { ...nothing, facts: '\u0000', people: 'y'.repeat(10_001) })).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [
        { field: 'facts', code: 'invalid-characters' },
        { field: 'people', code: 'too-long' }
      ]
    })

    const before = (await cases.getCase(demoCaseIds.secondBranch))!
    const saved = await cases.saveCaseBrief(demoCaseIds.secondBranch, { ...nothing, facts: '  a\r\nb  ' })
    expect(saved).toMatchObject({ ok: true, brief: { facts: 'a\nb', objective: null } })
    const after = (await cases.getCase(demoCaseIds.secondBranch))!
    expect(after.updatedAt > before.updatedAt).toBe(true)
    expect(await cases.listCaseEvents(demoCaseIds.secondBranch)).toHaveLength(3)

    await data.archiveClient(demoClientIds.ethan)
    expect(await cases.saveCaseBrief(demoCaseIds.secondBranch, nothing)).toEqual({ ok: false, reason: 'wrong-status' })
  })

  it('returns copies and starts from the seeded briefs again on every load', async () => {
    const initial = buildDemoCases()
    const data = createDemoApi(buildDemoData(), appInfo)
    const first = createDemoCases(initial, data.getClient, defaultClock)
    const one = (await first.getCaseBrief(demoCaseIds.paternal))!
    one.facts = 'Changed in place'
    expect((await first.getCaseBrief(demoCaseIds.paternal))!.facts).toContain('muleteer')

    await first.saveCaseBrief(demoCaseIds.paternal, nothing)
    const reload = createDemoCases(initial, data.getClient, defaultClock)
    expect((await reload.getCaseBrief(demoCaseIds.paternal))!.objective).toContain('Teodoro')
  })

  it('seeds clearly fictional briefs for three cases and none for the others', async () => {
    const { cases } = setup()
    const seeded = []
    for (const id of Object.values(demoCaseIds)) {
      const brief = await cases.getCaseBrief(id)
      if (brief?.updatedAt) seeded.push(id)
    }
    expect(seeded.sort()).toEqual([demoCaseIds.paternal, demoCaseIds.maternal, demoCaseIds.surname].sort())
  })
})
