import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeIdentityProvider } from '../../src/server/auth/fake-provider'
import type { VerifiedIdentity } from '../../src/server/auth/identity'
import { startDemoMirror, type RunningDemoMirror } from '../../src/server/demo-mirror'
import { initLanTestProfile, LAN_TEST_MARKER } from '../../src/server/lan-profile'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { NoteBlock, NoteContent } from '../../src/shared/note-content'
import type { SignInRequest, AppUser, UserMutationResult } from '../../src/shared/users'
import { call, send, signIn, type Reply, type Signed } from './live-helpers'

// #182: identity bypass attempts and, since #210, the separate workspaces of two signed-in people.
// Google mode uses the deterministic fake identity provider (no Google, no network).
// Fictional people only.

const appInfo = { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' } as const
const NAME = 'tg.example.com'
const ORIGIN = `https://${NAME}`
const SESSION = '__Host-tg_session'
const LOGIN = '__Host-tg_login'
const listQuery = { text: '', status: 'all', sources: [], sort: 'name' }
const clientInput = (displayName: string) => ({
  displayName,
  source: 'direct',
  sourceDetail: null,
  fiverrUsername: null,
  email: null,
  otherContact: null,
  preferredContactChannel: 'unspecified'
})
const caseInput = { title: 'Maternal grandparents', goal: null, orderReference: null, dueDate: null }
const everything = { clientId: null, archived: 'all', states: [], text: '', sort: 'created' }

const person = (subject: string, email: string, name: string): VerifiedIdentity => ({
  provider: 'google',
  subject,
  email,
  emailVerified: true,
  emailAuthoritative: true,
  name
})
const PEOPLE = {
  'code-ana': person('sub-ana', 'ana@example.test', 'Ana Fictional'),
  'code-ben': person('sub-ben', 'ben@example.test', 'Ben Fictional')
}
type Code = keyof typeof PEOPLE

const privateAddresses = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .filter((e) => e.family === 'IPv4' && !e.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(e.address))
  .map((e) => e.address)
const lanAddress = privateAddresses.find((address) => privateAddresses.filter((a) => a === address).length === 1)

let root: string
let staticDir: string
let servers: RunningLiveServer[]
let mirrors: RunningDemoMirror[]
let counter: number

function dirFor(label: string): string {
  const dir = join(root, `${label}-${counter++}`)
  initLanTestProfile(dir)
  return dir
}

/** Port 0 picks the Live port; port + 2 may be taken, so retry a few times. */
async function start(dataDir: string, extra: { google?: boolean; lanHost?: string | null; httpsHost?: string }): Promise<RunningLiveServer> {
  if (!existsSync(join(dataDir, LAN_TEST_MARKER))) initLanTestProfile(dataDir)
  let last: unknown
  for (let i = 0; i < 8; i++) {
    try {
      const live = await startLiveServer({
        dataDir,
        port: 0,
        staticDir,
        appInfo,
        ...(extra.httpsHost !== undefined ? { httpsHost: extra.httpsHost } : {}),
        ...(extra.lanHost !== undefined ? { lanHost: extra.lanHost } : {}),
        ...(extra.google ? { identity: createFakeIdentityProvider({ identities: PEOPLE }) } : {}),
        log: () => undefined
      })
      servers.push(live)
      return live
    } catch (error) {
      last = error
      if (!(error instanceof Error) || !error.message.startsWith('Port ')) throw error
    }
  }
  throw last
}

function raw(host: string, port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, method, path, agent: false, setHost: false, headers }, (res) => {
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

const viaProxy = (live: RunningLiveServer, method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
  raw('127.0.0.1', live.port + 2, method, path, { Host: NAME, ...headers }, body)
const viaLan = (live: RunningLiveServer, method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
  raw(lanAddress!, live.port, method, path, { Host: `${lanAddress}:${live.port}`, ...headers }, body)

const json = (headers: Record<string, string> = {}) => ({ 'Content-Type': 'application/json', ...headers })
const setCookies = (reply: Reply): string[] => (reply.headers['set-cookie'] as string[] | undefined) ?? []
const cookieOf = (reply: Reply, name: string): string | null => {
  const found = setCookies(reply).find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))
  return found ? found.split(';')[0]! : null
}
const nav = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }
const cb = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }

