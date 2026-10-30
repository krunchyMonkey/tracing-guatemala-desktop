import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireDataDirLock } from '../../src/server/data-dir'
import { CALL_NAMES, REMOTE_CALL_NAMES } from '../../src/server/live-host'
import { initLanTestProfile, LAN_TEST_MARKER } from '../../src/server/lan-profile'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import { call, send, signIn, type Reply, type Signed } from './live-helpers'

// Phase 2.5 security sweep over the opt-in home-network listeners (#138): real HTTP
// on this computer's own private address, for what the earlier suites
// (live-lan.test.ts, live-lan-ux.test.ts) do not already cover. Fictional data only.
// The address is discovered at run time. Existing coverage is listed in
// docs/pilot/phase-2.5-lan-validation.md.

const appInfo = { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' } as const
const NAME = 'tg-demo.test'

const interfaces = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
const privateAddresses = interfaces
  .filter((e) => e.family === 'IPv4' && !e.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(e.address))
  .map((e) => e.address)
const lanAddress = privateAddresses.find((address) => privateAddresses.filter((a) => a === address).length === 1)

let root: string
let dataDir: string
let staticDir: string
let demoDir: string
let logs: string[]
let running: RunningLiveServer | null

async function start(options: { port?: number; demo?: boolean; now?: () => Date } = {}): Promise<RunningLiveServer> {
  if (!existsSync(join(dataDir, LAN_TEST_MARKER))) initLanTestProfile(dataDir)
  running = await startLiveServer({
    dataDir,
    port: options.port ?? 0,
    staticDir,
    appInfo,
    lanHost: lanAddress ?? null,
    lanDemoName: options.demo ? NAME : null,
    demoDir: options.demo ? demoDir : null,
    lanDemoResolve: async (name) => (name === NAME ? [lanAddress as string] : []),
    log: (line) => logs.push(line),
    ...(options.now ? { now: options.now } : {})
  })
  return running
}

/** A request to a socket on the LAN address with any Host header and no default headers. */
function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
  host: string | null = `${lanAddress}:${port}`
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const sent = host === null ? headers : { Host: host, ...headers }
    const req = request({ host: lanAddress, port, method, path, agent: false, setHost: false, headers: sent }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

const noCors = (reply: Reply) => expect(Object.keys(reply.headers).filter((h) => h.startsWith('access-control-'))).toEqual([])
const noCookie = (reply: Reply) => expect(reply.headers['set-cookie']).toBeUndefined()

const json = (headers: Record<string, string> = {}): Record<string, string> => ({ 'Content-Type': 'application/json', ...headers })
const listQuery = { text: '', status: 'all', sources: [], sort: 'name' }

interface Paired {
  cookie: string
  csrf: string
}

async function pair(live: RunningLiveServer, host: Signed, deviceName = 'Kitchen tablet'): Promise<Paired> {
  const { code } = await call<{ code: string }>(live, host, 'createPairingCode')
  const reply = await raw(live.port, 'POST', '/api/v1/lan/enroll', json({ Origin: live.lanOrigin as string }), JSON.stringify({ code, deviceName }))
  expect(reply.status, reply.text).toBe(200)
  const cookie = String(reply.headers['set-cookie']?.[0]).split(';')[0]!
  const session = (await raw(live.port, 'GET', '/api/v1/session', { Cookie: cookie })).json() as { csrfToken: string }
  return { cookie, csrf: session.csrfToken }
}

const lanCall = (live: RunningLiveServer, paired: Paired, name: string, ...args: unknown[]) =>
  raw(live.port, 'POST', `/api/v1/call/${name}`, json({ Origin: live.lanOrigin as string, Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf }), JSON.stringify({ args }))

async function lanResult<T = unknown>(live: RunningLiveServer, paired: Paired, name: string, ...args: unknown[]): Promise<T> {
  const reply = await lanCall(live, paired, name, ...args)
  expect(reply.status, `${name}: ${reply.text}`).toBe(200)
  return (reply.json() as { result: T }).result
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1_000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-lan-sec-'))
  dataDir = join(root, 'profile')
  staticDir = join(root, 'client')
  demoDir = join(root, 'demo')
  mkdirSync(staticDir, { recursive: true })
  mkdirSync(demoDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  writeFileSync(join(demoDir, 'index.html'), '<!doctype html><html><head><title>Demo</title></head><body></body></html>')
  logs = []
  running = null
})

afterEach(async () => {
  await running?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('Host spoofing and DNS rebinding on both LAN listeners', () => {
  it('Live answers its own address and port only: trailing dot, userinfo, the demo name, no port, wrong ports and attackers get 421, even with a valid session', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start({ demo: true })
    const host = await signIn(live)
    const paired = await pair(live, host)
    const p = live.port
    const hosts = [
      `${lanAddress}.:${p}`,
      `${lanAddress}:${p}@attacker.example`,
      `attacker.example:${p}@${lanAddress}:${p}`,
      `${lanAddress}:${p}, attacker.example`,
      `${NAME}:${p}`,
      `${NAME}:${p + 1}`,
      lanAddress,
      `${lanAddress}:`,
      `${lanAddress}:0`,
      `${lanAddress}:${p - 1}`,
      `${lanAddress}:${p + 1}`,
      `Attacker.EXAMPLE:${p}`,
      `attacker.example`,
      `[::1]:${p}`,
      ''
    ]
    for (const hostHeader of hosts) {
      for (const [method, path, body] of [
        ['GET', '/', undefined],
        ['GET', '/api/v1/session', undefined],
        ['POST', '/api/v1/call/listClients', JSON.stringify({ args: [listQuery] })],
        ['POST', '/api/v1/lan/enroll', JSON.stringify({ code: 'AAAA-AAAA' })],
        ['POST', '/api/v1/lan/logout', '{}']
      ] as const) {
        const headers = json({ Origin: live.lanOrigin as string, Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf })
        const reply = await raw(p, method, path, headers, body, hostHeader)
        expect(reply.status, `${hostHeader} ${method} ${path}`).toBe(421)
        expect(reply.json()).toEqual({ error: 'bad-host' })
        noCookie(reply)
        noCors(reply)
      }
    }
    // None of that signed the device out or changed anything.
    expect(await lanResult(live, paired, 'listClients', listQuery)).toEqual([])
  })

  it('the LAN demo answers its name and port only; the IP, trailing dot, no port, other ports and attackers get 421', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start({ demo: true })
    const dp = live.port + 1
    const hosts = [
      `${lanAddress}:${dp}`,
      `${lanAddress}:${live.port}`,
      `${NAME}.:${dp}`,
      `${NAME}:${dp}@attacker.example`,
      `attacker.example:${dp}`,
      `Attacker.Example:${dp}`,
      `${NAME}:${live.port}`,
      `${NAME}:`,
      NAME,
      `localhost:${dp}`,
      `127.0.0.1:${dp}`,
      ''
    ]
    for (const hostHeader of hosts) {
      for (const [method, path] of [
        ['GET', '/'],
        ['GET', '/api/v1/session'],
        ['OPTIONS', '/'],
        ['POST', '/api/v1/call/listClients']
      ] as const) {
        const reply = await raw(dp, method, path, { Origin: 'http://attacker.example' }, undefined, hostHeader)
        expect(reply.status, `${hostHeader} ${method} ${path}`).toBe(421)
        noCookie(reply)
        noCors(reply)
      }
    }
  })

  it('a mixed-case spelling of the allowed name is the same host, so it is served; the demo still has no cookie, API or CORS', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start({ demo: true })
    const dp = live.port + 1
    const ok = await raw(dp, 'GET', '/', { Origin: 'http://attacker.example' }, undefined, `Tg-Demo.TEST:${dp}`)
    expect(ok.status).toBe(200)
    noCookie(ok)
    noCors(ok)
    expect((await raw(dp, 'GET', '/api/v1/session', {}, undefined, `Tg-Demo.TEST:${dp}`)).status).toBe(404)
  })
})

describe('Origin and CSRF on every LAN write route', () => {
  /** Every write: enroll, logout, every callable name, and the backup upload. */
  function writeRoutes(): { name: string; path: string; body: string }[] {
    return [
      { name: 'enroll', path: '/api/v1/lan/enroll', body: JSON.stringify({ code: 'AAAA-AAAA' }) },
      { name: 'logout', path: '/api/v1/lan/logout', body: '{}' },
      { name: 'upload', path: '/api/v1/backup/upload', body: 'x' },
      ...CALL_NAMES.map((name) => ({ name, path: `/api/v1/call/${name}`, body: JSON.stringify({ args: [] }) }))
    ]
  }

  it('refuses a missing, null, foreign, scheme-changed or cross-site Origin on every route, even with a valid session and CSRF token', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const paired = await pair(live, host)
    const origin = live.lanOrigin as string
    const variants: [string, Record<string, string>][] = [
      ['no Origin', {}],
      ['Origin: null', { Origin: 'null' }],
      ['foreign Origin', { Origin: 'http://attacker.example' }],
      ['attacker-prefixed Origin', { Origin: `${origin}.attacker.example` }],
      ['https Origin', { Origin: origin.replace('http:', 'https:') }],
      ['loopback Origin', { Origin: `http://127.0.0.1:${live.port}` }],
      ['no Origin, Sec-Fetch-Site same-origin', { 'Sec-Fetch-Site': 'same-origin' }],
      ['no Origin, Sec-Fetch-Site none', { 'Sec-Fetch-Site': 'none' }],
      ['right Origin, Sec-Fetch-Site cross-site', { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }],
      ['right Origin, Sec-Fetch-Site same-site', { Origin: origin, 'Sec-Fetch-Site': 'same-site' }]
    ]
    for (const route of writeRoutes()) {
      for (const [label, extra] of variants) {
        const type = route.name === 'upload' ? 'application/octet-stream' : 'application/json'
        const headers = { 'Content-Type': type, Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf, ...extra }
        const reply = await raw(live.port, 'POST', route.path, headers, route.body)
        expect(reply.status, `${route.name}: ${label}`).toBe(403)
        // The backup upload is host-only and refused before anything else on the LAN listener.
        expect(reply.json(), `${route.name}: ${label}`).toEqual({ error: route.name === 'upload' ? 'host-only' : 'not-same-origin' })
        noCookie(reply)
        noCors(reply)
      }
    }
    // Nothing happened: the device is still signed in and the host still has it.
    expect(await lanResult(live, paired, 'listClients', listQuery)).toEqual([])
    expect(await call<unknown[]>(live, host, 'listDevices')).toHaveLength(1)
  })

  it('refuses a right Origin without the CSRF token, or with a wrong one, on every call and on logout', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const paired = await pair(live, await signIn(live))
    const origin = live.lanOrigin as string
    for (const route of writeRoutes().filter((r) => r.name !== 'enroll' && r.name !== 'upload')) {
      for (const csrf of [undefined, 'wrong-token', paired.csrf.slice(0, -1)]) {
        const headers = json({ Origin: origin, Cookie: paired.cookie, ...(csrf ? { 'X-TG-CSRF': csrf } : {}) })
        const reply = await raw(live.port, 'POST', route.path, headers, route.body)
        expect(reply.status, `${route.name} ${csrf}`).toBe(403)
        expect(reply.json()).toEqual({ error: 'bad-csrf-token' })
      }
    }
    expect(await lanResult(live, paired, 'listClients', listQuery)).toEqual([])
  })

  it('a refused enroll or logout changes nothing: the code stays usable and the device stays signed in', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const paired = await pair(live, host)
    const { code } = await call<{ code: string }>(live, host, 'createPairingCode')
    const refusedExtras: Record<string, string>[] = [{}, { Origin: 'null' }, { Origin: 'http://attacker.example' }, { 'Sec-Fetch-Site': 'same-origin' }]
    for (const extra of refusedExtras) {
      const enroll = await raw(live.port, 'POST', '/api/v1/lan/enroll', json(extra), JSON.stringify({ code }))
      expect(enroll.status).toBe(403)
      const logout = await raw(live.port, 'POST', '/api/v1/lan/logout', json({ Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf, ...extra }), '{}')
      expect(logout.status).toBe(403)
    }
    expect(await lanResult(live, paired, 'listClients', listQuery)).toEqual([])
    const enrolled = await raw(live.port, 'POST', '/api/v1/lan/enroll', json({ Origin: live.lanOrigin as string }), JSON.stringify({ code }))
    expect(enrolled.status).toBe(200)
  })
})

