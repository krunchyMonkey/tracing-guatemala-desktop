// Live readiness drill (#117). Run after `npm run web:build`:
//   npm run smoke:live
// Starts the BUILT Live host (dist-web/server/main.mjs) on a free port with a
// throwaway data folder, signs in through its private launch link over HTTP,
// and rehearses a working day: two clients with cases, a restart, a backup, a
// change, a restore, and checks that the original state comes back exactly and
// that nothing leaks between clients. Fictional data only; nothing real is read.
// Exits non-zero on the first failure.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(import.meta.dirname, '..')
const hostFile = join(root, 'dist-web', 'server', 'main.mjs')
if (!existsSync(hostFile)) {
  console.error('The Live host is not built: run `npm run web:build` first.')
  process.exit(1)
}

const dataDir = mkdtempSync(join(tmpdir(), 'tg-live-smoke-'))
const running = new Set()
const step = (name) => console.log(`PASS  ${name}`)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertSame(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}\n  expected: ${e.slice(0, 400)}\n  actual:   ${a.slice(0, 400)}`)
}

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

/** Starts the built host like a launcher would, minus --open; resolves once it prints its link. */
async function startHost(port, extraArgs = []) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', hostFile, '--port', String(port), '--data-dir', dataDir, ...extraArgs], {
    cwd: root
  })
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

/** Stops the host the way closing its window would: on Windows that ends the process at once. */
async function stopHost(host) {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return
  const exited = new Promise((done) => host.child.once('exit', done))
  host.child.kill()
  await exited
}

/** A host that must refuse to start (already running, bad port, ...): resolves with its exit code and output. */
function runHostExpectingFailure(port, extraArgs) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', hostFile, '--port', String(port), '--data-dir', dataDir, ...extraArgs], {
      cwd: root
    })
    let output = ''
    child.stdout.on('data', (c) => (output += c))
    child.stderr.on('data', (c) => (output += c))
    child.once('exit', (code) => done({ code, output }))
  })
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

/** Calls that report `{ ok: false, ... }` instead of throwing must have succeeded. */
async function mustSucceed(signed, name, ...args) {
  const result = await call(signed, name, ...args)
  assert(result?.ok === true, `${name} did not succeed: ${JSON.stringify(result)}`)
  return result
}

// ---------- fictional data and what to compare ----------

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

/** One client with a note and a case holding a brief, a journal entry and a task, all marked with `tag`. */
async function seedClient(signed, name, username, tag) {
  const { client } = await mustSucceed(signed, 'createClient', clientInput(name, username))
  await mustSucceed(signed, 'createNote', client.id, {
    kind: 'note',
    occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
    channel: null,
    direction: null,
    body: `Fictional note ${tag}.`
  })
  const { case: researchCase } = await mustSucceed(signed, 'createCase', client.id, {
    title: `Case ${tag}`,
    goal: `Goal ${tag}`,
    orderReference: `FO-FICTIONAL-${tag}`,
    dueDate: '2026-12-15'
  })
  await mustSucceed(signed, 'saveCaseBrief', researchCase.id, {
    objective: `Objective ${tag}`,
    facts: `Fact ${tag}`,
    people: null,
    hypotheses: `Hypothesis ${tag}`,
    questions: null
  })
  await mustSucceed(signed, 'createJournalEntry', researchCase.id, {
    occurredAt: new Date(Date.now() - 1_800_000).toISOString(),
    activity: null,
    body: `Journal ${tag}`
  })
  await mustSucceed(signed, 'createCaseTask', researchCase.id, { title: `Task ${tag}`, description: `Details ${tag}`, dueDate: '2026-11-20' })
  return { client, case: researchCase }
}

/** Everything the app holds, in a stable order, so two states can be compared exactly. */
async function snapshot(signed) {
  const clients = await call(signed, 'listClients', everyone)
  const cases = await call(signed, 'listCases', allCases)
  return {
    clients,
    notes: Object.fromEntries(await Promise.all(clients.map(async (c) => [c.id, await call(signed, 'listNotes', c.id)]))),
    cases,
    briefs: Object.fromEntries(await Promise.all(cases.map(async (c) => [c.id, await call(signed, 'getCaseBrief', c.id)]))),
    journal: Object.fromEntries(await Promise.all(cases.map(async (c) => [c.id, await call(signed, 'listJournalEntries', c.id)]))),
    tasks: Object.fromEntries(await Promise.all(cases.map(async (c) => [c.id, await call(signed, 'listCaseTasks', c.id)]))),
    events: Object.fromEntries(await Promise.all(cases.map(async (c) => [c.id, await call(signed, 'listCaseEvents', c.id)])))
  }
}

const counts = (s) => ({
  clients: s.clients.length,
  cases: s.cases.length,
  notes: Object.values(s.notes).flat().length,
  journal: Object.values(s.journal).flat().length,
  tasks: Object.values(s.tasks).flat().length
})

/** Each case's journal, tasks and brief mention only its own client's marker. */
function assertIsolated(s, owners) {
  for (const researchCase of s.cases) {
    const own = owners[researchCase.id]
    assert(own, `unexpected case ${researchCase.title}`)
    const text = JSON.stringify([s.journal[researchCase.id], s.tasks[researchCase.id], s.briefs[researchCase.id], s.notes[researchCase.clientId]])
    assert(text.includes(`Journal ${own}`) && text.includes(`Task ${own}`) && text.includes(`Fact ${own}`), `case ${own} lost its own records`)
    for (const other of Object.values(owners).filter((tag) => tag !== own)) {
      assert(!text.includes(other), `case ${own} shows records that belong to ${other}`)
    }
    for (const entry of s.journal[researchCase.id]) assert(entry.caseId === researchCase.id, 'a journal entry sits under the wrong case')
    for (const task of s.tasks[researchCase.id]) assert(task.caseId === researchCase.id, 'a task sits under the wrong case')
  }
}

// ---------- the drill ----------

let host = null
let failed = false
try {
  const port = await freePort()
  console.log(`Live readiness drill: built host, port ${port}, throwaway data folder\n`)

  // 1. A working day: two clients, each with a case and its records.
  host = await startHost(port)
  let signed = await signIn(host)
  step('host started on 127.0.0.1 and the private launch link signs in')
  const a = await seedClient(signed, 'Ana Ficticia', 'fictional_buyer_a', 'ALFA')
  const b = await seedClient(signed, 'Beto Ficticio', 'fictional_buyer_b', 'BRAVO')
  const owners = { [a.case.id]: 'ALFA', [b.case.id]: 'BRAVO' }
  const original = await snapshot(signed)
  assertSame(counts(original), { clients: 2, cases: 2, notes: 2, journal: 2, tasks: 2 }, 'unexpected counts after seeding')
  assertIsolated(original, owners)
  step('two clients created, each with a case, brief, journal entry and task; records stay with their own case')

  const noStatus = await call(signed, 'getBackupStatus')
  assertSame(noStatus, { lastBackupAt: null, fileName: null, backupCount: 0 }, 'status before any backup')
  step('getBackupStatus says no backup has been made yet')

  // 2. Closing the window and starting again keeps everything.
  await stopHost(host)
  host = await startHost(port)
  signed = await signIn(host)
  assertSame(await snapshot(signed), original, 'data changed across a restart')
  step('after stopping and restarting the host, every client, case and record is exactly as it was')

  // 3. A second copy must not start, and must not try to open a browser.
  const second = await runHostExpectingFailure(await freePort(), ['--open'])
  assert(second.code !== 0, 'a second host on the same data started')
  assert(/already running/.test(second.output), `unexpected message from a second host: ${second.output}`)
  assert(!/Opening your browser/.test(second.output), 'a failed start tried to open the browser')
  step('a second host on the same data refuses to start and does not open a browser')

  // 4. Back up and download.
  const made = await call(signed, 'createBackup')
  assert(made.ok === true && made.clients === 2, `backup failed: ${JSON.stringify(made)}`)
  const download = await fetch(`${host.origin}/api/v1/backup/download/${encodeURIComponent(made.fileName)}`, { headers: { Cookie: signed.cookie } })
  assert(download.status === 200, `download answered ${download.status}`)
  const backupBytes = Buffer.from(await download.arrayBuffer())
  assert(backupBytes.subarray(0, 15).toString('latin1') === 'SQLite format 3', 'the downloaded backup is not a SQLite file')
  assert(readdirSync(join(dataDir, 'backups')).includes(made.fileName), 'the backup is missing from the app backups folder')
  step(`backup created and downloaded (${backupBytes.length} bytes), and a copy kept in the app backups folder`)

  const status = await call(signed, 'getBackupStatus')
  assert(status.fileName === made.fileName && status.backupCount === 1, `status does not match the backup: ${JSON.stringify(status)}`)
  assert(Math.abs(Date.now() - Date.parse(status.lastBackupAt)) < 60_000, 'status date is not recent')
  assert(!/[\\/]/.test(JSON.stringify(status)), 'status contains a path')
  step('getBackupStatus reports this backup: recent date, its file name, count 1, no path')

  // 5. Work continues after the backup: more data, an edit.
  const c = await seedClient(signed, 'Carla Ficticia', 'fictional_buyer_c', 'CHARLIE')
  await mustSucceed(signed, 'updateCase', a.case.id, { title: 'Case ALFA (edited)', goal: 'Edited goal', orderReference: a.case.orderReference, dueDate: '2026-12-31' })
  await mustSucceed(signed, 'createJournalEntry', a.case.id, { occurredAt: new Date(Date.now() - 60_000).toISOString(), activity: null, body: 'Journal ALFA (late entry)' })
  const changed = await snapshot(signed)
  assertSame(counts(changed), { clients: 3, cases: 3, notes: 3, journal: 4, tasks: 3 }, 'unexpected counts after the changes')
  assert(JSON.stringify(changed) !== JSON.stringify(original), 'the changes did not change anything')
  step('a third client was added and a case edited after the backup')

  // 6. Restore the backup by upload.
  const upload = await fetch(`${host.origin}/api/v1/backup/upload`, {
    method: 'POST',
    headers: { ...writeHeaders(signed), 'Content-Type': 'application/octet-stream', 'X-TG-File-Name': encodeURIComponent(made.fileName) },
    body: backupBytes
  })
  const choice = (await upload.json()).result
  assert(upload.status === 200 && choice.ok === true && choice.clients === 2, `upload was not accepted: ${JSON.stringify(choice)}`)
  assertSame(await snapshot(signed), changed, 'checking an upload changed the data before it was confirmed')
  step('the backup was uploaded and checked without changing any data')
  const restored = await call(signed, 'restoreBackup', choice.token)
  assert(restored.ok === true && restored.clients === 2, `restore failed: ${JSON.stringify(restored)}`)
  const afterRestore = await snapshot(signed)
  assertSame(afterRestore, original, 'restored data differs from the original state')
  assertSame(counts(afterRestore), { clients: 2, cases: 2, notes: 2, journal: 2, tasks: 2 }, 'unexpected counts after the restore')
  assert(!JSON.stringify(afterRestore).includes('CHARLIE') && !JSON.stringify(afterRestore).includes('late entry'), 'data from after the backup survived the restore')
  step('after the restore, counts and every record match the original state exactly; later changes are gone')

  assertIsolated(afterRestore, owners)
  step('after the restore, each case still lists only its own journal entries, tasks and brief')

  assertSame(await call(signed, 'getBackupStatus'), status, 'a restore changed the backup status')
  step('restoring did not change the backup status (it describes backups made)')

  const safety = readdirSync(join(dataDir, 'data', 'pre-restore'))
  assert(safety.length === 1, `expected one pre-restore safety copy, found ${safety.length}`)
  const copy = new DatabaseSync(join(dataDir, 'data', 'pre-restore', safety[0]), { readOnly: true })
  try {
    const names = copy.prepare('SELECT display_name FROM clients ORDER BY display_name').all().map((r) => r.display_name)
    assertSame(names, ['Ana Ficticia', 'Beto Ficticio', 'Carla Ficticia'], 'the safety copy does not hold the data from just before the restore')
  } finally {
    copy.close()
  }
  step(`the data from just before the restore was kept as a safety copy (${c.client.displayName} is in it)`)

  // 7. The restored state is what is on disk.
  await stopHost(host)
  host = await startHost(port)
  signed = await signIn(host)
  assertSame(await snapshot(signed), original, 'data differs after restarting following the restore')
  assertSame((await call(signed, 'getBackupStatus')).backupCount, 1, 'backup count changed across a restart')
  assert(readFileSync(join(dataDir, 'backup-status.json'), 'utf8').includes(made.fileName), 'backup-status.json lost the backup')
  step('after one more restart, the restored data and the backup status are still there')

  console.log('\nLive readiness drill: all steps passed.')
} catch (error) {
  failed = true
  console.error(`\nFAIL  ${error instanceof Error ? error.message : error}`)
  if (host) console.error(`\nHost output:\n${host.output}`)
} finally {
  for (const child of running) child.kill()
  await new Promise((done) => setTimeout(done, 300))
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
process.exit(failed ? 1 : 0)