/** A whole sign-in through the fake provider; returns the session cookie and CSRF token. */
async function attempt(live: RunningLiveServer, code: Code): Promise<Signed> {
  const started = await viaProxy(live, 'GET', '/api/v1/auth/google/start', nav)
  expect(started.status, started.text).toBe(303)
  const callback = await viaProxy(live, 'GET', `/api/v1/auth/google/callback?code=${code}&state=s`, { Cookie: cookieOf(started, LOGIN)!, ...cb })
  expect(callback.status, callback.text).toBe(303)
  expect(callback.headers['location']).toBe('/')
  const cookie = cookieOf(callback, SESSION)
  expect(cookie).not.toBeNull()
  const probe = (await viaProxy(live, 'GET', '/api/v1/session', { Cookie: cookie! })).json() as { authenticated: boolean; csrfToken: string }
  expect(probe.authenticated).toBe(true)
  return { cookie: cookie!, csrf: probe.csrfToken }
}

const pcall = (live: RunningLiveServer, who: Signed, name: string, ...args: unknown[]) =>
  viaProxy(live, 'POST', `/api/v1/call/${name}`, json({ Origin: ORIGIN, Cookie: who.cookie, 'X-TG-CSRF': who.csrf }), JSON.stringify({ args }))
const result = <T>(reply: Reply): T => {
  expect(reply.status, reply.text).toBe(200)
  return (reply.json() as { result: T }).result
}

/** Owner Ana and researcher Ben, approved by the host and signed in. */
async function googleWorld(label: string) {
  const dataDir = dirFor(label)
  const live = await start(dataDir, { google: true, httpsHost: NAME })
  const host = await signIn(live)
  const ids: Record<string, string> = {}
  for (const [code, displayName, role] of [['code-ana', 'Ana Fictional', 'owner'], ['code-ben', 'Ben Fictional', 'researcher']] as const) {
    const started = await viaProxy(live, 'GET', '/api/v1/auth/google/start', nav)
    const denied = await viaProxy(live, 'GET', `/api/v1/auth/google/callback?code=${code}&state=s`, { Cookie: cookieOf(started, LOGIN)!, ...cb })
    expect(denied.headers['location']).toBe('/?signin=not-approved')
    const requests = await call<SignInRequest[]>(live, host, 'listSignInRequests')
    const req = requests.find((r) => r.email === PEOPLE[code].email)!
    const approved = await call<UserMutationResult>(live, host, 'approveSignInRequest', req.id, { displayName, role })
    if (!approved.ok) throw new Error('approve failed')
    ids[code] = approved.user.id
  }
  const ana = { ...(await attempt(live, 'code-ana')), id: ids['code-ana']! }
  const ben = { ...(await attempt(live, 'code-ben')), id: ids['code-ben']! }
  return { live, dataDir, host, ana, ben }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-identity-bypass-'))
  staticDir = join(root, 'client')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  servers = []
  mirrors = []
  counter = 0
})

afterEach(async () => {
  for (const m of mirrors) await m.close()
  for (const s of servers) await s.close()
  rmSync(root, { recursive: true, force: true })
})

const listBody = JSON.stringify({ args: [listQuery] })