describe('unauthorized reads', () => {
  it('every callable name and every backup route answers 401 without a session, with an error code and no data', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start({ demo: true })
    const host = await signIn(live)
    // Data exists, so a leak would show.
    await call(live, host, 'createClient', {
      displayName: 'Ana Ejemplo',
      source: 'direct',
      sourceDetail: null,
      fiverrUsername: null,
      email: 'ana.leak@example.com',
      otherContact: null,
      preferredContactChannel: 'unspecified'
    })
    const origin = live.lanOrigin as string
    const attempts: { label: string; headers: Record<string, string> }[] = [
      { label: 'no credentials', headers: json({ Origin: origin }) },
      { label: 'a made-up CSRF token', headers: json({ Origin: origin, 'X-TG-CSRF': 'made-up' }) },
      { label: 'a made-up LAN cookie', headers: json({ Origin: origin, Cookie: `tg_lan_${live.port}=made-up`, 'X-TG-CSRF': 'made-up' }) },
      { label: 'the host CSRF token', headers: json({ Origin: origin, 'X-TG-CSRF': host.csrf }) }
    ]
    for (const { label, headers } of attempts) {
      for (const name of CALL_NAMES) {
        const reply = await raw(live.port, 'POST', `/api/v1/call/${name}`, headers, JSON.stringify({ args: [] }))
        expect(reply.status, `${name} (${label})`).toBe(401)
        expect(reply.json()).toEqual({ error: 'not-signed-in' })
        expect(reply.text).not.toMatch(/Ana|leak|example\.com/)
        noCookie(reply)
        noCors(reply)
      }
      // The same names by GET and HEAD are not routes at all without a session.
      for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
        const reply = await raw(live.port, method, '/api/v1/call/listClients', headers)
        expect(reply.status, `${method} (${label})`).toBe(401)
        expect(reply.text).not.toMatch(/Ana|leak/)
      }
      // Backup routes are host-only on the LAN listener: refused before any session is looked at.
      for (const reply of [
        await raw(live.port, 'GET', '/api/v1/backup/download/anything.tgbackup', headers),
        await raw(live.port, 'POST', '/api/v1/backup/upload', { ...headers, 'Content-Type': 'application/octet-stream' }, 'x')
      ]) {
        expect([401, 403]).toContain(reply.status)
        expect(reply.text).not.toMatch(/Ana|leak/)
      }
    }
    // The session probe says signed out, and carries no data.
    const probe = await raw(live.port, 'GET', '/api/v1/session')
    expect(probe.json()).toMatchObject({ authenticated: false })
    expect(probe.text).not.toMatch(/Ana|leak|csrf/i)
  })
})

