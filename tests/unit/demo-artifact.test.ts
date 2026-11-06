import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashArtifact, verifyArtifact, writeManifest } from '../../scripts/demo-artifact.mjs'
import { buildContentSecurityPolicy } from '../../src/shared/csp'

// The public demo artifact gate (#191): a clean fictional build passes, and each
// way a private build could leak into the public artifact makes it fail. All
// "secrets" here are fake, built from parts so this file never contains one.

const csp = buildContentSecurityPolicy({ mode: 'production', forMetaTag: true }).replace(/'/g, '&#39;')
const html = (extraHead = '') =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">${extraHead}` +
  `<script type="module" crossorigin src="./assets/index-abc.js"></script><link rel="stylesheet" href="./assets/index-abc.css"></head><body><div id="root"></div></body></html>`
const cleanJs = 'const ns="http://www.w3.org/2000/svg";console.log("fictional demo",ns);'
const SHA = 'a'.repeat(40)

let dir: string
const put = (path: string, content: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), content)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-demo-artifact-'))
  put('index.html', html())
  put('assets/index-abc.js', cleanJs)
  put('assets/index-abc.css', 'body{margin:0}')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('passes a clean fictional artifact, with and without a manifest', () => {
  expect(verifyArtifact(dir)).toEqual([])
  const manifest = writeManifest(dir, { sha: SHA, version: '0.1.0+aaaaaaa', builtAt: '2026-11-06T00:00:00Z' })
  expect(verifyArtifact(dir, { expectDigest: manifest.digest })).toEqual([])
  expect(Object.keys(manifest.files)).toEqual(['assets/index-abc.css', 'assets/index-abc.js', 'index.html'])
})

it('gives the same digest for the same files', () => {
  const first = hashArtifact(dir).digest
  writeManifest(dir, { sha: SHA, version: 'x', builtAt: 'y' })
  expect(hashArtifact(dir).digest).toBe(first)
})

describe('fails the gate when the artifact', () => {
  const fails = (expected: RegExp) => {
    const problems = verifyArtifact(dir)
    expect(problems.join('\n')).toMatch(expected)
  }

  it('contains a fake GitHub token', () => {
    put('assets/index-abc.js', `${cleanJs}const t="${'ghp' + '_'}${'x'.repeat(36)}";`)
    fails(/GitHub token/)
  })
  it('contains a fake private key', () => {
    put('assets/index-abc.js', `${cleanJs}/* -----BEGIN ${'PRIVATE'} KEY----- */`)
    fails(/private key/)
  })
  it('contains a Google client secret prefix', () => {
    put('assets/index-abc.js', `${cleanJs}const s="${'GOCSPX'}-fake";`)
    fails(/cloud credential/)
  })
  it('calls the private Live API or host', () => {
    put('assets/index-abc.js', `${cleanJs}fetch("https://tg.krunchymonkey.dev/api/v1/listClients")`)
    fails(/private Live host name/)
    fails(/Live API path/)
    fails(/unapproved external host tg\.krunchymonkey\.dev/)
  })
  it('contains a private LAN address', () => {
    put('assets/index-abc.js', `${cleanJs}const live="http://192.168.1.20:4190/";`)
    fails(/private IPv4 address/)
  })
  it('references an unapproved external host', () => {
    put('assets/index-abc.js', `${cleanJs}new Image().src="https://tracker.example.com/p.gif";`)
    fails(/unapproved external host tracker\.example\.com/)
  })
  it('bundles a Node server or database module', () => {
    put('assets/index-abc.js', `${cleanJs}import{DatabaseSync}from"node:sqlite";`)
    fails(/Node server module/)
    fails(/database driver/)
  })
  it('includes a database, backup, env, source map or server file', () => {
    put('research.db', 'SQLite format 3')
    put('research.db-wal', '')
    put('backup.tgbackup', '')
    put('.env', 'TOKEN=fake')
    put('assets/index-abc.js.map', '{}')
    put('server/main.mjs', 'export {}')
    const problems = verifyArtifact(dir).join('\n')
    for (const file of ['research.db', 'research.db-wal', 'backup.tgbackup', '.env', 'assets/index-abc.js.map', 'server/main.mjs']) {
      expect(problems).toContain(`${file}: file type or location is not allowed`)
    }
  })
  it('points at a source map', () => {
    put('assets/index-abc.js', `${cleanJs}\n//# ${'sourceMappingURL'}=index.js.map`)
    fails(/source map reference/)
  })
  it('reads runtime environment variables', () => {
    put('assets/index-abc.js', `${cleanJs}const u=process.env.LIVE_URL;`)
    fails(/runtime environment lookup/)
  })
  it('has a relaxed or missing CSP', () => {
    put('index.html', html().replace('connect-src &#39;none&#39;', 'connect-src &#39;self&#39;'))
    fails(/connect-src 'none'/)
    put('index.html', '<!doctype html><html><head></head><body></body></html>')
    fails(/no Content-Security-Policy/)
  })
  it('turns on the Live link or the private feedback relay', () => {
    put('index.html', html('<meta name="tg-live-url" content="http://10.0.0.5:4190/"><meta name="tg-feedback" content="available">'))
    fails(/tg-live-url/)
    fails(/tg-feedback/)
  })
  it('loads a script from outside its assets', () => {
    put('index.html', html('<script src="https://cdn.example.net/x.js"></script>'))
    fails(/loads https:\/\/cdn\.example\.net\/x\.js from outside/)
  })
  it('was changed after its manifest was written, or is not the promoted digest', () => {
    const { digest } = writeManifest(dir, { sha: SHA, version: 'x', builtAt: 'y' })
    put('assets/index-abc.js', `${cleanJs}/* changed */`)
    expect(verifyArtifact(dir).join('\n')).toMatch(/does not match the files/)
    expect(verifyArtifact(dir, { expectDigest: digest }).join('\n')).toMatch(/is not the promoted digest/)
  })
  it('has a manifest without a full source SHA', () => {
    writeManifest(dir, { sha: 'abc1234', version: 'x', builtAt: 'y' })
    fails(/sourceSha is not a full Git SHA/)
  })
})

it('the committed CSP helper still produces connect-src none for the demo', () => {
  expect(readFileSync(join(__dirname, '../../vite.demo.config.ts'), 'utf8')).toContain("buildContentSecurityPolicy({ mode: 'production', forMetaTag: true })")
  expect(buildContentSecurityPolicy({ mode: 'production', forMetaTag: true })).toContain("connect-src 'none'")
})
