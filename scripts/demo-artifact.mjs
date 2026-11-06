// Public demo artifact contract (#191): manifest + verifier for dist-demo/.
//
//   node scripts/demo-artifact.mjs manifest [dir] [--sha <git sha>]   write <dir>/demo-manifest.json
//   node scripts/demo-artifact.mjs verify   [dir] [--digest <sha256>] fail on anything unsafe
//
// The verifier is one layer. The others are the CSP (`connect-src 'none'`) and the
// browser negative tests in tests/demo/public-artifact.spec.ts. String checks can't
// prove a bundle is safe; they catch the known ways a private build could leak in.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANIFEST = 'demo-manifest.json'
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024

/** The only files a public demo artifact may contain. */
const ALLOWED_FILES = [/^index\.html$/, /^demo-manifest\.json$/, /^assets\/[A-Za-z0-9_-]+\.(js|css|png|svg|webp|woff2|ico)$/]
const TEXT_FILE = /\.(html|js|css|svg|json)$/

/** Hosts that may appear in strings (XML namespaces, library error links, input placeholders). None is ever fetched: CSP blocks it. */
export const ALLOWED_URL_HOSTS = new Set(['www.w3.org', 'react.dev', 'reactrouter.com', 'prosemirror.net', 'example.org', 'github.com', 'localhost', '127.0.0.1'])