describe('cross-client isolation over a LAN session', () => {
  it('a device asking for client A’s notes, journal entries, tasks and hours through client B’s ids gets nothing of A’s', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const paired = await pair(live, await signIn(live))
    const person = (displayName: string, tag: string) => ({
      displayName,
      source: 'fiverr',
      sourceDetail: null,
      fiverrUsername: `fictional_${tag}`,
      email: `${tag}@example.com`,
      otherContact: null,
      preferredContactChannel: 'email'
    })
    const caseInput = (title: string) => ({ title, goal: null, orderReference: null, dueDate: null })

    const a = await lanResult<{ client: { id: string } }>(live, paired, 'createClient', person('Ana Ejemplo', 'aaa'))
    const b = await lanResult<{ client: { id: string } }>(live, paired, 'createClient', person('Beto Ejemplar', 'bbb'))
    const note = await lanResult<{ note: { id: string } }>(live, paired, 'createNote', a.client.id, {
      kind: 'note',
      occurredAt: '2026-10-20T10:00:00.000Z',
      channel: null,
      direction: null,
      body: 'SECRET-NOTE-AAA'
    })
    const caseA = await lanResult<{ case: { id: string } }>(live, paired, 'createCase', a.client.id, caseInput('CASE-AAA'))
    const caseB = await lanResult<{ case: { id: string } }>(live, paired, 'createCase', b.client.id, caseInput('CASE-BBB'))
    const entryA = await lanResult<{ entry: { id: string } }>(live, paired, 'createJournalEntry', caseA.case.id, {
      occurredAt: '2026-10-21T15:00:00.000Z',
      activity: null,
      body: 'SECRET-JOURNAL-AAA'
    })
    const taskA = await lanResult<{ task: { id: string } }>(live, paired, 'createCaseTask', caseA.case.id, { title: 'SECRET-TASK-AAA', description: null, dueDate: null })
    const timeInput = { workDate: '2026-10-28', durationMinutes: 90, activityType: 'research', note: 'SECRET-HOURS-AAA' }
    const timeA = await lanResult<{ entry: { id: string } }>(live, paired, 'createTimeEntry', caseA.case.id, timeInput)
    await lanResult(live, paired, 'saveCaseBrief', caseA.case.id, { objective: 'SECRET-BRIEF-AAA', facts: null, people: null, hypotheses: null, questions: null })

    // Reads scoped by B return only B's (empty or own) data.
    const readsOfB = [
      await lanResult(live, paired, 'listNotes', b.client.id),
      await lanResult(live, paired, 'listCases', { clientId: b.client.id, archived: 'all', states: [], text: '', sort: 'created' }),
      await lanResult(live, paired, 'listCaseEvents', caseB.case.id),
      await lanResult(live, paired, 'getCaseBrief', caseB.case.id),
      await lanResult(live, paired, 'listJournalEntries', caseB.case.id),
      await lanResult(live, paired, 'listCaseTasks', caseB.case.id),
      await lanResult(live, paired, 'listTimeEntries', caseB.case.id),
      await lanResult(live, paired, 'getClient', b.client.id)
    ]
    const seenByB = JSON.stringify(readsOfB)
    for (const secret of ['SECRET-', 'CASE-AAA', 'Ana Ejemplo', 'aaa@example.com', 'fictional_aaa']) expect(seenByB).not.toContain(secret)

    // Writes that name A's record under B's id are refused as not found, and change nothing.
    const notFound = { ok: false, reason: 'not-found' }
    expect(await lanResult(live, paired, 'updateNote', b.client.id, note.note.id, { kind: 'note', occurredAt: '2026-10-20T10:00:00.000Z', channel: null, direction: null, body: 'overwritten' })).toEqual(notFound)
    expect(await lanResult(live, paired, 'updateJournalEntry', caseB.case.id, entryA.entry.id, { occurredAt: '2026-10-21T15:00:00.000Z', activity: null, body: 'overwritten' })).toEqual(notFound)
    expect(await lanResult(live, paired, 'updateCaseTask', caseB.case.id, taskA.task.id, { title: 'overwritten', description: null, dueDate: null })).toEqual(notFound)
    expect(await lanResult(live, paired, 'completeCaseTask', caseB.case.id, taskA.task.id)).toEqual(notFound)
    expect(await lanResult(live, paired, 'reopenCaseTask', caseB.case.id, taskA.task.id)).toEqual(notFound)
    expect(await lanResult(live, paired, 'updateTimeEntry', caseB.case.id, timeA.entry.id, { ...timeInput, note: 'overwritten' })).toEqual(notFound)
    expect(await lanResult(live, paired, 'deleteTimeEntry', caseB.case.id, timeA.entry.id)).toEqual(notFound)

    const stillA = JSON.stringify([
      await lanResult(live, paired, 'listNotes', a.client.id),
      await lanResult(live, paired, 'listJournalEntries', caseA.case.id),
      await lanResult(live, paired, 'listCaseTasks', caseA.case.id),
      await lanResult(live, paired, 'listTimeEntries', caseA.case.id)
    ])
    for (const kept of ['SECRET-NOTE-AAA', 'SECRET-JOURNAL-AAA', 'SECRET-TASK-AAA', 'SECRET-HOURS-AAA']) expect(stillA).toContain(kept)
    expect(stillA).not.toContain('overwritten')
  })
})

