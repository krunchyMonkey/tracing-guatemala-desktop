// Phase 2 pilot rehearsal (#21, engineering side). Run after `npm run web:build`:
//   npm run pilot:rehearsal
// Drives the BUILT Live host (dist-web/server/main.mjs) over HTTP exactly like the
// browser does (launch link -> session cookie -> CSRF token) through the #21 pilot
// scenario: two clients, cases, brief, journal, tasks, states, archive and reopen,
// research hours (manual + timer), case export scope, cross-client isolation, the
// Studio summary, backup / change / restore / restart, an older-database migration,
// timer reconciliation after the host was away, and security probes.
// Fictional data only, in throwaway folders that are removed at the end. This is
// engineering evidence. It is NOT the researcher's pilot and proves no approval.
// Exits non-zero when any step fails.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(import.meta.dirname, '..')
const hostFile = join(root, 'dist-web', 'server', 'main.mjs')
if (!existsSync(hostFile)) {
  console.error('The Live host is not built: run `npm run web:build` first.')
  process.exit(1)
}

const dataDir = mkdtempSync(join(tmpdir(), 'tg-pilot-rehearsal-'))
const oldDir = mkdtempSync(join(tmpdir(), 'tg-pilot-rehearsal-old-'))
const DB_FILE = 'tracing-guatemala.sqlite'
const APPLICATION_ID = 0x54474431
const running = new Set()
const results = { pass: 0, fail: 0, manual: 0 }
let number = 0

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertSame(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}\n  expected: ${e.slice(0, 400)}\n  actual:   ${a.slice(0, 400)}`)
}

/** Runs one numbered check. A failure is printed and counted; later checks still run. */
async function step(name, fn) {
  number += 1
  const label = String(number).padStart(2, '0')
  try {
    await fn()
    results.pass += 1
    console.log(`PASS  ${label} ${name}`)
  } catch (error) {
    results.fail += 1
    console.log(`FAIL  ${label} ${name}\n        ${(error instanceof Error ? error.message : String(error)).replace(/\n/g, '\n        ')}`)
  }
}

/** Something this script cannot check without a browser or a person. */
function manual(name) {
  number += 1
  results.manual += 1
  console.log(`MANUAL ${String(number).padStart(2, '0')} ${name}`)
}

// ---------- small helpers ----------

function localDate(offsetDays = 0) {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const isoDaysAgo = (days, minutes = 0) => new Date(Date.now() - days * 86_400_000 - minutes * 60_000).toISOString()

function freePort() {
  return new Promise((ready, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ready(port))
    })
  })
}

// ---------- the host process ----------

async function startHost(port, dir = dataDir) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', hostFile, '--port', String(port), '--data-dir', dir], { cwd: root })
  const host = { child, output: '', port, origin: `http://127.0.0.1:${port}`, launchUrl: '' }
  running.add(child)
  child.once('exit', () => running.delete(child))
  const onData = (chunk) => (host.output += chunk.toString())
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  host.launchUrl = await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`the host did not start in time:\n${host.output}`)), 20_000)
    const check = () => {
      const match = /http:\/\/127\.0\.0\.1:\d+\/launch\?token=[\w-]+/.exec(host.output)
      if (match && host.output.includes('Press Ctrl+C to stop')) {
        clearTimeout(timer)
        ready(match[0])
      }
    }
    child.stdout.on('data', check)
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`the host exited with ${code}:\n${host.output}`))
    })
  })
  return host
}

async function stopHost(host) {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return
  const exited = new Promise((done) => host.child.once('exit', done))
  host.child.kill()
  await exited
}

/** Edits the SQLite file directly. Only ever while the host is stopped. */
function editDatabase(dir, sql, ...params) {
  const db = new DatabaseSync(join(dir, 'data', DB_FILE))
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

// ---------- the browser's side: cookie + CSRF over HTTP ----------

async function signIn(host) {
  const launch = await fetch(host.launchUrl, { redirect: 'manual' })
  assert(launch.status === 303, `launch link answered ${launch.status}, expected 303`)
  const cookie = launch.headers.get('set-cookie')?.split(';')[0]
  assert(cookie, 'launch link did not set a session cookie')
  const session = await (await fetch(`${host.origin}/api/v1/session`, { headers: { Cookie: cookie } })).json()
  assert(session.authenticated && session.csrfToken, 'session is not signed in')
  return { host, cookie, csrf: session.csrfToken }
}

const writeHeaders = ({ host, cookie, csrf }) => ({ Origin: host.origin, Cookie: cookie, 'X-TG-CSRF': csrf })

async function call(signed, name, ...args) {
  const response = await fetch(`${signed.host.origin}/api/v1/call/${name}`, {
    method: 'POST',
    headers: { ...writeHeaders(signed), 'Content-Type': 'application/json' },
    body: JSON.stringify({ args })
  })
  const text = await response.text()
  assert(response.status === 200, `${name} answered ${response.status}: ${text}`)
  return JSON.parse(text).result
}

async function mustSucceed(signed, name, ...args) {
  const result = await call(signed, name, ...args)
  assert(result?.ok === true, `${name} did not succeed: ${JSON.stringify(result)}`)
  return result
}

/** A raw request with full control of the headers (fetch refuses to set Host). */
function raw(host, method, path, headers, body) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port: host.port, method, path, agent: false, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', fail)
    req.end(body)
  })
}