describe('a Google session opens nothing elsewhere', () => {
  it('is not accepted on the same server loopback listener, and the launch-link session is not accepted on HTTPS', async () => {
    const { live, host, ben } = await googleWorld('same')
    const probe = (await send(live, 'GET', '/api/v1/session', { Cookie: ben.cookie })).json() as { authenticated: boolean }
    expect(probe.authenticated).toBe(false)
    const data = await send(live, 'POST', '/api/v1/call/listClients', json({ Origin: live.origin, Cookie: ben.cookie, 'X-TG-CSRF': ben.csrf }), listBody)
    expect(data.status).toBe(401)
    // The reverse direction: the launch-link session on the HTTPS listener.
    expect((await pcall(live, host, 'listClients', listQuery)).status).toBe(401)
    const hostProbe = (await viaProxy(live, 'GET', '/api/v1/session', { Cookie: host.cookie })).json() as { authenticated: boolean }
    expect(hostProbe.authenticated).toBe(false)
  })

  it('is not accepted by a pairing-mode HTTPS server, which has no Google routes', async () => {
    const { ben } = await googleWorld('google')
    const pairing = await start(dirFor('pairing'), { httpsHost: NAME })
    for (const [method, path] of [['GET', '/api/v1/auth/google/start'], ['GET', '/api/v1/auth/google/callback?code=code-ben&state=s'], ['POST', '/api/v1/auth/logout']] as const) {
      const reply = await viaProxy(pairing, method, path, json({ ...nav, Origin: ORIGIN, Cookie: ben.cookie, 'X-TG-CSRF': ben.csrf }), method === 'POST' ? '{}' : undefined)
      expect(reply.status, path).toBeGreaterThanOrEqual(400)
      expect(reply.status, path).toBeLessThan(500)
      expect(setCookies(reply), path).toEqual([])
    }
    expect((await pcall(pairing, ben, 'listClients', listQuery)).status).toBe(401)
    const probe = (await viaProxy(pairing, 'GET', '/api/v1/session', { Cookie: ben.cookie })).json() as { authenticated: boolean }
    expect(probe.authenticated).toBe(false)
  })

  it('is not accepted by an HTTP --lan-host server, which has no Google routes', async (context) => {
    if (!lanAddress) return context.skip()
    const { ben } = await googleWorld('google')
    const lan = await start(dirFor('lan'), { lanHost: lanAddress })
    const origin = `http://${lanAddress}:${lan.port}`
    for (const [method, path] of [['GET', '/api/v1/auth/google/start'], ['GET', '/api/v1/auth/google/callback?code=code-ben&state=s'], ['POST', '/api/v1/auth/logout']] as const) {
      const reply = await viaLan(lan, method, path, json({ ...nav, Origin: origin, Cookie: ben.cookie, 'X-TG-CSRF': ben.csrf }), method === 'POST' ? '{}' : undefined)
      expect(reply.status, path).toBeGreaterThanOrEqual(400)
      expect(setCookies(reply), path).toEqual([])
    }
    const data = await viaLan(lan, 'POST', '/api/v1/call/listClients', json({ Origin: origin, Cookie: ben.cookie, 'X-TG-CSRF': ben.csrf }), listBody)
    expect(data.status).toBe(401)
  })

  it('never reaches the demo mirror', async () => {
    const { ben } = await googleWorld('google')
    const demoDir = join(root, 'dist-demo')
    mkdirSync(demoDir, { recursive: true })
    writeFileSync(join(demoDir, 'index.html'), '<!doctype html><title>Demo</title>')
    const mirror = await startDemoMirror({ port: 0, demoDir, log: () => undefined })
    if (!mirror) throw new Error('the mirror did not start')
    mirrors.push(mirror)
    for (const path of ['/api/v1/auth/google/start', '/api/v1/session']) {
      const reply = await raw('127.0.0.1', mirror.port, 'GET', path, { Host: `localhost:${mirror.port}`, Cookie: ben.cookie, ...nav })
      expect(reply.status, path).toBeGreaterThanOrEqual(400)
      expect(reply.headers['location'], path).toBeUndefined()
      expect(setCookies(reply), path).toEqual([])
    }
  })

  it('belongs to one host process: another Google-mode server with the same people says 401', async () => {
    const a = await googleWorld('a')
    const b = await googleWorld('b')
    expect((await pcall(a.live, a.ben, 'listClients', listQuery)).status).toBe(200)
    const reply = await pcall(b.live, a.ben, 'listClients', listQuery)
    expect(reply.status).toBe(401)
    expect(setCookies(reply)).toEqual([])
    const probe = (await viaProxy(b.live, 'GET', '/api/v1/session', { Cookie: a.ben.cookie })).json() as { authenticated: boolean }
    expect(probe.authenticated).toBe(false)
  })
})