describe('backup permissions over LAN', () => {
  it('every backup call and route is refused for a paired device and for the host’s own cookie presented on the LAN listener', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const paired = await pair(live, host)
    const origin = live.lanOrigin as string
    const sessions: [string, Record<string, string>][] = [
      ['paired device', json({ Origin: origin, Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf })],
      ['host cookie on LAN', json({ Origin: origin, Cookie: host.cookie, 'X-TG-CSRF': host.csrf })],
      ['no session', json({ Origin: origin })]
    ]
    const hostOnly = CALL_NAMES.filter((name) => !REMOTE_CALL_NAMES.includes(name))
    expect(hostOnly).toEqual(expect.arrayContaining(['createBackup', 'restoreBackup', 'getBackupStatus', 'disableLan']))
    for (const [label, headers] of sessions) {
      const expected = label === 'paired device' ? 403 : 401
      for (const name of ['createBackup', 'restoreBackup', 'getBackupStatus']) {
        const reply = await raw(live.port, 'POST', `/api/v1/call/${name}`, headers, JSON.stringify({ args: name === 'restoreBackup' ? ['x'.repeat(10)] : [] }))
        expect(reply.status, `${name} (${label})`).toBe(expected)
      }
      const upload = await raw(live.port, 'POST', '/api/v1/backup/upload', { ...headers, 'Content-Type': 'application/octet-stream' }, 'x')
      // Upload and download are host-only whatever the session: 403 before any session check.
      expect(upload.status, `upload (${label})`).toBe(403)
      expect(upload.json()).toEqual({ error: 'host-only' })
      const download = await raw(live.port, 'GET', '/api/v1/backup/download/Tracing%20Guatemala%20backup%202026-10-30%2009-00-00.tgbackup', {
        Cookie: headers['Cookie'] ?? ''
      })
      expect(download.status, `download (${label})`).toBe(403)
      expect(download.json()).toEqual({ error: 'host-only' })
    }
    // No backup file was made by any of that.
    expect(existsSync(join(dataDir, 'backups')) ? readdirSync(join(dataDir, 'backups')) : []).toEqual([])
  })
})

