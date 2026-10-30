import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

// Opt-in private researcher feedback for the LAN demo (#102). Used only by
// `npm run demo:lan:feedback` (scripts/demo-server.mjs with `--feedback`). It adds
// two same-origin routes to the demo host and, from this computer only, creates a
// DRAFT ISSUE in an owner-chosen PRIVATE GitHub Project (GraphQL
// `addProjectV2DraftIssue`). It never creates repository issues, never falls back
// to anything else, and fails closed: if the Project is missing, public or can't be
// verified, sending stays disabled and the demo keeps working.
//
// Secrets: configuration comes only from environment variables. The token and the
// message contents are never logged, echoed or put in a response.

export const STATUS_PATH = '/__feedback/status'
export const SUBMIT_PATH = '/__feedback'
export const MAX_BODY_BYTES = 16 * 1024
export const DEFAULT_GITHUB_API = 'https://api.github.com/graphql'
export const CATEGORIES = ['bug', 'confusing', 'improvement', 'other']
export const SCREENS = ['Home', 'Directory', 'New Client', 'Client Profile', 'Case', 'Settings']
export const LIMITS = { title: 120, comments: 4000, steps: 2000 }
export const RATE_LIMITS = { perMinute: 5, perHour: 30 }

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const STEP_PATTERN = /^[a-z0-9-]{1,40}$/
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,20})?$/
const ALLOWED_FIELDS = ['idempotencyKey', 'category', 'title', 'comments', 'steps', 'screen', 'guideStep', 'appVersion']
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Reads configuration from the environment only. Never throws and never echoes the token. */
export function loadFeedbackConfig(env) {
  const token = (env['TG_FEEDBACK_GITHUB_TOKEN'] ?? '').trim()
  const projectId = (env['TG_FEEDBACK_PROJECT_ID'] ?? '').trim()
  if (!token || !projectId) {
    return { ok: false, reason: 'TG_FEEDBACK_GITHUB_TOKEN and TG_FEEDBACK_PROJECT_ID must both be set.' }
  }
  const rawApi = (env['TG_FEEDBACK_GITHUB_API'] ?? '').trim()
  let apiUrl = DEFAULT_GITHUB_API
  if (rawApi) {
    let parsed
    try {
      parsed = new URL(rawApi)
    } catch {
      return { ok: false, reason: 'TG_FEEDBACK_GITHUB_API is not a valid URL.' }
    }
    const loopback = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
    if (parsed.protocol !== 'https:' && !loopback) {
      return { ok: false, reason: 'TG_FEEDBACK_GITHUB_API must be https (http is allowed only for 127.0.0.1, for tests).' }
    }
    if (parsed.username || parsed.password) {
      return { ok: false, reason: 'TG_FEEDBACK_GITHUB_API must not contain credentials.' }
    }
    apiUrl = parsed.toString()
  }
  return { ok: true, token, projectId, apiUrl }
}