describe('two identities have separate workspaces', () => {
  const blockId = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const paragraph = (text: string): NoteBlock => ({ id: blockId(1), type: 'paragraph', indent: 0, content: [{ text }] })
  const doc = (...blocks: NoteBlock[]): NoteContent => ({ format: 'tg-note', version: 1, blocks })
  type Created = { ok: true; client: { id: string; displayName: string } }

  // #210 replaces the Phase 2.7 shared workspace recorded by #182: records are private to their owner.
  // The full per-call deny matrix lives in live-authorization.test.ts; this keeps the identity-focused cases.
  it('shows each person only their own clients and cases and refuses another person’s ids', async () => {
    const { live, ana, ben } = await googleWorld('private')
    const made = result<Created>(await pcall(live, ana, 'createClient', clientInput('Cliente Uno')))
    expect(result<{ id: string }[]>(await pcall(live, ben, 'listClients', listQuery))).toEqual([])
    expect(result(await pcall(live, ben, 'getClient', made.client.id))).toBeNull()
    expect(result(await pcall(live, ben, 'createCase', made.client.id, caseInput))).toEqual({ ok: false, reason: 'not-found' })
    expect(result(await pcall(live, ben, 'updateClient', made.client.id, clientInput('Cliente Editado')))).toEqual({ ok: false, reason: 'not-found' })
    // Ana still has her client, unchanged, and can work on it.
    expect(result<{ displayName: string }>(await pcall(live, ana, 'getClient', made.client.id)).displayName).toBe('Cliente Uno')
    expect(result<{ ok: boolean }>(await pcall(live, ana, 'createCase', made.client.id, caseInput)).ok).toBe(true)
    expect(result<{ id: string }[]>(await pcall(live, ana, 'listCases', everything))).toHaveLength(1)
    expect(result<{ id: string }[]>(await pcall(live, ben, 'listCases', everything))).toEqual([])
  })

  it('lets only the owner edit a client, so two people never overwrite each other', async () => {
    const { live, ana, ben } = await googleWorld('lww')
    const made = result<Created>(await pcall(live, ana, 'createClient', clientInput('Cliente Uno')))
    expect(result<{ ok: boolean }>(await pcall(live, ana, 'updateClient', made.client.id, clientInput('Version de Ana'))).ok).toBe(true)
    expect(result(await pcall(live, ben, 'updateClient', made.client.id, clientInput('Version de Ben')))).toEqual({ ok: false, reason: 'not-found' })
    // Two edits sent at the same moment: only the owner's one is accepted.
    const [r1, r2] = await Promise.all([
      pcall(live, ana, 'updateClient', made.client.id, clientInput('Ana a la vez')),
      pcall(live, ben, 'updateClient', made.client.id, clientInput('Ben a la vez'))
    ])
    expect(result<{ ok: boolean }>(r1).ok).toBe(true)
    expect(result(r2)).toEqual({ ok: false, reason: 'not-found' })
    expect(result<{ displayName: string }>(await pcall(live, ana, 'getClient', made.client.id)).displayName).toBe('Ana a la vez')
  })

  it('refuses a notebook save by the other person and leaves the page as the owner wrote it', async () => {
    const { live, ana, ben } = await googleWorld('notebook')
    const made = result<Created>(await pcall(live, ana, 'createClient', clientInput('Cliente Uno')))
    const caseId = result<{ ok: true; case: { id: string } }>(await pcall(live, ana, 'createCase', made.client.id, caseInput)).case.id
    const section = result<{ ok: true; section: { id: string } }>(await pcall(live, ana, 'createNotebookSection', caseId, { title: 'Archive visits' }))
    const page = result<{ ok: true; page: { id: string } }>(await pcall(live, ana, 'createNotebookPage', caseId, section.section.id, { title: 'First visit' }))
    const pageId = page.page.id
    expect(result<{ ok: boolean }>(await pcall(live, ana, 'saveNotebookPage', caseId, pageId, { baseVersion: 1, content: doc(paragraph('Ana wrote this')) })).ok).toBe(true)
    // The other person gets the answer for a page that does not exist, not a version conflict that would reveal it.
    expect(result(await pcall(live, ben, 'saveNotebookPage', caseId, pageId, { baseVersion: 1, content: doc(paragraph('Ben wrote this')) }))).toEqual({ ok: false, reason: 'not-found' })
    expect(result(await pcall(live, ben, 'getNotebookPage', caseId, pageId))).toBeNull()
    expect(result<{ version: number }>(await pcall(live, ana, 'getNotebookPage', caseId, pageId)).version).toBe(2)
  })

  it('keeps the running timer to its owner: the other person sees none and is only told the timer is busy', async () => {
    const { live, ana, ben } = await googleWorld('timer')
    const made = result<Created>(await pcall(live, ana, 'createClient', clientInput('Cliente Uno')))
    const c1 = result<{ ok: true; case: { id: string } }>(await pcall(live, ana, 'createCase', made.client.id, caseInput)).case.id
    const benClient = result<Created>(await pcall(live, ben, 'createClient', clientInput('Cliente Dos')))
    const benCase = result<{ ok: true; case: { id: string } }>(await pcall(live, ben, 'createCase', benClient.client.id, { ...caseInput, title: 'Paternal side' })).case.id
    expect(result(await pcall(live, ben, 'getActiveTimer'))).toBeNull()
    const started = result<{ ok: true; timer: { caseId: string; version: number } }>(await pcall(live, ana, 'startTimer', c1))
    // Known limitation (one global timer): the other person learns only that a timer is busy, never whose or where.
    expect(result(await pcall(live, ben, 'getActiveTimer'))).toBeNull()
    expect(result(await pcall(live, ben, 'startTimer', benCase))).toEqual({ ok: false, reason: 'conflict', timer: null })
    expect(result(await pcall(live, ben, 'discardTimer', started.timer.version))).toEqual({ ok: false, reason: 'not-found' })
    expect(result<{ caseId: string } | null>(await pcall(live, ana, 'getActiveTimer'))).toMatchObject({ caseId: c1 })
  })
})