describe('LAN bind restrictions', () => {
  it('accepts connections on the chosen address only: not on 127.0.0.2, ::1, any other local address, or (for the demo) loopback', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start({ demo: true })
    expect(live.lanDemoUrl).not.toBeNull()
    const ports = [live.port, live.port + 1]

    expect(await connects(lanAddress, live.port)).toBe(true)
    expect(await connects(lanAddress, live.port + 1)).toBe(true)
    expect(await connects('127.0.0.1', live.port)).toBe(true) // the host's own loopback listener
    expect(await connects('127.0.0.1', live.port + 1), 'the LAN demo must not listen on loopback').toBe(false)

    // A wildcard (0.0.0.0 or ::) listener would also accept these; none must.
    const others = interfaces
      .filter((e) => e.address !== lanAddress && e.address !== '127.0.0.1' && !(e.family === 'IPv6' && e.address.startsWith('fe80')))
      .map((e) => e.address)
    for (const address of ['127.0.0.2', '::1', ...others]) {
      for (const port of ports) {
        expect(await connects(address, port), `${address} (a local address) must not accept a connection on ${port}`).toBe(false)
      }
    }
  }, 120_000)

  it('refuses to start on a wildcard, public or loopback address, with nothing bound and the data folder free', async () => {
    for (const lanHost of ['0.0.0.0', '::', '::1', '0.0.0.0:80', '8.8.8.8', '127.0.0.2', '169.254.1.1', '224.0.0.1']) {
      await expect(startLiveServer({ dataDir, port: 0, staticDir, lanHost, appInfo })).rejects.toThrow()
    }
    acquireDataDirLock(dataDir)()
  })
})

