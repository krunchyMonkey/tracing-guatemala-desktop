import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localIPv4Addresses, isPrivateIPv4 } from '../../scripts/demo-server.mjs'
import { backupFileName, isBackupFileName } from '../../src/server/backup'
import { acquireDataDirLock, checkLiveDataDir, DataDirInUseError, defaultLiveDataDir, desktopProfileDir } from '../../src/server/data-dir'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { ClientInput, DirectoryQuery, NoteInput } from '../../src/shared/client-model'
import { call, send, signIn, without, writeHeaders } from './live-helpers'

// The Live web host (#110) over real HTTP on 127.0.0.1, with throwaway data
// folders. Fictional data only.

const input: ClientInput = {
  displayName: 'Ana Ejemplo',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: 'fictional_buyer_01',
  email: null,
  otherContact: null,
  preferredContactChannel: 'fiverr'
}

const note: NoteInput = {
  kind: 'note',
  occurredAt: '2026-10-20T10:00:00.000Z',
  channel: null,
  direction: null,
  body: 'Fictional research note.'
}

const everyone: DirectoryQuery = { text: '', status: 'all', sources: [], sort: 'name' }

let root: string
let dataDir: string
let staticDir: string
let logs: string[]
let server: RunningLiveServer | null

async function start(): Promise<RunningLiveServer> {
  server = await startLiveServer({
    dataDir,
    port: 0,
    staticDir,
    appInfo: { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' },
    log: (line) => logs.push(line)
  })
  return server
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-live-test-'))
  dataDir = join(root, 'profile')
  staticDir = join(root, 'client')
  mkdirSync(join(staticDir, 'assets'), { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'secret.txt'), 'outside the client folder')
  logs = []
  server = null
})