describe('a privilege change in the middle of a session', () => {
  it('ends the old session after each change and records the owner as the actor', async () => {
    const { live, dataDir, ana, ben } = await googleWorld('privilege')
    const find = async () => result<AppUser[]>(await pcall(live, ana, 'listUsers')).find((u) => u.id === ben.id)!
    expect((await pcall(live, ben, 'listClients', listQuery)).status).toBe(200)

    let user = await find()
    expect(result<UserMutationResult>(await pcall(live, ana, 'setUserRole', user.id, 'owner', user.version))).toMatchObject({ ok: true })
    // Recorded behaviour (#182): the moment a role changes, the person's existing session gets 401 (not 200 with the old or new role); they must sign in again.
    const afterPromote = await pcall(live, ben, 'listClients', listQuery)
    expect(afterPromote.status).toBe(401)
    expect(afterPromote.json()).toEqual({ error: 'not-signed-in' })
    const promoted = await attempt(live, 'code-ben')
    expect((await pcall(live, promoted, 'listUsers')).status).toBe(200)

    user = await find()
    expect(result<UserMutationResult>(await pcall(live, ana, 'setUserRole', user.id, 'researcher', user.version))).toMatchObject({ ok: true })
    expect((await pcall(live, promoted, 'listUsers')).status).toBe(401)
    expect((await pcall(live, promoted, 'listClients', listQuery)).status).toBe(401)
    const demoted = await attempt(live, 'code-ben')
    expect((await pcall(live, demoted, 'listUsers')).status).toBe(403)

    await live.close()
    const db = new DatabaseSync(join(dataDir, 'data', 'tracing-guatemala.sqlite'), { readOnly: true })
    const events = db.prepare("SELECT actor FROM user_events WHERE action = 'role-changed' AND user_id = ? ORDER BY rowid").all(ben.id) as { actor: string }[]
    db.close()
    // Recorded behaviour (#182): each role change is logged with the acting owner's id as the actor, never the affected person.
    expect(events).toEqual([{ actor: ana.id }, { actor: ana.id }])
  })
})