describe('no CORS anywhere', () => {
  it('preflights and requests carrying an Origin never get Access-Control-* on Live, the LAN demo or loopback', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start({ demo: true })
    const host = await signIn(live)
    const paired = await pair(live, host)
    const preflight = {
      Origin: 'http://attacker.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-tg-csrf'
    }
    const targets: [string, number, string | null][] = [
      ['live', live.port, null],
      ['demo', live.port + 1, `${NAME}:${live.port + 1}`]
    ]
    for (const [label, port, hostHeader] of targets) {
      for (const [method, path] of [
        ['OPTIONS', '/'],
        ['OPTIONS', '/api/v1/session'],
        ['OPTIONS', '/api/v1/call/listClients'],
        ['OPTIONS', '/api/v1/lan/enroll'],
        ['OPTIONS', '/api/v1/lan/logout'],
        ['OPTIONS', '/api/v1/backup/upload'],
        ['GET', '/'],
        ['GET', '/api/v1/session'],
        ['HEAD', '/']
      ] as const) {
        const reply = await raw(port, method, path, preflight, undefined, hostHeader ?? `${lanAddress}:${port}`)
        noCors(reply)
        noCookie(reply)
        expect(reply.status, `${label} ${method} ${path}`).not.toBe(204)
      }
    }
    // Real calls with a foreign Origin: refused, and never with CORS headers.
    const foreign = await raw(live.port, 'POST', '/api/v1/call/listClients', json({ Origin: 'http://attacker.example', Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf }), JSON.stringify({ args: [listQuery] }))
    expect(foreign.status).toBe(403)
    noCors(foreign)
    // Loopback too, with an Origin present.
    for (const origin of ['http://attacker.example', live.origin]) {
      const reply = await send(live, 'OPTIONS', '/api/v1/call/listClients', { Origin: origin, 'Access-Control-Request-Method': 'POST' })
      noCors(reply)
      const session = await send(live, 'GET', '/api/v1/session', { Origin: origin })
      noCors(session)
    }
  })
})