/** [label, pattern] pairs that must never appear in any text file of the artifact. */
export const FORBIDDEN_CONTENT = [
  ['private IPv4 address', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ['private Live host name', /\btg\.krunchymonkey\.dev\b/i],
  ['Live API path', /\/api\/v\d/],
  ['Live session cookie name', /__Host-tg_|tg_session|tg_login/],
  ['Node server module', /\bnode:(?:sqlite|fs|child_process|net|http|https|os)\b/],
  ['database driver or connection string', /\bDatabaseSync\b|better-sqlite3|\bpostgres(?:ql)?:\/\/|\bsqlite3\b/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['cloud credential', /\bAKIA[0-9A-Z]{16}\b|\bGOCSPX-|apps\.googleusercontent\.com|\bxox[abprs]-/],
  ['credential variable name', /CLOUDFLARE_API_TOKEN|GITHUB_TOKEN|client_secret|TG_FEEDBACK_TOKEN/],
  ['runtime environment lookup', /\bprocess\.env\b|import\.meta\.env\.(?!MODE|DEV|PROD|SSR|BASE_URL)/],
  ['local filesystem path', /[A-Za-z]:\\\\?Users\\\\?|\/Users\/[A-Za-z]|\/home\/runner\//],
  ['source map reference', /sourceMappingURL=/]
]

function listFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(relative(dir, full).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** Content hashes of every file except the manifest, plus one digest over them. */
export function hashArtifact(dir) {
  const files = Object.fromEntries(listFiles(dir).filter((f) => f !== MANIFEST).map((f) => [f, sha256(readFileSync(join(dir, f)))]))
  const digest = sha256(Object.entries(files).map(([f, h]) => `${f}\t${h}\n`).join(''))
  return { files, digest }
}

export function writeManifest(dir, { sha, version, builtAt }) {
  const { files, digest } = hashArtifact(dir)
  const manifest = { schema: 'tg-demo-artifact/1', name: 'tracing-guatemala-public-demo', version, sourceSha: sha, builtAt, digest, files }
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

const decodeEntities = (html) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/** Every reason the artifact in `dir` is unsafe to publish. Empty means it passed. */
export function verifyArtifact(dir, { expectDigest } = {}) {
  const problems = []
  const files = listFiles(dir)
  let total = 0

  for (const file of files) {
    total += statSync(join(dir, file)).size
    if (!ALLOWED_FILES.some((rule) => rule.test(file))) problems.push(`${file}: file type or location is not allowed in the public demo`)
  }
  if (total > MAX_TOTAL_BYTES) problems.push(`artifact is ${total} bytes, over the ${MAX_TOTAL_BYTES} byte limit`)
  if (!files.includes('index.html')) problems.push('index.html is missing')

  for (const file of files.filter((f) => TEXT_FILE.test(f) && f !== MANIFEST)) {
    const text = readFileSync(join(dir, file), 'utf8')
    for (const [label, pattern] of FORBIDDEN_CONTENT) {
      const match = pattern.exec(text)
      if (match) problems.push(`${file}: contains a ${label} (${JSON.stringify(match[0].slice(0, 40))})`)
    }
    for (const match of text.matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g)) {
      if (!ALLOWED_URL_HOSTS.has(match[1].toLowerCase())) problems.push(`${file}: references an unapproved external host ${match[1]}`)
    }
  }

  if (files.includes('index.html')) {
    const html = decodeEntities(readFileSync(join(dir, 'index.html'), 'utf8'))
    const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html)?.[1]
    if (!csp) problems.push('index.html: no Content-Security-Policy meta tag')
    else {
      const directive = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `))
      if (directive('connect-src') !== "connect-src 'none'") problems.push(`index.html: CSP must be connect-src 'none' (found ${directive('connect-src') ?? 'nothing'})`)
      if (directive('default-src') !== "default-src 'none'") problems.push("index.html: CSP must be default-src 'none'")
      if (directive('script-src') !== "script-src 'self'") problems.push("index.html: CSP must be script-src 'self'")
    }
    if (/name="tg-live-url"/.test(html)) problems.push('index.html: has a tg-live-url meta (links to a Live host)')
    if (/name="tg-feedback"/.test(html)) problems.push('index.html: has a tg-feedback meta (enables the private feedback relay)')
    for (const [, src] of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      if (!src.startsWith('./assets/')) problems.push(`index.html: loads ${src} from outside ./assets/`)
    }
  }

  if (files.includes(MANIFEST)) {
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
    const { files: actual, digest } = hashArtifact(dir)
    if (manifest.digest !== digest || JSON.stringify(manifest.files) !== JSON.stringify(actual)) problems.push(`${MANIFEST}: does not match the files (manifest ${manifest.digest}, actual ${digest})`)
    if (!/^[0-9a-f]{40}$/.test(manifest.sourceSha ?? '')) problems.push(`${MANIFEST}: sourceSha is not a full Git SHA`)
    if (expectDigest && digest !== expectDigest) problems.push(`artifact digest ${digest} is not the promoted digest ${expectDigest}`)
  } else if (expectDigest) problems.push(`${MANIFEST} is missing, so the promoted digest can't be checked`)

  return problems
}

function main(argv) {
  const [command, ...rest] = argv
  const flag = (name) => {
    const i = rest.indexOf(name)
    return i >= 0 ? rest.splice(i, 2)[1] : undefined
  }
  const sha = flag('--sha')
  const expectDigest = flag('--digest')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const dir = resolve(rest[0] ?? join(root, 'dist-demo'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

  if (command === 'manifest') {
    const sourceSha = sha ?? git('rev-parse', 'HEAD')
    // The commit time, not the wall clock, so a rebuild of the same commit gives the same manifest.
    const builtAt = git('show', '-s', '--format=%cI', sourceSha)
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const manifest = writeManifest(dir, { sha: sourceSha, version: `${version}+${sourceSha.slice(0, 7)}`, builtAt })
    console.log(`Wrote ${MANIFEST}: ${Object.keys(manifest.files).length} files, digest ${manifest.digest}, source ${manifest.sourceSha}`)
    return 0
  }
  if (command === 'verify') {
    const problems = verifyArtifact(dir, { expectDigest })
    if (problems.length) {
      console.error(`Public demo artifact FAILED verification (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`)
      return 1
    }
    console.log(`Public demo artifact passed verification: ${hashArtifact(dir).digest}`)
    return 0
  }
  console.error('Usage: demo-artifact.mjs manifest|verify [dir] [--sha <sha>] [--digest <sha256>]')
  return 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