// ---------- fictional data ----------

const everyone = { text: '', status: 'all', sources: [], sort: 'name' }
const allCases = { clientId: null, archived: 'all', states: [], text: '', sort: 'title' }

const clientInput = (displayName, username) => ({
  displayName,
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: username,
  email: null,
  otherContact: null,
  preferredContactChannel: 'fiverr'
})

const caseInput = (title, goal, ref, dueDate) => ({ title, goal, orderReference: ref, dueDate })

/** Everything the app holds, in a stable order, so two states can be compared exactly. */
async function snapshot(signed) {
  const clients = await call(signed, 'listClients', everyone)
  const cases = await call(signed, 'listCases', allCases)
  const perCase = async (name) => Object.fromEntries(await Promise.all(cases.map(async (c) => [c.id, await call(signed, name, c.id)])))
  return {
    clients,
    notes: Object.fromEntries(await Promise.all(clients.map(async (c) => [c.id, await call(signed, 'listNotes', c.id)]))),
    cases,
    briefs: await perCase('getCaseBrief'),
    journal: await perCase('listJournalEntries'),
    tasks: await perCase('listCaseTasks'),
    events: await perCase('listCaseEvents'),
    time: await perCase('listTimeEntries'),
    timer: await call(signed, 'getActiveTimer'),
    studio: await call(signed, 'getStudioSummary')
  }
}

const sum = (entries) => entries.reduce((total, e) => total + e.durationMinutes, 0)

// ---------- the rehearsal ----------

const ctx = {}
let host = null
let signed = null

