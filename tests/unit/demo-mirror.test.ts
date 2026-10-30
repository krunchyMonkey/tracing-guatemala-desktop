import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startDemoMirror, type RunningDemoMirror } from '../../src/server/demo-mirror'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'

// The fictional demo mirror (#114) over real HTTP on 127.0.0.1, with a stand-in
// demo folder. Fictional data only.

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  text: string
}

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  host: string | null = `localhost:${port}`
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, agent: false, setHost: false, headers: { ...(host ? { Host: host } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

let root: string
let demoDir: string
let logs: string[]
let mirror: RunningDemoMirror | null
let live: RunningLiveServer | null

async function start(dir = demoDir): Promise<RunningDemoMirror> {
  const started = await startDemoMirror({ port: 0, demoDir: dir, log: (line) => logs.push(line) })
  if (!started) throw new Error('the mirror did not start')
  mirror = started
  return started
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-mirror-test-'))
  demoDir = join(root, 'dist-demo')
  mkdirSync(join(demoDir, 'assets'), { recursive: true })
  writeFileSync(join(demoDir, 'index.html'), '<!doctype html><title>Demo</title>')
  writeFileSync(join(demoDir, 'assets', 'app.js'), 'console.log("demo")')
  writeFileSync(join(root, 'secret.txt'), 'outside the demo folder')
  logs = []
  mirror = null
  live = null
})

afterEach(async () => {
  await mirror?.close()
  await live?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('listening', () => {
  it('binds 127.0.0.1 only and is named localhost', async () => {
    const demo = await start()
    expect(demo.origin).toBe(`http://localhost:${demo.port}`)
    // Reachable on the IPv4 loopback address, under either allowed Host.
    expect((await send(demo.port, 'GET', '/', {}, `127.0.0.1:${demo.port}`)).status).toBe(200)
    expect((await send(demo.port, 'GET', '/')).status).toBe(200)
  })

  it('is not started when there is no built demo', async () => {
    const empty = join(root, 'empty')
    mkdirSync(empty)
    expect(await startDemoMirror({ port: 0, demoDir: empty, log: () => {} })).toBeNull()
    expect(await startDemoMirror({ port: 0, demoDir: join(root, 'missing'), log: () => {} })).toBeNull()
  })

  it('reports a busy port to the caller', async () => {
    const demo = await start()
    await expect(startDemoMirror({ port: demo.port, demoDir, log: () => {} })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})

describe('serving the demo', () => {
  it('serves the bundle with the demo’s own policy: no network connections at all', async () => {
    const demo = await start()
    const page = await send(demo.port, 'GET', '/?live=4180')
    expect(page.status).toBe(200)
    expect(page.text).toContain('<title>Demo</title>')
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    const csp = String(page.headers['content-security-policy'])
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("script-src 'self';")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(page.headers['x-content-type-options']).toBe('nosniff')
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    expect(page.headers['x-frame-options']).toBe('DENY')
    expect(page.headers['cache-control']).toBe('no-store')

    const script = await send(demo.port, 'GET', '/assets/app.js')
    expect(script.status).toBe(200)
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(String(script.headers['content-security-policy'])).toContain("connect-src 'none'")
    expect((await send(demo.port, 'HEAD', '/')).text).toBe('')
  })

  it('answers 404 for files that are not there', async () => {
    const demo = await start()
    expect((await send(demo.port, 'GET', '/assets/nope.js')).status).toBe(404)
    expect((await send(demo.port, 'GET', '/assets')).status).toBe(404)
  })

  it('keeps requests inside the demo folder', async () => {
    const demo = await start()
    const paths = ['/../secret.txt', '/..%2Fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2F..%2Fsecret.txt', '/..%5Csecret.txt', '/%00', '/%zz']
    for (const path of paths) {
      const reply = await send(demo.port, 'GET', path)
      expect(reply.status, path).toBe(404)
      expect(reply.text, path).not.toContain('outside the demo folder')
    }
  })
})

describe('request protection', () => {
  it('rejects a spoofed Host header (DNS rebinding) on every route', async () => {
    const demo = await start()
    for (const host of ['evil.test', `evil.test:${demo.port}`, `localhost:${demo.port + 1}`, '127.0.0.1', `192.168.1.5:${demo.port}`]) {
      for (const path of ['/', '/assets/app.js', '/api/v1/session']) {
        const reply = await send(demo.port, 'GET', path, {}, host)
        expect(reply.status, `${host} ${path}`).toBe(421)
        expect(reply.text).toBe('')
      }
    }
    // No Host header at all: Node's own HTTP parser refuses it before the handler runs.
    expect((await send(demo.port, 'GET', '/', {}, null)).status).toBe(400)
  })

  it('has no API: everything under /api is 404', async () => {
    const demo = await start()
    for (const path of ['/api', '/api/', '/api/v1/session', '/api/v1/call/listClients', '/launch']) {
      expect((await send(demo.port, 'GET', path)).status, path).toBe(404)
    }
  })

  it('answers only GET and HEAD', async () => {
    const demo = await start()
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      for (const path of ['/', '/api/v1/call/createClient']) {
        const reply = await send(demo.port, method, path)
        expect(reply.status, `${method} ${path}`).toBe(405)
        expect(reply.headers.allow).toBe('GET, HEAD')
      }
    }
  })

  it('never sets cookies, whatever is asked', async () => {
    const demo = await start()
    for (const path of ['/', '/assets/app.js', '/missing', '/api/v1/session']) {
      expect((await send(demo.port, 'GET', path)).headers['set-cookie'], path).toBeUndefined()
    }
    expect((await send(demo.port, 'POST', '/')).headers['set-cookie']).toBeUndefined()
    expect((await send(demo.port, 'GET', '/', {}, 'evil.test')).headers['set-cookie']).toBeUndefined()
  })

  it('ignores request cookies, including a Live session cookie', async () => {
    live = await startLiveServer({
      dataDir: join(root, 'profile'),
      port: 0,
      staticDir: demoDir,
      appInfo: { name: 'T', version: '0', platform: 'web' },
      log: () => {}
    })
    const launch = new URL(live.launchUrl)
    const livePort = live.port
    const cookie = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: livePort, path: launch.pathname + launch.search, agent: false }, (res) => {
        res.resume()
        resolve((res.headers['set-cookie']?.[0] ?? '').split(';')[0]!)
      })
      req.on('error', reject)
      req.end()
    })
    expect(cookie).toMatch(/^tg_live_\d+=/)

    const demo = await start()
    const plain = await send(demo.port, 'GET', '/')
    const withCookie = await send(demo.port, 'GET', '/', { Cookie: cookie })
    expect(withCookie.status).toBe(plain.status)
    expect(withCookie.text).toBe(plain.text)
    expect(withCookie.headers['set-cookie']).toBeUndefined()
    // Still no API, with or without the cookie.
    expect((await send(demo.port, 'GET', '/api/v1/session', { Cookie: cookie })).status).toBe(404)
    expect((await send(demo.port, 'POST', '/api/v1/call/listClients', { Cookie: cookie })).status).toBe(405)
  })

  it('logs only the method and status', async () => {
    const demo = await start()
    await send(demo.port, 'GET', '/assets/app.js?live=4180')
    await send(demo.port, 'GET', '/missing')
    expect(logs).toEqual(['GET demo 200', 'GET demo 404'])
  })
})
