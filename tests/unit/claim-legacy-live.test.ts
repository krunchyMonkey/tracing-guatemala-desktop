import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppData } from '../../src/main/database/app-data'
import { createFakeIdentityProvider } from '../../src/server/auth/fake-provider'
import type { VerifiedIdentity } from '../../src/server/auth/identity'
import { LAN_TEST_MARKER } from '../../src/server/lan-profile'
import { applyClaim, planClaim } from '../../src/server/maintenance/claim-legacy'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { AppUser } from '../../src/shared/users'
import { buildLegacyProfile, LEGACY, migrateLegacyProfileForTest } from './helpers/legacy-fixture'
import { activeUser } from './helpers/ownership-helpers'
import type { Reply, Signed } from './live-helpers'

// #245: after the offline claim, the claimed Owner reads the client through the real Live host
// (Google mode, fake provider, no network) and another Owner cannot. Fictional data only.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const appInfo = { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' } as const
const NAME = 'tg.example.com'
const ORIGIN = `https://${NAME}`
const SESSION = '__Host-tg_session'
const LOGIN = '__Host-tg_login'
const nav = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }
const cb = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }
const identityOf = (key: 'a' | 'b'): VerifiedIdentity => ({
  provider: 'google',
  subject: `sub-${key}`,
  email: `sub-${key}@example.test`,
  emailVerified: true,
  emailAuthoritative: false,
  name: `Person ${key.toUpperCase()}`
})
const PEOPLE = { 'code-a': identityOf('a'), 'code-b': identityOf('b') }
const listQuery = { text: '', status: 'all', sources: [], sort: 'name' }

let root: string
let staticDir: string
let running: RunningLiveServer | null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-claim-live-'))
  staticDir = join(root, 'client')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  running = null
})
afterEach(async () => {
  await running?.close()
  rmSync(root, { recursive: true, force: true })
})

function viaProxy(live: RunningLiveServer, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: live.port + 2, method, path, agent: false, setHost: false, headers: { Host: NAME, ...headers } }, (res) => {
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

const cookieOf = (reply: Reply, name: string): string | null => {
  const cookies = (reply.headers['set-cookie'] as string[] | undefined) ?? []
  const found = cookies.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))
  return found ? found.split(';')[0]! : null
}

async function startServer(): Promise<RunningLiveServer> {
  let last: unknown
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      running = await startLiveServer({
        dataDir: root,
        port: 0,
        staticDir,
        appInfo,
        httpsHost: NAME,
        identity: createFakeIdentityProvider({ identities: PEOPLE }),
        log: () => undefined
      })
      return running
    } catch (error) {
      last = error
      if (!(error instanceof Error) || !error.message.startsWith('Port ')) throw error
    }
  }
  throw last
}

async function signInAs(live: RunningLiveServer, key: 'a' | 'b'): Promise<Signed> {
  const started = await viaProxy(live, 'GET', '/api/v1/auth/google/start', nav)
  expect(started.status, started.text).toBe(303)
  const callback = await viaProxy(live, 'GET', `/api/v1/auth/google/callback?code=code-${key}&state=s`, { Cookie: cookieOf(started, LOGIN)!, ...cb })
  expect(callback.status, callback.text).toBe(303)
  const cookie = cookieOf(callback, SESSION)
  expect(cookie).not.toBeNull()
  const probe = (await viaProxy(live, 'GET', '/api/v1/session', { Cookie: cookie! })).json() as { csrfToken: string }
  return { cookie: cookie!, csrf: probe.csrfToken }
}

const pcall = (live: RunningLiveServer, who: Signed, name: string, ...args: unknown[]) =>
  viaProxy(live, 'POST', `/api/v1/call/${name}`, { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: who.cookie, 'X-TG-CSRF': who.csrf }, JSON.stringify({ args }))

const result = <T>(reply: Reply): T => {
  expect(reply.status, reply.text).toBe(200)
  return (reply.json() as { result: T }).result
}

describe('after the offline claim, over HTTP', () => {
  it('lets the claimed active Owner read and administer, and shows another Owner nothing of the client', async () => {
    buildLegacyProfile(root)
    migrateLegacyProfileForTest(root)
    const data = new AppData(root)
    let a: AppUser
    try {
      a = activeUser(data, 'sub-a', 'Person A', 'owner')
      activeUser(data, 'sub-b', 'Person B', 'owner')
    } finally {
      data.close()
    }
    const { ana } = LEGACY.clients
    const plan = planClaim({ dataDir: root, targetUserId: a.id, clientIds: [ana] })
    expect(applyClaim({ dataDir: root, targetUserId: a.id, clientIds: [ana], confirm: plan.phrase }).claimed).toEqual([ana])

    // The same marker `--init-lan-test-profile` writes: this is a fictional profile.
    writeFileSync(join(root, LAN_TEST_MARKER), JSON.stringify({ kind: 'fictional-test', note: 'Fictional test data only.', createdAt: new Date().toISOString() }))
    expect(existsSync(join(root, LAN_TEST_MARKER))).toBe(true)

    const live = await startServer()
    const sessionA = await signInAs(live, 'a')
    const sessionB = await signInAs(live, 'b')

    expect(result<{ id: string }[]>(await pcall(live, sessionA, 'listClients', listQuery)).map((c) => c.id)).toEqual([ana])
    expect(result<{ id: string }>(await pcall(live, sessionA, 'getClient', ana)).id).toBe(ana)
    expect(result<AppUser[]>(await pcall(live, sessionA, 'listUsers')).some((u) => u.id === a.id)).toBe(true)

    expect(result<unknown[]>(await pcall(live, sessionB, 'listClients', listQuery))).toEqual([])
    expect(result(await pcall(live, sessionB, 'getClient', ana))).toBeNull()
  })
})