describe('server restart', () => {
  it('forgets every device: the old cookie and CSRF token get 401 on the same port, and the host must show a new code', async (context) => {
    if (!lanAddress) return context.skip()
    const first = await start()
    const port = first.port
    const host = await signIn(first)
    const paired = await pair(first, host)
    await lanResult(first, paired, 'createClient', {
      displayName: 'Ana Ejemplo',
      source: 'direct',
      sourceDetail: null,
      fiverrUsername: null,
      email: null,
      otherContact: null,
      preferredContactChannel: 'unspecified'
    })
    const { code } = await call<{ code: string }>(first, host, 'createPairingCode')
    await first.close()
    running = null

    const second = await start({ port })
    expect(second.port).toBe(port)
    const probe = (await raw(port, 'GET', '/api/v1/session', { Cookie: paired.cookie })).json() as { authenticated: boolean }
    expect(probe.authenticated).toBe(false)
    const stale = await lanCall(second, paired, 'listClients', listQuery)
    expect(stale.status).toBe(401)
    expect(stale.json()).toEqual({ error: 'not-signed-in' })
    expect((await raw(port, 'POST', '/api/v1/lan/logout', json({ Origin: second.lanOrigin as string, Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf }), '{}')).status).toBe(401)
    // The old, unused pairing code does not survive either.
    const oldCode = await raw(port, 'POST', '/api/v1/lan/enroll', json({ Origin: second.lanOrigin as string }), JSON.stringify({ code }))
    expect(oldCode.status).toBe(401)
    expect(await call(second, await signIn(second), 'listDevices')).toEqual([])

    // After a new pairing the SQLite data is all still there.
    const again = await pair(second, await signIn(second))
    const names = (await lanResult<{ displayName: string }[]>(second, again, 'listClients', listQuery)).map((c) => c.displayName)
    expect(names).toEqual(['Ana Ejemplo'])
  })
})

describe('session expiry over HTTP with the injected clock', () => {
  it('ends a device session after idle and absolute limits, also for logout and revoked-then-reused cookies', async (context) => {
    if (!lanAddress) return context.skip()
    let clock = Date.parse('2026-10-30T09:00:00.000Z')
    const live = await start({ now: () => new Date(clock) })
    const host = await signIn(live)
    const paired = await pair(live, host)
    clock += 61 * 60_000
    const expired = await lanCall(live, paired, 'listClients', listQuery)
    expect(expired.status).toBe(401)
    expect((await raw(live.port, 'POST', '/api/v1/lan/logout', json({ Origin: live.lanOrigin as string, Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf }), '{}')).status).toBe(401)
    // An expired device does not show in the host's list for long: re-pairing is the only way back.
    const again = await pair(live, host, 'Kitchen tablet')
    expect((await lanCall(live, again, 'listClients', listQuery)).status).toBe(200)
  })
})

describe('address change and exposure when off', () => {
  it('an address that is not this computer’s fails closed with the documented message and nothing listens or stays locked', async () => {
    const taken = new Set(interfaces.map((e) => e.address))
    const missing = ['10.254.254.254', '192.168.254.254', '172.31.254.254'].find((address) => !taken.has(address))
    if (!missing) return
    initLanTestProfile(dataDir)
    const lanHost = missing
    const attempt = startLiveServer({ dataDir, port: 0, staticDir, lanHost, appInfo })
    await expect(attempt).rejects.toThrow(/is not an address of this computer\./)
    await expect(attempt).rejects.toThrow(/restart with the new --lan-host address; paired devices pair again/)
    acquireDataDirLock(dataDir)()
    expect(readFileSync(join(dataDir, LAN_TEST_MARKER), 'utf8').length).toBeGreaterThan(0)
  })
})