afterEach(async () => {
  await server?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('listening', () => {
  it('binds 127.0.0.1 only and prints a launch link on that address', async () => {
    const live = await start()
    expect(live.origin).toBe(`http://127.0.0.1:${live.port}`)
    expect(live.launchUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${live.port}/launch\\?token=[\\w-]{43}$`))
  })

  it('cannot be reached through this computer’s home-network address', async (context) => {
    const lan = localIPv4Addresses().find((a) => isPrivateIPv4(a.address))
    if (!lan) {
      context.skip()
      return
    }
    const live = await start()
    const outcome = await new Promise<string>((resolve) => {
      const req = request({ host: lan.address, port: live.port, path: '/api/v1/session', timeout: 2000 }, () => resolve('connected'))
      req.on('timeout', () => {
        req.destroy()
        resolve('timeout')
      })
      req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'))
      req.end()
    })
    expect(outcome).not.toBe('connected')
  })
})

describe('signing in', () => {
  it('turns the launch link into an HttpOnly, SameSite=Strict session cookie and redirects away from the token', async () => {
    const live = await start()
    const launch = await send(live, 'GET', new URL(live.launchUrl).pathname + new URL(live.launchUrl).search)
    expect(launch.status).toBe(303)
    expect(launch.headers.location).toBe('/')
    expect(launch.headers['referrer-policy']).toBe('no-referrer')
    const cookie = launch.headers['set-cookie']?.[0] ?? ''
    expect(cookie).toMatch(new RegExp(`^tg_live_${live.port}=[\\w-]+; Path=/; HttpOnly; SameSite=Strict$`))
  })

  it('refuses a wrong launch token without a cookie', async () => {
    const live = await start()
    const reply = await send(live, 'GET', '/launch?token=guess')
    expect(reply.status).toBe(403)
    expect(reply.headers['set-cookie']).toBeUndefined()
  })

  it('reports no session, and no CSRF token, to a browser without the cookie', async () => {
    const live = await start()
    expect((await send(live, 'GET', '/api/v1/session')).json()).toEqual({ authenticated: false })
    expect((await send(live, 'GET', '/api/v1/session', { Cookie: `tg_live_${live.port}=forged` })).json()).toEqual({
      authenticated: false
    })
  })

  it('invalidates the launch link and every session when the host restarts', async () => {
    const first = await start()
    const signed = await signIn(first)
    const oldLaunch = new URL(first.launchUrl)
    await first.close()

    // Same port, so the old cookie would be sent again.
    server = await startLiveServer({ dataDir, port: first.port, staticDir, appInfo: { name: 'T', version: '0', platform: 'web' }, log: () => {} })
    expect((await send(server, 'GET', '/api/v1/session', { Cookie: signed.cookie })).json()).toEqual({ authenticated: false })
    expect((await send(server, 'GET', oldLaunch.pathname + oldLaunch.search)).status).toBe(403)
  })
})

describe('request protection', () => {
  it('rejects a spoofed Host header (DNS rebinding) on every route', async () => {
    const live = await start()
    const signed = await signIn(live)
    for (const path of ['/', '/api/v1/session', '/launch?token=x']) {
      expect((await send(live, 'GET', path, { Host: `attacker.example:${live.port}` })).status).toBe(421)
    }
    const write = await send(
      live,
      'POST',
      '/api/v1/call/getAppInfo',
      { ...writeHeaders(live, signed), Host: `attacker.example:${live.port}`, Origin: `http://attacker.example:${live.port}` },
      '{"args":[]}'
    )
    expect(write.status).toBe(421)
  })

  it('rejects a cross-origin POST even with a valid cookie and token', async () => {
    const live = await start()
    const signed = await signIn(live)
    const headers = writeHeaders(live, signed)
    for (const origin of ['http://evil.example', 'http://127.0.0.1:4173', 'null']) {
      const reply = await send(live, 'POST', '/api/v1/call/getAppInfo', { ...headers, Origin: origin }, '{"args":[]}')
      expect(reply.status).toBe(403)
      expect(reply.json()).toEqual({ error: 'not-same-origin' })
    }
    const withoutOrigin = without(headers, 'Origin')
    expect((await send(live, 'POST', '/api/v1/call/getAppInfo', withoutOrigin, '{"args":[]}')).status).toBe(403)
    const crossSite = await send(live, 'POST', '/api/v1/call/getAppInfo', { ...headers, 'Sec-Fetch-Site': 'same-site' }, '{"args":[]}')
    expect(crossSite.status).toBe(403)
  })

  it('rejects an unauthenticated write', async () => {
    const live = await start()
    const signed = await signIn(live)
    const noCookie = without(writeHeaders(live, signed), 'Cookie')
    const reply = await send(live, 'POST', '/api/v1/call/createClient', noCookie, JSON.stringify({ args: [input] }))
    expect(reply.status).toBe(401)
    expect(reply.json()).toEqual({ error: 'not-signed-in' })
  })

  it('rejects a missing or wrong CSRF token', async () => {
    const live = await start()
    const signed = await signIn(live)
    const noToken = without(writeHeaders(live, signed), 'X-TG-CSRF')
    expect((await send(live, 'POST', '/api/v1/call/getAppInfo', noToken, '{"args":[]}')).status).toBe(403)
    const wrong = await send(live, 'POST', '/api/v1/call/getAppInfo', { ...noToken, 'X-TG-CSRF': 'x'.repeat(43) }, '{"args":[]}')
    expect(wrong.json()).toEqual({ error: 'bad-csrf-token' })
  })

  it('rejects other content types, oversized and malformed bodies, unknown calls and wrong methods', async () => {
    const live = await start()
    const signed = await signIn(live)
    const headers = writeHeaders(live, signed)
    const post = (path: string, body: string, extra: Record<string, string> = {}) => send(live, 'POST', path, { ...headers, ...extra }, body)

    expect((await post('/api/v1/call/getAppInfo', '{"args":[]}', { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await post('/api/v1/call/getAppInfo', JSON.stringify({ args: ['x'.repeat(70_000)] }))).status).toBe(413)
    expect((await post('/api/v1/call/getAppInfo', '{"args":')).status).toBe(400)
    expect((await post('/api/v1/call/getAppInfo', '{"notArgs":[]}')).status).toBe(400)
    expect((await post('/api/v1/call/chooseBackupToRestore', '{"args":[]}')).status).toBe(404)
    expect((await post('/api/v1/call/__proto__', '{"args":[]}')).status).toBe(404)
    expect((await send(live, 'GET', '/api/v1/call/getAppInfo', { Cookie: signed.cookie })).status).toBe(405)
    expect((await send(live, 'GET', '/api/v1/nothing', { Cookie: signed.cookie })).status).toBe(404)
  })

  it('validates arguments strictly and never echoes submitted values or logs them', async () => {
    const live = await start()
    const signed = await signIn(live)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const marker = 'Fictional Secret Surname'
    const reply = await send(
      live,
      'POST',
      '/api/v1/call/createClient',
      writeHeaders(live, signed),
      JSON.stringify({ args: [{ ...input, displayName: marker, status: 'archived' }] })
    )
    expect(reply.status).toBe(400)
    expect(reply.json()).toEqual({ error: 'invalid-arguments' })
    expect(reply.text).not.toContain(marker)
    expect([...logs, ...errors.mock.calls.flat()].join('\n')).not.toContain(marker)
    errors.mockRestore()
  })

  it('sends security headers and a CSP that only allows its own origin', async () => {
    const live = await start()
    const page = await send(live, 'GET', '/')
    expect(page.status).toBe(200)
    expect(page.headers['content-security-policy']).toContain("connect-src 'self'")
    expect(page.headers['content-security-policy']).toContain("script-src 'self';")
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(page.headers['x-content-type-options']).toBe('nosniff')
    expect(page.headers['x-frame-options']).toBe('DENY')
    expect(page.headers['access-control-allow-origin']).toBeUndefined()
    expect((await send(live, 'GET', '/assets/app.js')).status).toBe(200)
  })

  it('never serves files outside the built client', async () => {
    const live = await start()
    for (const path of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const reply = await send(live, 'GET', path)
      expect(reply.status).toBe(404)
      expect(reply.text).not.toContain('outside the client folder')
    }
  })
})

describe('data', () => {
  it('saves clients and notes, keeps client isolation, and keeps everything across a restart', async () => {
    let live = await start()
    let signed = await signIn(live)
    const a = await call<{ ok: true; client: { id: string } }>(live, signed, 'createClient', input)
    const b = await call<{ ok: true; client: { id: string } }>(live, signed, 'createClient', { ...input, displayName: 'Bruno Ficticio', fiverrUsername: 'fictional_buyer_02' })
    const added = await call<{ ok: true; note: { id: string } }>(live, signed, 'createNote', a.client.id, note)
    expect(added.ok).toBe(true)

    // A note can't be read or edited through another client.
    expect(await call(live, signed, 'listNotes', b.client.id)).toEqual([])
    expect(await call(live, signed, 'updateNote', b.client.id, added.note.id, { ...note, body: 'Changed' })).toEqual({
      ok: false,
      reason: 'not-found'
    })

    expect((await call<{ ok: boolean }>(live, signed, 'archiveClient', b.client.id)).ok).toBe(true)

    await live.close()
    live = await start()
    signed = await signIn(live)
    const names = (await call<{ displayName: string; status: string }[]>(live, signed, 'listClients', everyone)).map(
      (c) => `${c.displayName}:${c.status}`
    )
    expect(names).toEqual(['Ana Ejemplo:active', 'Bruno Ficticio:archived'])
    const notes = await call<{ body: string }[]>(live, signed, 'listNotes', a.client.id)
    expect(notes.map((n) => n.body)).toEqual(['Fictional research note.'])
  })

  it('keeps its own database file in the data folder', async () => {
    await start()
    expect(readdirSync(join(dataDir, 'data'))).toContain('tracing-guatemala.sqlite')
  })
})

describe('backups', () => {
  it('creates a backup, downloads it only with a session, and restores it by upload', async () => {
    const live = await start()
    const signed = await signIn(live)
    await call(live, signed, 'createClient', input)
    const made = await call<{ ok: true; fileName: string; clients: number }>(live, signed, 'createBackup')
    expect(made).toMatchObject({ ok: true, clients: 1, notes: 0 })
    expect(isBackupFileName(made.fileName)).toBe(true)

    const path = `/api/v1/backup/download/${encodeURIComponent(made.fileName)}`
    expect((await send(live, 'GET', path)).status).toBe(401)
    expect((await send(live, 'GET', path, { Cookie: signed.cookie, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await send(live, 'GET', '/api/v1/backup/download/..%2fdata%2ftracing-guatemala.sqlite', { Cookie: signed.cookie })).status).toBe(404)
    const download = await send(live, 'GET', path, { Cookie: signed.cookie })
    expect(download.status).toBe(200)
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${made.fileName}"`)
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: live.port, path, headers: { Cookie: signed.cookie } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      })
      req.on('error', reject)
      req.end()
    })

    // Change the data, then restore the downloaded backup.
    await call(live, signed, 'createClient', { ...input, displayName: 'Added After Backup', fiverrUsername: 'fictional_buyer_03' })
    const uploadHeaders = {
      ...writeHeaders(live, signed),
      'Content-Type': 'application/octet-stream',
      'X-TG-File-Name': encodeURIComponent('C:\\Users\\someone\\My backup.tgbackup'),
      'X-TG-Last-Modified': String(Date.UTC(2026, 9, 28))
    }
    const choice = (await send(live, 'POST', '/api/v1/backup/upload', uploadHeaders, bytes)).json() as {
      result: { ok: true; token: string; fileName: string; savedAt: string; clients: number }
    }
    expect(choice.result).toMatchObject({ ok: true, fileName: 'My backup.tgbackup', savedAt: '2026-10-28T00:00:00.000Z', clients: 1 })

    expect(await call(live, signed, 'restoreBackup', choice.result.token)).toEqual({ ok: true, clients: 1, notes: 0 })
    expect((await call<{ displayName: string }[]>(live, signed, 'listClients', everyone)).map((c) => c.displayName)).toEqual(['Ana Ejemplo'])
    // A token works once.
    expect(await call(live, signed, 'restoreBackup', choice.result.token)).toEqual({ ok: false, reason: 'expired' })
    expect(readdirSync(join(dataDir, 'uploads'))).toEqual([])
  })

  it('rejects a file that is not a backup without changing data', async () => {
    const live = await start()
    const signed = await signIn(live)
    await call(live, signed, 'createClient', input)
    const headers = { ...writeHeaders(live, signed), 'Content-Type': 'application/octet-stream' }
    const reply = await send(live, 'POST', '/api/v1/backup/upload', headers, Buffer.from('not a database'.repeat(100)))
    expect(reply.json()).toEqual({ result: { ok: false, reason: 'not-a-backup' } })
    expect(await call<unknown[]>(live, signed, 'listClients', everyone)).toHaveLength(1)
  })

  it('protects uploads like other writes and refuses oversized ones before reading them', async () => {
    const live = await start()
    const signed = await signIn(live)
    const headers: Record<string, string> = { ...writeHeaders(live, signed), 'Content-Type': 'application/octet-stream' }
    expect((await send(live, 'POST', '/api/v1/backup/upload', { ...headers, Origin: 'http://evil.example' }, 'x')).status).toBe(403)
    const noToken = without(headers, 'X-TG-CSRF')
    expect((await send(live, 'POST', '/api/v1/backup/upload', noToken, 'x')).status).toBe(403)
    expect((await send(live, 'POST', '/api/v1/backup/upload', { ...headers, 'Content-Type': 'application/json' }, 'x')).status).toBe(415)

    const tooLarge = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: live.port,
          method: 'POST',
          path: '/api/v1/backup/upload',
          headers: { ...headers, Host: `127.0.0.1:${live.port}`, 'Content-Length': String(600 * 1024 ** 2) }
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.write('partial')
    })
    expect(tooLarge).toBe(413)
  })

  it('names backups by local time and only accepts names it generates', () => {
    const name = backupFileName(new Date(2026, 9, 29, 8, 5, 9))
    expect(name).toBe('Tracing Guatemala backup 2026-10-29 08-05-09.tgbackup')
    expect(isBackupFileName(backupFileName(new Date(2026, 9, 29, 8, 5, 9), 2))).toBe(true)
    for (const bad of ['../tracing-guatemala.sqlite', 'Tracing Guatemala backup 2026-10-29.tgbackup', `${name}/x`, 'x.tgbackup']) {
      expect(isBackupFileName(bad)).toBe(false)
    }
  })
})

