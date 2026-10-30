import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildDraftIssue,
  codesMatch,
  createFeedbackBridge,
  generateAccessCode,
  loadFeedbackConfig,
  MAX_BODY_BYTES,
  RATE_LIMITS,
  validateFeedbackPayload,
  type FeedbackBridge
} from '../../scripts/demo-feedback.mjs'
import { allowConnectToSelf } from '../../scripts/demo-server.mjs'
import { buildContentSecurityPolicy } from '../../src/shared/csp'
import { buildFeedbackPayload } from '../../src/renderer/src/demo/feedback/payload'

// The opt-in private-project feedback bridge (#102) against a FAKE GitHub GraphQL
// server on 127.0.0.1. Nothing here talks to GitHub, and the token is fictional.

const TOKEN = 'ghp_FAKE_TOKEN_for_tests_only_0123456789'
const PROJECT = 'PVT_fake_private_project'
const CODE = 'ABCD-2345'
const SECRET_TEXT = 'Zebra-ledger-note-7731'

interface FakeGithub {
  url: string
  requests: { auth: string | undefined; body: { query: string; variables: Record<string, unknown> } }[]
  behaviour: { isPublic: boolean | null; node: 'project' | 'missing'; verifyStatus: number; createStatus: number; createDelayMs: number; createErrors: boolean }
  close(): Promise<void>
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function fakeGithub(): Promise<FakeGithub> {
  const requests: FakeGithub['requests'] = []
  const behaviour: FakeGithub['behaviour'] = { isPublic: false, node: 'project', verifyStatus: 200, createStatus: 200, createDelayMs: 0, createErrors: false }
  let items = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query: string; variables: Record<string, unknown> }
      requests.push({ auth: req.headers.authorization, body })
      const reply = (status: number, json: unknown, delay = 0) =>
        setTimeout(() => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(json))
        }, delay)
      if (body.query.includes('addProjectV2DraftIssue')) {
        if (behaviour.createErrors) return reply(200, { errors: [{ message: 'denied' }] })
        items += 1
        return reply(behaviour.createStatus, { data: { addProjectV2DraftIssue: { projectItem: { id: `PVTI_${items}`, project: { url: 'https://github.com/orgs/fake-org/projects/1' } } } } }, behaviour.createDelayMs)
      }
      if (behaviour.verifyStatus !== 200) return reply(behaviour.verifyStatus, { message: 'bad' })
      if (behaviour.node === 'missing') return reply(200, { data: { node: null } })
      return reply(200, { data: { node: { __typename: 'ProjectV2', id: PROJECT, public: behaviour.isPublic } } })
    })
  })
  const port = await listen(server)
  return { url: `http://127.0.0.1:${port}/graphql`, requests, behaviour, close: () => new Promise((r) => server.close(() => r())) }
}

const goodEnv = (github: FakeGithub) => ({ TG_FEEDBACK_GITHUB_TOKEN: TOKEN, TG_FEEDBACK_PROJECT_ID: PROJECT, TG_FEEDBACK_GITHUB_API: github.url })

const goodBody = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: 'key-abcdefghijklmnop',
  category: 'confusing',
  title: 'The archive button',
  comments: `I was not sure what ${SECRET_TEXT} meant.`,
  steps: 'Open a client, look at the top right.',
  screen: 'Client Profile',
  guideStep: 'client-archive',
  appVersion: '0.1.0',
  ...overrides
})

interface Reply {
  status: number
  body: string
  headers: IncomingMessage['headers']
  json: Record<string, unknown>
}