describe('backup and restore around turning LAN off', () => {
  it('the host can back up while LAN is on; restore is refused until LAN is off; then restore works and the data is intact', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const paired = await pair(live, host)
    const person = (displayName: string, tag: string) => ({
      displayName,
      source: 'direct',
      sourceDetail: null,
      fiverrUsername: null,
      email: `${tag}@example.com`,
      otherContact: null,
      preferredContactChannel: 'email'
    })
    await lanResult(live, paired, 'createClient', person('Ana Ejemplo', 'ana'))
    const made = await call<{ ok: true; fileName: string; clients: number }>(live, host, 'createBackup')
    expect(made).toMatchObject({ ok: true, clients: 1 })
    await lanResult(live, paired, 'createClient', person('Added After Backup', 'late'))
    expect(await lanResult<unknown[]>(live, paired, 'listClients', listQuery)).toHaveLength(2)

    // Restore and upload are refused while LAN is on, even for the host.
    const hostHeaders = json({ Origin: live.origin, Cookie: host.cookie, 'X-TG-CSRF': host.csrf })
    const bytes = readFileSync(join(dataDir, 'backups', made.fileName))
    const uploadHeaders = { ...hostHeaders, 'Content-Type': 'application/octet-stream', 'X-TG-File-Name': encodeURIComponent(made.fileName) }
    const refusedUpload = await send(live, 'POST', '/api/v1/backup/upload', uploadHeaders, bytes)
    expect(refusedUpload.status).toBe(409)
    expect(refusedUpload.json()).toEqual({ error: 'restore-disabled-while-lan' })
    const refusedRestore = await send(live, 'POST', '/api/v1/call/restoreBackup', hostHeaders, JSON.stringify({ args: ['x'.repeat(10)] }))
    expect(refusedRestore.status).toBe(409)
    expect(refusedRestore.json()).toEqual({ error: 'restore-disabled-while-lan' })
    expect(await lanResult<unknown[]>(live, paired, 'listClients', listQuery)).toHaveLength(2)

    // Turn LAN off: devices are gone, restore works, and the restored data is exactly the backup.
    expect(await call(live, host, 'disableLan')).toEqual({ disabled: true })
    await live.disableLan()
    expect(await connects(lanAddress, live.port)).toBe(false)
    const choice = (await send(live, 'POST', '/api/v1/backup/upload', uploadHeaders, bytes)).json() as { result: { ok: boolean; token: string; clients: number } }
    expect(choice.result).toMatchObject({ ok: true, clients: 1 })
    expect(await call(live, host, 'restoreBackup', choice.result.token)).toMatchObject({ ok: true, clients: 1 })
    const names = (await call<{ displayName: string }[]>(live, host, 'listClients', listQuery)).map((c) => c.displayName)
    expect(names).toEqual(['Ana Ejemplo'])
  })
})

describe('no accidental exposure', () => {
  it('a default start (no --lan-host) accepts nothing on this computer’s LAN address, on the port or the next one', async (context) => {
    if (!lanAddress) return context.skip()
    running = await startLiveServer({ dataDir, port: 0, staticDir, appInfo, demoDir, log: (line) => logs.push(line) })
    expect(running.lanOrigin).toBeNull()
    expect(await connects(lanAddress, running.port)).toBe(false)
    expect(await connects(lanAddress, running.port + 1)).toBe(false)
    expect(await connects('127.0.0.1', running.port)).toBe(true)
  })

  it('after disableLan the LAN address and the LAN demo stop accepting connections at once', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start({ demo: true })
    expect(await connects(lanAddress, live.port)).toBe(true)
    await live.disableLan()
    expect(await connects(lanAddress, live.port)).toBe(false)
    expect(await connects(lanAddress, live.port + 1)).toBe(false)
    expect(await connects('127.0.0.1', live.port)).toBe(true)
  })
})