/** A short one-time code the host reads out to the researcher, e.g. `K7QM-3XRT`. */
export function generateAccessCode() {
  const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`
}

const normalizeCode = (value) => String(value).toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Constant-time comparison (both sides hashed to the same length first). */
export function codesMatch(expected, given) {
  const a = createHash('sha256').update(normalizeCode(expected)).digest()
  const b = createHash('sha256').update(normalizeCode(given)).digest()
  return timingSafeEqual(a, b)
}

const isText = (value, max, { min = 1 } = {}) => typeof value === 'string' && value.trim().length >= min && value.length <= max

/**
 * Strict schema check of a feedback body. Unknown fields are rejected, not stripped.
 * Returns { ok: true, value } with trimmed text, or { ok: false }.
 */
export function validateFeedbackPayload(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false }
  if (Object.keys(input).some((key) => !ALLOWED_FIELDS.includes(key))) return { ok: false }
  const { idempotencyKey, category, title, comments, steps, screen, guideStep, appVersion } = input
  if (typeof idempotencyKey !== 'string' || !KEY_PATTERN.test(idempotencyKey)) return { ok: false }
  if (!CATEGORIES.includes(category)) return { ok: false }
  if (!isText(title, LIMITS.title) || !isText(comments, LIMITS.comments)) return { ok: false }
  if (steps !== undefined && !isText(steps, LIMITS.steps, { min: 0 })) return { ok: false }
  if (!SCREENS.includes(screen)) return { ok: false }
  if (guideStep !== undefined && (typeof guideStep !== 'string' || !STEP_PATTERN.test(guideStep))) return { ok: false }
  if (typeof appVersion !== 'string' || !VERSION_PATTERN.test(appVersion)) return { ok: false }
  return {
    ok: true,
    value: {
      idempotencyKey,
      category,
      title: title.trim().replace(/\s+/g, ' '),
      comments: comments.trim(),
      steps: steps?.trim() ? steps.trim() : undefined,
      screen,
      guideStep,
      appVersion
    }
  }
}

// A zero-width space stops @name from notifying anyone if the text is ever pasted elsewhere.
const defang = (text) => text.replace(/@(?=\w)/g, '@​')

/** The Project draft issue title and Markdown body for a validated payload. */
export function buildDraftIssue(payload) {
  const lines = [
    `**Category:** ${payload.category}`,
    `**Screen:** ${payload.screen}`,
    ...(payload.guideStep ? [`**Tour step:** ${payload.guideStep}`] : []),
    `**App version:** ${payload.appVersion}`,
    '',
    '### Comments',
    defang(payload.comments),
    ...(payload.steps ? ['', '### Steps to reproduce', defang(payload.steps)] : []),
    '',
    '_Submitted from the fictional LAN demo._'
  ]
  return { title: defang(`[${payload.category}] ${payload.title}`), body: lines.join('\n') }
}

const VERIFY_QUERY = 'query($id: ID!) { node(id: $id) { __typename ... on ProjectV2 { id public } } }'
const CREATE_MUTATION =
  'mutation($projectId: ID!, $title: String!, $body: String!) { addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) { projectItem { id project { url } } } }'

class UpstreamError extends Error {
  constructor(kind) {
    super(kind)
    this.kind = kind
  }
}

/**
 * Creates the feedback bridge.
 *  - env: environment variables (configuration source).
 *  - origin / host: this server's own address, e.g. http://192.168.1.24:4173 and 192.168.1.24:4173.
 *  - headers: response headers shared with the demo server (CSP and friends).
 *  - log: receives fixed status lines only, never tokens or message text.
 */
export function createFeedbackBridge({
  env,
  origin,
  host,
  headers = {},
  fetchImpl = globalThis.fetch,
  log = () => undefined,
  now = Date.now,
  accessCode = generateAccessCode(),
  upstreamTimeoutMs = 10_000
}) {
  const config = loadFeedbackConfig(env)
  let enabled = false
  const attempts = []
  const seen = new Map() // idempotency key -> { at, promise }

  async function graphql(query, variables) {
    let response
    try {
      response = await fetchImpl(config.apiUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          'user-agent': 'tracing-guatemala-demo-feedback'
        },
        body: JSON.stringify({ query, variables }),
        redirect: 'error',
        signal: AbortSignal.timeout(upstreamTimeoutMs)
      })
    } catch (error) {
      throw new UpstreamError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network')
    }
    if (!response.ok) throw new UpstreamError('status')
    let json
    try {
      json = await response.json()
    } catch {
      throw new UpstreamError('shape')
    }
    if (!json || typeof json !== 'object' || (Array.isArray(json.errors) && json.errors.length > 0) || !json.data) {
      throw new UpstreamError('shape')
    }
    return json.data
  }

  /** Verifies the Project is private. Anything else leaves sending disabled. */
  async function init() {
    enabled = false
    if (!config.ok) {
      log(`Feedback sending is off: ${config.reason}`)
      return enabled
    }
    try {
      const data = await graphql(VERIFY_QUERY, { id: config.projectId })
      const node = data.node
      if (!node || node.__typename !== 'ProjectV2') {
        log('Feedback sending is off: the configured ID is not a GitHub Project.')
      } else if (node.public !== false) {
        log('Feedback sending is off: that GitHub Project is not private. Make it private first.')
      } else {
        enabled = true
        log('Feedback sending is on: private GitHub Project verified.')
      }
    } catch {
      log('Feedback sending is off: could not verify the Project (check the token, the Project ID and the network).')
    }
    return enabled
  }

  async function createItem(payload) {
    const { title, body } = buildDraftIssue(payload)
    const data = await graphql(CREATE_MUTATION, { projectId: config.projectId, title, body })
    const item = data.addProjectV2DraftIssue?.projectItem
    if (!item || typeof item.id !== 'string') throw new UpstreamError('shape')
    const url = item.project?.url
    return typeof url === 'string' && /^https:\/\/github\.com\//.test(url) ? { ok: true, itemUrl: url } : { ok: true }
  }

  function withinRate() {
    const t = now()
    while (attempts.length > 0 && t - attempts[0] > 3_600_000) attempts.shift()
    const lastMinute = attempts.filter((at) => t - at <= 60_000).length
    if (lastMinute >= RATE_LIMITS.perMinute || attempts.length >= RATE_LIMITS.perHour) return false
    attempts.push(t)
    return true
  }

  function remember(key, promise) {
    const t = now()
    for (const [k, v] of seen) if (t - v.at > 3_600_000) seen.delete(k)
    while (seen.size >= 500) seen.delete(seen.keys().next().value)
    seen.set(key, { at: t, promise })
  }

  function send(res, status, body) {
    res.writeHead(status, {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    res.end(JSON.stringify(body))
  }

  /** Reads at most MAX_BODY_BYTES; resolves null when the body is larger. */
  function readBody(req) {
    return new Promise((resolve) => {
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        resolve(null)
        return
      }
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          chunks.length = 0
          resolve(null)
        } else {
          chunks.push(chunk)
        }
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', () => resolve(null))
    })
  }

  async function submit(req, res) {
    if (!enabled) return send(res, 503, { ok: false })
    // Same origin only: a page on any other site (or no page at all) is turned away.
    if (req.headers['host'] !== host || req.headers['origin'] !== origin) return send(res, 403, { ok: false })
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin') return send(res, 403, { ok: false })
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') return send(res, 415, { ok: false })
    if (!withinRate()) return send(res, 429, { ok: false })
    const given = req.headers['x-feedback-code']
    if (typeof given !== 'string' || !codesMatch(accessCode, given)) return send(res, 401, { ok: false })

    const raw = await readBody(req)
    if (raw === null) {
      res.setHeader?.('Connection', 'close')
      return send(res, 413, { ok: false })
    }
    let parsed
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      return send(res, 400, { ok: false })
    }
    const checked = validateFeedbackPayload(parsed)
    if (!checked.ok) return send(res, 400, { ok: false })

    // A double-click or retry with the same key gets the first answer, not a second item.
    let entry = seen.get(checked.value.idempotencyKey)
    if (!entry) {
      const promise = createItem(checked.value)
      remember(checked.value.idempotencyKey, promise)
      entry = seen.get(checked.value.idempotencyKey)
    }
    try {
      return send(res, 200, await entry.promise)
    } catch (error) {
      seen.delete(checked.value.idempotencyKey) // Failures can be retried.
      return send(res, error instanceof UpstreamError && error.kind === 'timeout' ? 504 : 502, { ok: false })
    }
  }

  /** Handles the feedback routes. Returns false for any other request. */
  function handle(req, res) {
    const path = (req.url ?? '').split('?')[0]
    if (path === STATUS_PATH) {
      if (req.method !== 'GET') return (send(res, 405, { ok: false }), true)
      send(res, 200, { enabled })
      return true
    }
    if (path === SUBMIT_PATH) {
      if (req.method !== 'POST') return (send(res, 405, { ok: false }), true)
      submit(req, res).catch(() => {
        if (!res.headersSent) send(res, 500, { ok: false })
        else res.end()
      })
      return true
    }
    return false
  }

  return { accessCode, init, handle, isEnabled: () => enabled, setHeaders: (next) => Object.assign(headers, next) }
}