try {
  const port = await freePort()
  console.log(`Phase 2 pilot rehearsal: built host, port ${port}, throwaway data folders`)
  console.log('Engineering evidence only. This is not the researcher pilot and records no approval.\n')

  host = await startHost(port)
  signed = await signIn(host)
  await step('host started on 127.0.0.1 and the private launch link signs in (cookie + CSRF token)', async () => {
    assert(signed.csrf.length > 10, 'no CSRF token')
  })

  // --- clients and cases ---
  await step('two fictional clients created (Ana Ficticia, Beto Ficticio)', async () => {
    ctx.a = (await mustSucceed(signed, 'createClient', clientInput('Ana Ficticia', 'fictional_buyer_a'))).client
    ctx.b = (await mustSucceed(signed, 'createClient', clientInput('Beto Ficticio', 'fictional_buyer_b'))).client
    await mustSucceed(signed, 'createNote', ctx.a.id, { kind: 'note', occurredAt: isoDaysAgo(2), channel: null, direction: null, body: 'Fictional intake note ALFA.' })
    await mustSucceed(signed, 'createNote', ctx.b.id, { kind: 'note', occurredAt: isoDaysAgo(1), channel: null, direction: null, body: 'Fictional intake note BRAVO.' })
    assertSame((await call(signed, 'listClients', everyone)).length, 2, 'client count')
  })

  await step('two cases under client A and one under client B; each case belongs to its own client', async () => {
    ctx.a1 = (await mustSucceed(signed, 'createCase', ctx.a.id, caseInput('Maternal grandparents ALFA', 'Goal ALFA-1', 'FO-FICTIONAL-A1', localDate(30)))).case
    ctx.a2 = (await mustSucceed(signed, 'createCase', ctx.a.id, caseInput('Paternal line ALFA', 'Goal ALFA-2', 'FO-FICTIONAL-A2', null))).case
    ctx.b1 = (await mustSucceed(signed, 'createCase', ctx.b.id, caseInput('Family register BRAVO', 'Goal BRAVO', 'FO-FICTIONAL-B1', localDate(20)))).case
    assertSame([ctx.a1.state, ctx.a2.state, ctx.b1.state], ['intake', 'intake', 'intake'], 'new cases should start in intake')
    const mine = await call(signed, 'listCases', { ...allCases, clientId: ctx.a.id })
    assertSame(mine.map((c) => c.id).sort(), [ctx.a1.id, ctx.a2.id].sort(), 'client A cases')
    const his = await call(signed, 'listCases', { ...allCases, clientId: ctx.b.id })
    assertSame(his.map((c) => c.id), [ctx.b1.id], 'client B cases')
  })

  // --- brief, journal, tasks ---
  await step('a brief (objectives, facts, hypotheses, questions) is saved and read back', async () => {
    const brief = (tag) => ({
      objective: `Objective ${tag}`,
      facts: `Fact ${tag}: a fictional baptism record.`,
      people: `Person ${tag}`,
      hypotheses: `Hypothesis ${tag}: a fictional migration.`,
      questions: `Question ${tag}?`
    })
    await mustSucceed(signed, 'saveCaseBrief', ctx.a1.id, brief('ALFA-1'))
    await mustSucceed(signed, 'saveCaseBrief', ctx.b1.id, brief('BRAVO'))
    const got = await call(signed, 'getCaseBrief', ctx.a1.id)
    assert(got.objective === 'Objective ALFA-1' && got.hypotheses.includes('Hypothesis ALFA-1') && got.questions === 'Question ALFA-1?', 'brief did not round-trip')
  })

  await step('dated journal entries are saved newest first; a date days in the future is refused', async () => {
    const older = (await mustSucceed(signed, 'createJournalEntry', ctx.a1.id, { occurredAt: isoDaysAgo(3), activity: 'Archive visit', body: 'Journal ALFA-1 older' })).entry
    const newer = (await mustSucceed(signed, 'createJournalEntry', ctx.a1.id, { occurredAt: isoDaysAgo(1), activity: null, body: 'Journal ALFA-1 newer' })).entry
    await mustSucceed(signed, 'createJournalEntry', ctx.b1.id, { occurredAt: isoDaysAgo(1), activity: null, body: 'Journal BRAVO' })
    assertSame((await call(signed, 'listJournalEntries', ctx.a1.id)).map((e) => e.id), [newer.id, older.id], 'journal order')
    const future = await call(signed, 'createJournalEntry', ctx.a1.id, { occurredAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), activity: null, body: 'x' })
    assert(future.ok === false, 'a journal entry dated days in the future was accepted')
  })

  await step('tasks with date-only deadlines are created; one is completed, reopened and completed again', async () => {
    ctx.t1 = (await mustSucceed(signed, 'createCaseTask', ctx.a1.id, { title: 'Request register ALFA-1', description: null, dueDate: localDate(3) })).task
    ctx.t2 = (await mustSucceed(signed, 'createCaseTask', ctx.a1.id, { title: 'Compare names ALFA-1', description: 'Details', dueDate: localDate(-1) })).task
    ctx.t3 = (await mustSucceed(signed, 'createCaseTask', ctx.a1.id, { title: 'Write notes ALFA-1', description: null, dueDate: localDate(2) })).task
    await mustSucceed(signed, 'createCaseTask', ctx.b1.id, { title: 'Task BRAVO', description: null, dueDate: localDate(1) })
    const done = (await mustSucceed(signed, 'completeCaseTask', ctx.a1.id, ctx.t1.id)).task
    assert(done.status === 'completed' && done.completedAt, 'task not completed')
    const reopened = (await mustSucceed(signed, 'reopenCaseTask', ctx.a1.id, ctx.t1.id)).task
    assert(reopened.status === 'pending' && reopened.completedAt === null, 'task not reopened')
    await mustSucceed(signed, 'completeCaseTask', ctx.a1.id, ctx.t1.id)
    const bad = await call(signed, 'createCaseTask', ctx.a1.id, { title: 'Bad date', description: null, dueDate: '2026-02-30' })
    assert(bad.ok === false, 'an impossible date was accepted')
  })

  // --- states, archive, reopen ---
  await step('case A1 moves through states; a move outside the matrix is refused', async () => {
    for (const next of ['active', 'waiting', 'active', 'delivered', 'closed', 'active']) {
      const moved = await mustSucceed(signed, 'setCaseState', ctx.a1.id, next)
      assert(moved.case.state === next, `expected ${next}`)
    }
    const refused = await call(signed, 'setCaseState', ctx.a1.id, 'intake')
    assertSame(refused, { ok: false, reason: 'invalid-transition' }, 'active -> intake should be refused')
    await mustSucceed(signed, 'setCaseState', ctx.b1.id, 'active')
    const kinds = (await call(signed, 'listCaseEvents', ctx.a1.id)).map((e) => e.kind)
    assertSame(kinds.filter((k) => k === 'state').length, 6, 'one state event per move')
  })

  await step('archive removes a case from the open count and makes it read-only; reopen restores it', async () => {
    const before = (await call(signed, 'getStudioSummary')).counts.openCases
    await mustSucceed(signed, 'archiveCase', ctx.a2.id)
    const archived = await call(signed, 'getCase', ctx.a2.id)
    assert(archived.archivedAt, 'case not archived')
    const write = await call(signed, 'createJournalEntry', ctx.a2.id, { occurredAt: isoDaysAgo(0), activity: null, body: 'should be refused' })
    assertSame(write, { ok: false, reason: 'wrong-status' }, 'writes to an archived case')
    assertSame((await call(signed, 'getStudioSummary')).counts.openCases, before - 1, 'archived case still counted as open')
    await mustSucceed(signed, 'unarchiveCase', ctx.a2.id)
    assertSame((await call(signed, 'getStudioSummary')).counts.openCases, before, 'reopened case not counted again')
    await mustSucceed(signed, 'createJournalEntry', ctx.a2.id, { occurredAt: isoDaysAgo(0, 5), activity: null, body: 'Journal ALFA-2' })
  })

  // --- research hours ---
  await step('a manual time entry is saved; 0 minutes, 13 hours and an unknown activity type are refused', async () => {
    ctx.manual = (await mustSucceed(signed, 'createTimeEntry', ctx.a1.id, { workDate: localDate(0), durationMinutes: 90, activityType: 'research', note: 'Manual ALFA-1' })).entry
    assert(ctx.manual.source === 'manual' && ctx.manual.durationMinutes === 90, 'manual entry wrong')
    for (const minutes of [0, 13 * 60]) {
      const refused = await call(signed, 'createTimeEntry', ctx.a1.id, { workDate: localDate(0), durationMinutes: minutes, activityType: null, note: null })
      assert(refused.ok === false && refused.reason === 'invalid', `${minutes} minutes was accepted`)
    }
    const response = await fetch(`${host.origin}/api/v1/call/createTimeEntry`, {
      method: 'POST',
      headers: { ...writeHeaders(signed), 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [ctx.a1.id, { workDate: localDate(0), durationMinutes: 10, activityType: 'nonsense', note: null }] })
    })
    assert(response.status >= 400, `an unknown activity type answered ${response.status}`)
  })

  await step('timer: start, pause, resume, stop and save (one entry; counted time kept across a restart)', async () => {
    const started = await mustSucceed(signed, 'startTimer', ctx.a1.id)
    assert(started.timer.state === 'running', 'timer not running')
    const second = await call(signed, 'startTimer', ctx.b1.id)
    assert(second.ok === false && second.reason === 'other-case-timer', 'a second timer on another case was allowed')
    const paused = await mustSucceed(signed, 'pauseTimer', started.timer.version)
    assert(paused.timer.state === 'paused', 'timer not paused')
    const stale = await call(signed, 'resumeTimer', started.timer.version)
    assert(stale.ok === false && stale.reason === 'conflict', 'a stale version should conflict')
    // Give the paused timer 2.5 minutes of counted time, through the file, while the host is stopped.
    await stopHost(host)
    editDatabase(dataDir, 'UPDATE case_active_timer SET accumulated_seconds = 150')
    host = await startHost(port)
    signed = await signIn(host)
    const back = await call(signed, 'getActiveTimer')
    assert(back && back.state === 'paused' && back.elapsedSeconds === 150 && !back.needsReview, `paused timer lost across restart: ${JSON.stringify(back)}`)
    const resumed = await mustSucceed(signed, 'resumeTimer', back.version)
    const stopped = await mustSucceed(signed, 'stopAndSaveTimer', resumed.timer.version, { activityType: 'analysis', note: 'Timer ALFA-1', durationMinutesOverride: null })
    assert(stopped.timer === null && stopped.entry?.source === 'timer', 'timer did not save an entry')
    assert(stopped.entry.durationMinutes === 3 && stopped.entry.activityType === 'analysis', `unexpected timer entry ${JSON.stringify(stopped.entry)}`)
    assertSame(await call(signed, 'getActiveTimer'), null, 'timer should be gone after saving')
    assertSame((await call(signed, 'listTimeEntries', ctx.a1.id)).length, 2, 'A1 should hold the manual and the timer entry')
  })

  await step('timer reconciliation: after the host was away, the timer needs review and the gap is excluded', async () => {
    const started = await mustSucceed(signed, 'startTimer', ctx.b1.id)
    await stopHost(host)
    const away = new Date(Date.now() - 6 * 3600 * 1000)
    const heartbeat = new Date(away.getTime() + 3 * 60 * 1000)
    editDatabase(dataDir, 'UPDATE case_active_timer SET segment_started_at = ?, started_at = ?, last_heartbeat_at = ?', away.toISOString(), away.toISOString(), heartbeat.toISOString())
    host = await startHost(port)
    signed = await signIn(host)
    const timer = await call(signed, 'getActiveTimer')
    assert(timer?.needsReview === true && timer.reviewReason === 'heartbeat-gap', `timer should need review: ${JSON.stringify(timer)}`)
    assert(timer.suggestedSeconds >= 175 && timer.suggestedSeconds <= 185, `only the observed ~3 minutes should be suggested, got ${timer.suggestedSeconds}s`)
    const plain = await call(signed, 'stopAndSaveTimer', started.timer.version, { activityType: null, note: null, durationMinutesOverride: null })
    assert(plain.ok === false && plain.reason === 'needs-review', 'a timer needing review was saved without review')
    assertSame(await call(signed, 'listTimeEntries', ctx.b1.id), [], 'nothing may be saved before review')
    const saved = await mustSucceed(signed, 'stopAndSaveTimer', timer.version, { activityType: 'research', note: 'Timer BRAVO (reviewed)', durationMinutesOverride: 3 })
    assert(saved.entry.durationMinutes === 3, 'reviewed minutes not saved')
    assertSame(await call(signed, 'getActiveTimer'), null, 'timer should be gone after review')
  })

  // --- export scope, isolation ---
  await step('case export for A1 contains only client A and that case (nothing from client B)', async () => {
    // The browser composes the Markdown from exactly these scoped reads (src/renderer/src/cases/exportSummary.ts).
    const client = await call(signed, 'getClient', ctx.a1.clientId)
    const data = {
      client: { id: client.id, displayName: client.displayName },
      case: await call(signed, 'getCase', ctx.a1.id),
      brief: await call(signed, 'getCaseBrief', ctx.a1.id),
      journal: await call(signed, 'listJournalEntries', ctx.a1.id),
      tasks: await call(signed, 'listCaseTasks', ctx.a1.id),
      events: await call(signed, 'listCaseEvents', ctx.a1.id)
    }
    assert(data.client.id === data.case.clientId, 'client does not own the case')
    assert(
      data.brief.caseId === ctx.a1.id &&
        data.journal.every((e) => e.caseId === ctx.a1.id) &&
        data.tasks.every((t) => t.caseId === ctx.a1.id) &&
        data.events.every((e) => e.caseId === ctx.a1.id),
      'a record belongs to another case'
    )
    const text = JSON.stringify(data)
    assert(text.includes('ALFA-1') && text.includes('Ana Ficticia'), 'the export lost its own data')
    for (const other of ['BRAVO', 'Beto', 'ALFA-2', 'Paternal', 'fictional_buyer', 'intake note']) assert(!text.includes(other), `export data mentions "${other}"`)
    assertSame(Object.keys(data.client), ['id', 'displayName'], 'the export may carry only the client id and name')
  })

  await step("cross-client isolation: B1 shows none of client A's brief, journal, tasks or hours; A1 none of B's", async () => {
    const view = async (c) =>
      JSON.stringify([
        await call(signed, 'getCaseBrief', c.id),
        await call(signed, 'listJournalEntries', c.id),
        await call(signed, 'listCaseTasks', c.id),
        await call(signed, 'listTimeEntries', c.id),
        await call(signed, 'listCaseEvents', c.id)
      ])
    const b = await view(ctx.b1)
    const a = await view(ctx.a1)
    assert(b.includes('BRAVO') && b.includes('Timer BRAVO'), 'B1 lost its own records')
    assert(!b.includes('ALFA') && !b.includes(ctx.manual.id), 'B1 shows records of client A')
    assert(a.includes('Manual ALFA-1') && a.includes('Timer ALFA-1'), 'A1 lost its own records')
    assert(!a.includes('BRAVO'), 'A1 shows records of client B')
    assertSame((await call(signed, 'listNotes', ctx.b.id)).every((n) => n.clientId === ctx.b.id && !n.body.includes('ALFA')), true, 'B notes')
    const onlyB = await call(signed, 'listCases', { ...allCases, clientId: ctx.b.id })
    assert(onlyB.every((c) => c.clientId === ctx.b.id), 'client filter leaked a case')
  })

  await step('Studio summary counts match what was created', async () => {
    const s = await call(signed, 'getStudioSummary')
    assertSame(s.today, localDate(0), 'summary date')
    assertSame(s.counts.activeClients, 2, 'active clients')
    assertSame(s.counts.openCases, 3, 'open cases')
    assertSame(s.counts.casesByState, { intake: 1, active: 2, waiting: 0, delivered: 0, closed: 0 }, 'cases by state')
    assertSame(s.counts.overdueTasks, 1, 'overdue tasks (Compare names ALFA-1)')
    assertSame(s.counts.tasksDueSoon, 2, 'tasks due soon (A1 +2 days, B1 +1 day; the completed one does not count)')
    const all = [...(await call(signed, 'listTimeEntries', ctx.a1.id)), ...(await call(signed, 'listTimeEntries', ctx.b1.id))]
    assertSame(sum(all), 90 + 3 + 3, 'minutes logged')
    assertSame(s.hours.monthMinutes, sum(all), 'month minutes')
    assertSame(s.hours.weekMinutes, sum(all), 'week minutes')
    assertSame(s.upcomingTasks.map((t) => t.title).sort(), ['Compare names ALFA-1', 'Task BRAVO', 'Write notes ALFA-1'], 'upcoming tasks')
    assert(s.upcomingTasks.find((t) => t.title === 'Compare names ALFA-1').overdue === true, 'overdue flag')
    assert(s.activeCases.length === 3 && s.continueCase, 'active cases / continue case')
    const text = JSON.stringify(s)
    assert(!text.includes('Fictional intake note') && !text.includes('Journal ALFA') && !text.includes('fictional_buyer'), 'the summary leaked note, journal or contact text')
  })

  // --- backup, change, restore, restart ---
  let original
  let backupBytes
  let made
  let changed
  await step('backup created and downloaded, with a copy in the app backups folder', async () => {
    original = await snapshot(signed)
    assertSame(await call(signed, 'getBackupStatus'), { lastBackupAt: null, fileName: null, backupCount: 0 }, 'status before any backup')
    made = await call(signed, 'createBackup')
    assert(made.ok === true && made.clients === 2, `backup failed: ${JSON.stringify(made)}`)
    const download = await fetch(`${host.origin}/api/v1/backup/download/${encodeURIComponent(made.fileName)}`, { headers: { Cookie: signed.cookie } })
    assert(download.status === 200, `download answered ${download.status}`)
    backupBytes = Buffer.from(await download.arrayBuffer())
    assert(backupBytes.subarray(0, 15).toString('latin1') === 'SQLite format 3', 'the download is not a SQLite file')
    assert(readdirSync(join(dataDir, 'backups')).includes(made.fileName), 'backup missing from the backups folder')
    assertSame((await call(signed, 'getBackupStatus')).backupCount, 1, 'backup count')
  })

  await step('a change after the backup (new client, case, journal entry, hours, state) is visible', async () => {
    const c = (await mustSucceed(signed, 'createClient', clientInput('Carla Ficticia', 'fictional_buyer_c'))).client
    const cc = (await mustSucceed(signed, 'createCase', c.id, caseInput('Case CHARLIE', null, null, null))).case
    await mustSucceed(signed, 'createJournalEntry', ctx.a1.id, { occurredAt: isoDaysAgo(0, 2), activity: null, body: 'Journal ALFA-1 late entry' })
    await mustSucceed(signed, 'createTimeEntry', cc.id, { workDate: localDate(0), durationMinutes: 45, activityType: null, note: null })
    await mustSucceed(signed, 'setCaseState', ctx.b1.id, 'waiting')
    changed = await snapshot(signed)
    assert(JSON.stringify(changed) !== JSON.stringify(original), 'the change changed nothing')
    assertSame(changed.clients.length, 3, 'clients after the change')
  })

  await step('restore: the upload is checked without changing data, then confirmed; data equals the original exactly', async () => {
    const upload = await fetch(`${host.origin}/api/v1/backup/upload`, {
      method: 'POST',
      headers: { ...writeHeaders(signed), 'Content-Type': 'application/octet-stream', 'X-TG-File-Name': encodeURIComponent(made.fileName) },
      body: backupBytes
    })
    const choice = (await upload.json()).result
    assert(upload.status === 200 && choice.ok === true && choice.clients === 2, `upload not accepted: ${JSON.stringify(choice)}`)
    assertSame(await snapshot(signed), changed, 'checking an upload changed data')
    const restored = await call(signed, 'restoreBackup', choice.token)
    assert(restored.ok === true && restored.clients === 2, `restore failed: ${JSON.stringify(restored)}`)
    const after = await snapshot(signed)
    assertSame(after, original, 'restored data differs from the original state')
    const text = JSON.stringify(after)
    assert(!text.includes('CHARLIE') && !text.includes('late entry'), 'data from after the backup survived the restore')
    assertSame(readdirSync(join(dataDir, 'data', 'pre-restore')).length, 1, 'one pre-restore safety copy expected')
  })

  await step('after stopping and restarting the host, the restored data is exactly as expected', async () => {
    await stopHost(host)
    host = await startHost(port)
    signed = await signIn(host)
    assertSame(await snapshot(signed), original, 'data differs after the restart')
    assertSame((await call(signed, 'getBackupStatus')).backupCount, 1, 'backup count after restart')
  })

  // --- security probes ---
  await step('security: a foreign Origin is refused and nothing is written', async () => {
    const before = (await call(signed, 'listClients', everyone)).length
    for (const origin of ['http://evil.example', `http://localhost:${port}`, 'null']) {
      const headers = { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: signed.cookie, 'X-TG-CSRF': signed.csrf, 'Content-Type': 'application/json' }
      const reply = await raw(host, 'POST', '/api/v1/call/createClient', headers, JSON.stringify({ args: [clientInput('Intruder Ficticio', 'x')] }))
      assert(reply.status === 403, `Origin ${origin} answered ${reply.status}, expected 403`)
    }
    assertSame((await call(signed, 'listClients', everyone)).length, before, 'a refused request still wrote data')
  })

  await step('security: a non-loopback Host header (LAN IP, other name, wrong port) is refused; so is localhost:<port>', async () => {
    // Only 127.0.0.1:<port> is answered (src/server/access.ts allowedHosts). Not `localhost`: that
    // name is the fictional demo mirror's site (#114), and cookies are not scoped by port.
    for (const hostHeader of [`192.168.1.20:${port}`, `evil.example:${port}`, `127.0.0.1:${port + 1}`, `localhost:${port}`, `localhost:${port + 1}`, '192.168.1.20']) {
      const reply = await raw(host, 'GET', '/api/v1/session', { Host: hostHeader, Cookie: signed.cookie })
      assert(reply.status === 421, `Host ${hostHeader} answered ${reply.status}, expected 421`)
      const headers = { Host: hostHeader, Origin: `http://${hostHeader}`, Cookie: signed.cookie, 'X-TG-CSRF': signed.csrf, 'Content-Type': 'application/json' }
      const write = await raw(host, 'POST', '/api/v1/call/listClients', headers, JSON.stringify({ args: [everyone] }))
      assert(write.status === 421, `API call with Host ${hostHeader} answered ${write.status}, expected 421`)
    }
  })

  await step('security: a missing or wrong CSRF token, or no session, is refused', async () => {
    const base = { Host: `127.0.0.1:${port}`, Origin: host.origin, 'Content-Type': 'application/json' }
    const body = JSON.stringify({ args: [everyone] })
    const missing = await raw(host, 'POST', '/api/v1/call/listClients', { ...base, Cookie: signed.cookie }, body)
    assert(missing.status === 403, `missing CSRF token answered ${missing.status}, expected 403`)
    const wrong = await raw(host, 'POST', '/api/v1/call/listClients', { ...base, Cookie: signed.cookie, 'X-TG-CSRF': 'not-the-token' }, body)
    assert(wrong.status === 403, `wrong CSRF token answered ${wrong.status}, expected 403`)
    const anonymous = await raw(host, 'POST', '/api/v1/call/listClients', { ...base, 'X-TG-CSRF': signed.csrf }, body)
    assert(anonymous.status === 401 || anonymous.status === 403, `no session answered ${anonymous.status}, expected 401/403`)
    const noCookie = await raw(host, 'GET', '/api/v1/session', { Host: `127.0.0.1:${port}` })
    assert(JSON.parse(noCookie.text).authenticated === false, 'a request without the cookie looked signed in')
  })

  await step("security: the host does not answer on this machine's LAN addresses", async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address)
    for (const address of lan) {
      const reachable = await new Promise((done) => {
        const req = request({ host: address, port, path: '/api/v1/session', method: 'GET', timeout: 2000, agent: false }, (res) => {
          res.resume()
          done(true)
        })
        req.on('timeout', () => {
          req.destroy()
          done(false)
        })
        req.on('error', () => done(false))
        req.end()
      })
      assert(!reachable, `the host answered on ${address}`)
    }
  })

  await stopHost(host)
  host = null

  // --- migration from an older database ---
  await step('older database: a v2 (clients + notes only) file is upgraded; clients survive, case tables exist, a pre-migration copy is kept', async () => {
    // Same recipe as tests/unit/cases.test.ts buildV2Profile: migrations 1-2 only, read from the source so it cannot drift.
    const source = readFileSync(join(root, 'src', 'main', 'database', 'migrations.ts'), 'utf8')
    const sqls = [...source.matchAll(/version: (\d+),\s*name: '[^']+',[\s\S]*?sql: `([\s\S]*?)`\s*\}/g)].map((m) => ({ version: Number(m[1]), sql: m[2] }))
    const v2 = sqls.filter((m) => m.version <= 2)
    assertSame(v2.map((m) => m.version), [1, 2], 'could not read migrations 1 and 2 from migrations.ts')
    const latest = sqls.length
    assert(latest >= 3, 'expected at least 3 migrations')
    mkdirSync(join(oldDir, 'data'), { recursive: true })
    const db = new DatabaseSync(join(oldDir, 'data', DB_FILE))
    const now = new Date().toISOString()
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    try {
      db.exec('PRAGMA foreign_keys = ON')
      for (const m of v2) {
        db.exec('BEGIN')
        db.exec(m.sql)
        db.exec(`PRAGMA user_version = ${m.version}`)
        db.exec('COMMIT')
      }
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
      const insert = db.prepare("INSERT INTO clients (id, display_name, source, fiverr_username, preferred_contact_channel, status, created_at, updated_at, archived_at) VALUES (?, ?, 'fiverr', ?, 'fiverr', ?, ?, ?, ?)")
      insert.run(ids[0], 'Ana Antigua', 'fictional_old_a', 'active', now, now, null)
      insert.run(ids[1], 'Beto Antiguo', 'fictional_old_b', 'active', now, now, null)
      insert.run(ids[2], 'Carla Antigua', 'fictional_old_c', 'archived', now, now, now)
      db.prepare("INSERT INTO client_notes (id, client_id, kind, occurred_at, body, created_at, updated_at) VALUES (?, ?, 'note', ?, 'Fictional note from the old app.', ?, ?)").run(randomUUID(), ids[0], now, now, now)
      assertSame(db.prepare('PRAGMA user_version').get().user_version, 2, 'fixture should be at v2')
    } finally {
      db.close()
    }
    const oldHost = await startHost(await freePort(), oldDir)
    try {
      const old = await signIn(oldHost)
      const clients = await call(old, 'listClients', everyone)
      assertSame(clients.map((c) => c.displayName).sort(), ['Ana Antigua', 'Beto Antiguo', 'Carla Antigua'], 'clients after the upgrade')
      assertSame(clients.find((c) => c.displayName === 'Carla Antigua').status, 'archived', 'archived client stays archived')
      assertSame((await call(old, 'listNotes', ids[0])).length, 1, 'old note')
      assertSame(await call(old, 'listCases', allCases), [], 'no cases yet')
      const created = await mustSucceed(old, 'createCase', ids[0], caseInput('Case for an old client', null, null, null))
      assert(created.case.clientId === ids[0], 'could not add a case to an old client')
      assertSame((await call(old, 'createCase', ids[2], caseInput('x', null, null, null))).reason, 'client-archived', 'archived old client must not take cases')
    } finally {
      await stopHost(oldHost)
    }
    const check = new DatabaseSync(join(oldDir, 'data', DB_FILE), { readOnly: true })
    try {
      assertSame(check.prepare('PRAGMA user_version').get().user_version, latest, 'schema version after upgrade')
      const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
      for (const t of ['research_cases', 'case_events', 'case_briefs', 'case_journal_entries', 'case_tasks', 'case_time_entries', 'case_active_timer']) {
        assert(tables.includes(t), `table ${t} missing after the upgrade`)
      }
      assertSame(check.prepare('PRAGMA foreign_key_check').all(), [], 'foreign key check')
    } finally {
      check.close()
    }
    assertSame(readdirSync(join(oldDir, 'data', 'pre-migration')).length, 1, 'one pre-migration copy expected')
  })

  // --- what a script cannot check ---
  manual('Browser walkthrough of the same scenario (screens, wording, dialogs): docs/pilot/phase-2-pilot-guide.md, Part 2')
  manual('Fictional LAN demo (npm run demo:lan) opened from a second device by the owner')
  manual('Timer left running while the computer really sleeps (lid closed): docs/pilot/phase-2-pilot-guide.md, "Timer suspend / restart check"')

  console.log(`\nPhase 2 pilot rehearsal: ${results.pass} passed, ${results.fail} failed, ${results.manual} manual.`)
  if (results.fail === 0) console.log('All automated steps passed. This is engineering evidence, not researcher acceptance.')
} catch (error) {
  results.fail += 1
  console.error(`\nFAIL  ${error instanceof Error ? error.stack : error}`)
  if (host) console.error(`\nHost output:\n${host.output}`)
} finally {
  for (const child of running) child.kill()
  await new Promise((done) => setTimeout(done, 300))
  for (const dir of [dataDir, oldDir]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
process.exit(results.fail > 0 ? 1 : 0)