describe('data folder', () => {
  const win = (appData: string) => ({ platform: 'win32' as const, env: { APPDATA: appData }, home: 'C:\\Users\\someone' })

  it('defaults to its own profile next to, never inside, the desktop app’s', () => {
    const platform = win('C:\\Users\\someone\\AppData\\Roaming')
    expect(defaultLiveDataDir(platform)).toBe(join('C:\\Users\\someone\\AppData\\Roaming', 'Tracing Guatemala Web'))
    expect(desktopProfileDir(platform)).toBe(join('C:\\Users\\someone\\AppData\\Roaming', 'Tracing Guatemala'))
  })

  it('refuses the desktop app’s profile and Chromium-style profiles', () => {
    const desktop = join(root, 'Tracing Guatemala')
    const platform = { platform: 'linux' as const, env: { XDG_CONFIG_HOME: root }, home: root }
    expect(checkLiveDataDir(desktop, platform).ok).toBe(false)
    mkdirSync(join(root, 'electronish'))
    writeFileSync(join(root, 'electronish', 'Local State'), '{}')
    expect(checkLiveDataDir(join(root, 'electronish'), platform).ok).toBe(false)
    expect(checkLiveDataDir(join(root, 'fresh'), platform).ok).toBe(true)
  })

  it('lets only one host use a data folder at a time, and replaces a stale lock', async () => {
    const live = await start()
    await expect(
      startLiveServer({ dataDir, port: 0, staticDir, appInfo: { name: 'T', version: '0', platform: 'web' }, log: () => {} })
    ).rejects.toThrow(DataDirInUseError)
    await live.close()
    server = null

    // A lock left by a process that is no longer running is replaced.
    writeFileSync(join(dataDir, 'web-host.lock'), '999999')
    const release = acquireDataDirLock(dataDir)
    expect(() => acquireDataDirLock(dataDir)).toThrow(DataDirInUseError)
    release()
    expect(readdirSync(dataDir)).not.toContain('web-host.lock')
  })
})