describe('feedback bridge', () => {
  let github: FakeGithub
  let app: Server
  let origin: string
  let host: string
  let bridge: FeedbackBridge
  let logs: string[]
  let clock: number

  const send = (method: string, path: string, { headers = {}, body }: { headers?: Record<string, string>; body?: string | Buffer } = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: Number(new URL(origin).port), method, path, headers: { host, ...headers } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: Record<string, unknown> = {}
          try {
            json = JSON.parse(text) as Record<string, unknown>
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode!, body: text, headers: res.headers, json })
        })
      })
      req.on('error', reject)
      req.end(body)
    })

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    send('POST', '/__feedback', {
      headers: { origin, 'content-type': 'application/json', 'x-feedback-code': CODE, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })

  async function startBridge(env: Record<string, string | undefined>, options: { upstreamTimeoutMs?: number } = {}) {
    app = createServer((req, res) => {
      if (!bridge.handle(req, res)) {
        res.statusCode = 404
        res.end('nope')
      }
    })
    const port = await listen(app)
    origin = `http://127.0.0.1:${port}`
    host = `127.0.0.1:${port}`
    bridge = createFeedbackBridge({ env, origin, host, log: (l) => logs.push(l), now: () => clock, accessCode: CODE, ...options })
    await bridge.init()
  }

  beforeEach(async () => {
    logs = []
    clock = 1_000_000
    github = await fakeGithub()
  })

  afterEach(async () => {
    await github.close()
    await new Promise((r) => app?.close(r))
  })

  it('verifies the private project at startup, then creates a draft issue and returns only ok and the project link', async () => {
    await startBridge(goodEnv(github))
    expect(bridge.isEnabled()).toBe(true)
    expect(github.requests[0]!.body.variables).toEqual({ id: PROJECT })
    expect(github.requests[0]!.auth).toBe(`Bearer ${TOKEN}`)
    expect((await send('GET', '/__feedback/status')).json).toEqual({ enabled: true })

    const reply = await post(goodBody())
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({ ok: true, itemUrl: 'https://github.com/orgs/fake-org/projects/1' })
    const create = github.requests[1]!
    expect(create.body.query).toContain('addProjectV2DraftIssue')
    expect(create.body.query).not.toContain('createIssue')
    expect(create.body.variables['projectId']).toBe(PROJECT)
    expect(create.body.variables['title']).toBe('[confusing] The archive button')
    expect(String(create.body.variables['body'])).toContain('Client Profile')
    expect(String(create.body.variables['body'])).toContain(SECRET_TEXT)
  })

  it('refuses a public project and never sends anything', async () => {
    github.behaviour.isPublic = true
    await startBridge(goodEnv(github))
    expect(bridge.isEnabled()).toBe(false)
    expect((await send('GET', '/__feedback/status')).json).toEqual({ enabled: false })
    expect((await post(goodBody())).status).toBe(503)
    expect(github.requests).toHaveLength(1) // only the verification query
    expect(logs.join('\n')).toMatch(/not private/)
  })

  it.each([
    ['visibility unknown', { isPublic: null }],
    ['an unknown id', { node: 'missing' as const }],
    ['a failing verification call', { verifyStatus: 500 }]
  ])('stays disabled for %s', async (_name, change) => {
    Object.assign(github.behaviour, change)
    await startBridge(goodEnv(github))
    expect(bridge.isEnabled()).toBe(false)
    expect((await post(goodBody())).status).toBe(503)
  })

  it.each([
    ['no token', { TG_FEEDBACK_PROJECT_ID: PROJECT }],
    ['no project', { TG_FEEDBACK_GITHUB_TOKEN: TOKEN }],
    ['nothing', {}]
  ])('is disabled with %s configured, without calling GitHub', async (_name, env) => {
    await startBridge({ ...env, TG_FEEDBACK_GITHUB_API: github.url })
    expect(bridge.isEnabled()).toBe(false)
    expect(github.requests).toHaveLength(0)
    expect((await send('GET', '/__feedback/status')).json).toEqual({ enabled: false })
    expect((await post(goodBody())).status).toBe(503)
  })

  it('rejects a wrong or missing access code', async () => {
    await startBridge(goodEnv(github))
    expect((await post(goodBody(), { 'x-feedback-code': 'WXYZ-9999' })).status).toBe(401)
    const without = await send('POST', '/__feedback', { headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(goodBody()) })
    expect(without.status).toBe(401)
    expect((await post(goodBody(), { 'x-feedback-code': 'abcd 2345' })).status).toBe(200) // case and spacing don't matter
    expect(github.requests).toHaveLength(2) // verify + one create
  })

  it.each([
    ['another site', { origin: 'http://evil.example' }],
    ['a different port', { origin: 'http://127.0.0.1:1' }],
    ['a null origin', { origin: 'null' }],
    ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
    ['a different Host', { host: 'evil.example' }]
  ])('rejects a request from %s', async (_name, headers) => {
    await startBridge(goodEnv(github))
    expect((await post(goodBody(), headers)).status).toBe(403)
    expect(github.requests).toHaveLength(1)
  })

  it('rejects a request with no Origin header', async () => {
    await startBridge(goodEnv(github))
    const reply = await send('POST', '/__feedback', { headers: { 'content-type': 'application/json', 'x-feedback-code': CODE }, body: JSON.stringify(goodBody()) })
    expect(reply.status).toBe(403)
  })

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', ''])('rejects Content-Type %j', async (type) => {
    await startBridge(goodEnv(github))
    const headers: Record<string, string> = type ? { 'content-type': type } : { 'content-type': '' }
    expect((await post(goodBody(), headers)).status).toBe(415)
  })

  it('accepts application/json with a charset', async () => {
    await startBridge(goodEnv(github))
    expect((await post(goodBody(), { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200)
  })

  it('rejects an oversize body, declared or streamed', async () => {
    await startBridge(goodEnv(github))
    const big = JSON.stringify(goodBody({ comments: 'x'.repeat(MAX_BODY_BYTES) }))
    expect((await post(big)).status).toBe(413)
    expect(github.requests).toHaveLength(1)
  })

  it.each([
    ['an unknown field', { extra: 'x' }],
    ['a url field', { url: 'http://192.168.1.2/#/clients/abc' }],
    ['a screen outside the allowlist', { screen: 'Secret Page' }],
    ['a screen that is a URL', { screen: 'http://192.168.1.2:4173/#/clients/de300000-0000-4000-8000-000000000001' }],
    ['a bad category', { category: 'praise' }],
    ['an empty title', { title: '   ' }],
    ['a 121 character title', { title: 'x'.repeat(121) }],
    ['4001 characters of comments', { comments: 'x'.repeat(4001) }],
    ['2001 characters of steps', { steps: 'x'.repeat(2001) }],
    ['a bad idempotency key', { idempotencyKey: 'short' }],
    ['a bad guide step', { guideStep: 'client archive!' }],
    ['a bad version', { appVersion: 'latest; drop' }]
  ])('rejects %s', async (_name, override) => {
    await startBridge(goodEnv(github))
    expect((await post(goodBody(override))).status).toBe(400)
    expect(github.requests).toHaveLength(1)
  })

  it.each(['not json', '[]', 'null', '"text"'])('rejects the malformed body %j', async (body) => {
    await startBridge(goodEnv(github))
    expect((await post(body)).status).toBe(400)
  })

  it('accepts the maximum lengths', async () => {
    await startBridge(goodEnv(github))
    const reply = await post(goodBody({ title: 'x'.repeat(120), comments: 'y'.repeat(4000), steps: 'z'.repeat(2000) }))
    expect(reply.status).toBe(200)
  })

  it('answers other methods and unknown paths safely', async () => {
    await startBridge(goodEnv(github))
    expect((await send('GET', '/__feedback')).status).toBe(405)
    expect((await send('POST', '/__feedback/status')).status).toBe(405)
    expect((await send('GET', '/index.html')).status).toBe(404)
  })

  it('rate limits to 5 a minute and 30 an hour, counting failed attempts too', async () => {
    await startBridge(goodEnv(github))
    for (let i = 0; i < RATE_LIMITS.perMinute; i += 1) {
      expect((await post(goodBody({ idempotencyKey: `key-minute-${String(i).padStart(10, '0')}` }))).status).toBe(200)
    }
    expect((await post(goodBody({ idempotencyKey: 'key-minute-0000000099' }))).status).toBe(429)
    expect((await post(goodBody(), { 'x-feedback-code': 'WXYZ-9999' })).status).toBe(429)

    // A minute later there is room again, up to the hourly cap.
    let sent = RATE_LIMITS.perMinute
    for (let minute = 1; sent < RATE_LIMITS.perHour; minute += 1) {
      clock += 61_000
      for (let i = 0; i < RATE_LIMITS.perMinute && sent < RATE_LIMITS.perHour; i += 1) {
        expect((await post(goodBody({ idempotencyKey: `key-${minute}-${String(i).padStart(10, '0')}` }))).status).toBe(200)
        sent += 1
      }
    }
    clock += 61_000
    expect((await post(goodBody({ idempotencyKey: 'key-hourly-limit-00000' }))).status).toBe(429)
    clock += 3_600_000
    expect((await post(goodBody({ idempotencyKey: 'key-after-an-hour-0000' }))).status).toBe(200)
  })

  it('creates one item for a double click with the same idempotency key, even in flight', async () => {
    github.behaviour.createDelayMs = 60
    await startBridge(goodEnv(github))
    const [a, b] = await Promise.all([post(goodBody()), post(goodBody())])
    expect(a.status).toBe(200)
    expect(b.json).toEqual(a.json)
    expect((await post(goodBody())).json).toEqual(a.json)
    expect(github.requests.filter((r) => r.body.query.includes('addProjectV2DraftIssue'))).toHaveLength(1)
    await post(goodBody({ idempotencyKey: 'a-different-key-00000' }))
    expect(github.requests.filter((r) => r.body.query.includes('addProjectV2DraftIssue'))).toHaveLength(2)
  })

  it('reports an upstream failure without leaking it, and lets the same key retry', async () => {
    await startBridge(goodEnv(github))
    github.behaviour.createStatus = 500
    const failed = await post(goodBody())
    expect(failed.status).toBe(502)
    expect(failed.json).toEqual({ ok: false })
    github.behaviour.createStatus = 200
    github.behaviour.createErrors = true
    expect((await post(goodBody())).status).toBe(502)
    github.behaviour.createErrors = false
    expect((await post(goodBody())).status).toBe(200)
  })

  it('times out a slow upstream call', async () => {
    github.behaviour.createDelayMs = 400
    await startBridge(goodEnv(github), { upstreamTimeoutMs: 100 })
    expect(bridge.isEnabled()).toBe(true)
    const reply = await post(goodBody())
    expect(reply.status).toBe(504)
    expect(reply.json).toEqual({ ok: false })
  })

  it('never puts the token, the access code or message text in a response header, body or log', async () => {
    await startBridge(goodEnv(github))
    const replies = [
      await post(goodBody()),
      await post(goodBody(), { 'x-feedback-code': 'WXYZ-9999' }),
      await post(goodBody({ extra: SECRET_TEXT })),
      await send('GET', '/__feedback/status')
    ]
    github.behaviour.createStatus = 500
    replies.push(await post(goodBody({ idempotencyKey: 'key-failing-000000000' })))
    const seen = JSON.stringify(replies.map((r) => [r.status, r.body, r.headers])) + logs.join('\n')
    expect(seen).not.toContain(TOKEN)
    expect(seen).not.toContain('ghp_')
    expect(seen).not.toContain(SECRET_TEXT)
    expect(seen).not.toContain(CODE)
    expect(replies[0]!.json).toEqual({ ok: true, itemUrl: 'https://github.com/orgs/fake-org/projects/1' })
    expect(Object.keys(replies[0]!.headers)).not.toContain('access-control-allow-origin')
  })

  it('sends no CORS headers and no-store caching on its responses', async () => {
    await startBridge(goodEnv(github))
    const reply = await send('GET', '/__feedback/status', { headers: { origin: 'http://evil.example' } })
    expect(reply.headers['access-control-allow-origin']).toBeUndefined()
    expect(reply.headers['cache-control']).toBe('no-store')
  })
})

describe('configuration', () => {
  it('uses the real GitHub endpoint by default', () => {
    expect(loadFeedbackConfig({ TG_FEEDBACK_GITHUB_TOKEN: 't', TG_FEEDBACK_PROJECT_ID: 'p' })).toMatchObject({ ok: true, apiUrl: 'https://api.github.com/graphql' })
  })

  it.each(['https://github.example/graphql', 'http://127.0.0.1:9999/graphql'])('accepts the endpoint override %s', (api) => {
    expect(loadFeedbackConfig({ TG_FEEDBACK_GITHUB_TOKEN: 't', TG_FEEDBACK_PROJECT_ID: 'p', TG_FEEDBACK_GITHUB_API: api })).toMatchObject({ ok: true })
  })

  it.each(['http://api.github.com/graphql', 'http://localhost:9/graphql', 'http://192.168.1.5/graphql', 'ftp://127.0.0.1/x', 'not a url', 'https://user:pw@github.example/x'])(
    'rejects the endpoint override %s',
    (api) => {
      expect(loadFeedbackConfig({ TG_FEEDBACK_GITHUB_TOKEN: 't', TG_FEEDBACK_PROJECT_ID: 'p', TG_FEEDBACK_GITHUB_API: api })).toMatchObject({ ok: false })
    }
  )

  it('never echoes the token in a configuration error', () => {
    const result = loadFeedbackConfig({ TG_FEEDBACK_GITHUB_TOKEN: TOKEN, TG_FEEDBACK_GITHUB_API: 'http://example.com' })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })
})

describe('access code', () => {
  it('is random, readable and compared ignoring case and punctuation', () => {
    const a = generateAccessCode()
    expect(a).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(generateAccessCode()).not.toBe(a)
    expect(codesMatch('ABCD-2345', 'abcd2345')).toBe(true)
    expect(codesMatch('ABCD-2345', 'ABCD-2346')).toBe(false)
    expect(codesMatch('ABCD-2345', '')).toBe(false)
  })
})

describe('feedback CSP', () => {
  it('changes only connect-src, in the header and the meta tag', () => {
    for (const forMetaTag of [false, true]) {
      const base = buildContentSecurityPolicy({ mode: 'production', forMetaTag })
      const relaxed = allowConnectToSelf(base)
      expect(relaxed).toContain("connect-src 'self'")
      expect(relaxed.replace("connect-src 'self'", "connect-src 'none'")).toBe(base)
      expect(relaxed).toBe(buildContentSecurityPolicy({ mode: 'production', forMetaTag, connectToSelf: true }))
    }
  })

  it('also works on the HTML-escaped form Vite writes into the built page', () => {
    const escaped = buildContentSecurityPolicy({ mode: 'production', forMetaTag: true }).replaceAll("'", '&#39;')
    expect(allowConnectToSelf(escaped)).toContain('connect-src &#39;self&#39;')
    expect(() => allowConnectToSelf('default-src &#39;none&#39;')).toThrow()
  })
})

describe('payload builder', () => {
  const input = {
    category: 'bug',
    title: '  Archive   button  ',
    comments: 'It did nothing.',
    steps: '',
    screen: 'Client Profile',
    guideStep: 'client-archive',
    appVersion: '0.1.0',
    idempotencyKey: 'key-abcdefghijklmnop'
  } as const

  it('keeps only allowlisted fields and produces a payload the server accepts', () => {
    const payload = buildFeedbackPayload({
      ...input,
      // Things a careless caller might pass along; none may survive.
      url: 'http://192.168.1.2:4173/#/clients/de300000-0000-4000-8000-000000000001?q=lucia',
      clientName: 'Lucía Fernández',
      email: 'lucia.fernandez@example.com',
      formValues: { note: 'secret' }
    } as unknown as Parameters<typeof buildFeedbackPayload>[0])
    expect(Object.keys(payload).sort()).toEqual(['appVersion', 'category', 'comments', 'guideStep', 'idempotencyKey', 'screen', 'title'])
    expect(payload.title).toBe('Archive button')
    expect(JSON.stringify(payload)).not.toMatch(/192\.168|de300000|lucia|example\.com|secret/i)
    expect(validateFeedbackPayload(payload).ok).toBe(true)
  })

  it('drops a screen label or guide step outside the allowlist', () => {
    const payload = buildFeedbackPayload({ ...input, screen: '#/clients/de300000-0000-4000-8000-000000000001' as never, guideStep: 'Not A Step' })
    expect(payload.screen).toBe('Home')
    expect(payload.guideStep).toBeUndefined()
  })

  it('includes optional steps only when written, and trims to the limits', () => {
    expect(buildFeedbackPayload({ ...input, steps: ' go here ' }).steps).toBe('go here')
    expect('steps' in buildFeedbackPayload({ ...input, steps: '   ' })).toBe(false)
    const long = buildFeedbackPayload({ ...input, title: 't'.repeat(500), comments: 'c'.repeat(9000), steps: 's'.repeat(9000) })
    expect([long.title.length, long.comments.length, long.steps!.length]).toEqual([120, 4000, 2000])
  })

  it('builds a draft issue body from validated text only', () => {
    const checked = validateFeedbackPayload(buildFeedbackPayload({ ...input, comments: 'Ping @someone please' }))
    if (!checked.ok) throw new Error('expected a valid payload')
    const draft = buildDraftIssue(checked.value)
    expect(draft.title).toBe('[bug] Archive button')
    expect(draft.body).not.toContain('@someone')
    expect(draft.body).toContain('Client Profile')
    expect(draft.body).toContain('client-archive')
  })
})
