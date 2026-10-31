import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Guards the host-local HTTPS front (#166): Caddy with Cloudflare DNS-01 only,
// loopback by default, the API token read at run time and never written into
// config, and a launcher that refuses an ambiguous or missing token file.
// The real-binary checks run when TG_CADDY_BIN points at a built caddy.exe.

const dir = resolve(__dirname, '../../deploy/caddy')
const caddyfile = readFileSync(join(dir, 'Caddyfile'), 'utf8')
const launcher = readFileSync(join(dir, 'start-tg-caddy.ps1'), 'utf8')
const build = readFileSync(join(dir, 'build-caddy.ps1'), 'utf8')
const directives = caddyfile
  .split('\n')
  .map((line) => line.replace(/#.*/, '').trim())
  .filter(Boolean)

describe('deploy/caddy/Caddyfile', () => {
  it('reads the Cloudflare token at run time only', () => {
    expect(directives).toContain('dns cloudflare {env.CLOUDFLARE_API_TOKEN}')
    expect(directives.join('\n')).not.toContain('{$CLOUDFLARE_API_TOKEN')
  })

  it('uses DNS-01 only: no HTTP or TLS-ALPN challenge, no redirect listener', () => {
    expect(directives).toContain('disable_http_challenge')
    expect(directives).toContain('disable_tlsalpn_challenge')
    expect(directives).toContain('auto_https disable_redirects')
  })

  it('checks propagation with public resolvers, not the private home DNS', () => {
    expect(directives).toContain('resolvers 1.1.1.1 1.0.0.1')
  })

  it('binds loopback and proxies to the loopback proxy listener by default', () => {
    expect(directives).toContain('default_bind {$TG_BIND_HOST:127.0.0.1}')
    expect(directives).toContain('bind {$TG_BIND_HOST:127.0.0.1}')
    expect(directives).toContain('reverse_proxy {$TG_UPSTREAM:127.0.0.1:4182}')
    expect(directives.join('\n')).not.toMatch(/0\.0\.0\.0|\[::\]/)
  })

  it('keeps the admin API on localhost', () => {
    expect(directives).toContain('admin localhost:2019')
  })

  it('contains no LAN address and nothing token-shaped', () => {
    for (const text of [caddyfile, launcher, build]) {
      expect(text).not.toMatch(/\b(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+(\.\d+)?\b/)
      expect(text).not.toMatch(/\b[A-Za-z0-9_-]{40,}\b(?<![0-9a-f]{64})/)
    }
  })
})

describe('deploy/caddy build and launcher', () => {
  it('pins every build input', () => {
    expect(build).toMatch(/\$GoVersion = 'go\d+\.\d+\.\d+'/)
    expect(build).toMatch(/\$GoSha256 = '[0-9a-f]{64}'/)
    expect(build).toMatch(/\$XcaddyVersion = 'v\d+\.\d+\.\d+'/)
    expect(build).toMatch(/\$CaddyVersion = 'v\d+\.\d+\.\d+'/)
    expect(build).toMatch(/\$CloudflareModule = 'github\.com\/caddy-dns\/cloudflare@v\d+\.\d+\.\d+'/)
  })

  it('never prints the token and clears it when Caddy stops', () => {
    const tokenLines = launcher.split('\n').filter((line) => line.includes('CLOUDFLARE_API_TOKEN'))
    expect(tokenLines.some((line) => /Write-(Host|Output)|echo|Out-File|Set-Content/.test(line))).toBe(false)
    expect(launcher).toMatch(/finally \{\s*Remove-Item Env:CLOUDFLARE_API_TOKEN/)
  })
})

const pwsh = process.platform === 'win32' ? spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0 : false

describe.skipIf(!pwsh)('start-tg-caddy.ps1 refusals', () => {
  let secretDir: string | null = null
  afterEach(() => {
    if (secretDir) rmSync(secretDir, { recursive: true, force: true })
    secretDir = null
  })

  function run(files: string[]): { status: number | null; output: string } {
    secretDir = mkdtempSync(join(tmpdir(), 'tg-caddy-secret-'))
    for (const name of files) writeFileSync(join(secretDir, name), 'fictional-not-a-token')
    const result = spawnSync('pwsh', ['-NoProfile', '-File', join(dir, 'start-tg-caddy.ps1'), '-SecretDir', secretDir, '-Validate'], { encoding: 'utf8' })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  }

  it('refuses a folder with no token file', () => {
    const { status, output } = run([])
    expect(status).not.toBe(0)
    expect(output).toContain('found 0.')
    expect(output).toContain('Not starting.')
  })

  it('refuses a folder with more than one token file', () => {
    const { status, output } = run(['a.txt', 'b.txt'])
    expect(status).not.toBe(0)
    expect(output).toContain('found 2.')
    expect(output).toContain('Not starting.')
    expect(output).not.toContain('fictional-not-a-token')
  })

  it('refuses a token file that every account can read', () => {
    secretDir = mkdtempSync(join(tmpdir(), 'tg-caddy-secret-'))
    writeFileSync(join(secretDir, 'token.txt'), 'fictional-not-a-token')
    expect(spawnSync('icacls', [secretDir, '/grant', '*S-1-5-32-545:(OI)(CI)R']).status).toBe(0)
    const result = spawnSync('pwsh', ['-NoProfile', '-File', join(dir, 'start-tg-caddy.ps1'), '-SecretDir', secretDir, '-Validate'], { encoding: 'utf8' })
    const output = `${result.stdout}${result.stderr}`
    expect(result.status).not.toBe(0)
    expect(output).toContain('is readable by BUILTIN\\Users')
    expect(output).not.toContain('fictional-not-a-token')
  })
})

const caddyBin = process.env['TG_CADDY_BIN']

describe.skipIf(!caddyBin || !existsSync(caddyBin))('Caddyfile with the real caddy binary', () => {
  const fakeToken = 'fictional-test-token-0123456789'
  const adapt = () => {
    const result = spawnSync(caddyBin!, ['adapt', '--config', join(dir, 'Caddyfile'), '--adapter', 'caddyfile'], {
      encoding: 'utf8',
      env: { ...process.env, CLOUDFLARE_API_TOKEN: fakeToken, TG_LOG_DIR: tmpdir().replace(/\\/g, '/') }
    })
    expect(result.status).toBe(0)
    return { json: result.stdout, config: JSON.parse(result.stdout) }
  }

  it('adapts without placing the token in the JSON config', () => {
    const { json } = adapt()
    expect(json).not.toContain(fakeToken)
    expect(json).toContain('{env.CLOUDFLARE_API_TOKEN}')
  })

  it('listens on loopback 443 only and issues through DNS-01 only', () => {
    const { config } = adapt()
    const servers = Object.values(config.apps.http.servers) as { listen: string[] }[]
    expect(servers.flatMap((s) => s.listen)).toEqual(['127.0.0.1:443'])
    const issuer = config.apps.tls.automation.policies[0].issuers[0]
    expect(issuer.challenges.http.disabled).toBe(true)
    expect(issuer.challenges['tls-alpn'].disabled).toBe(true)
    expect(issuer.challenges.dns.provider.name).toBe('cloudflare')
  })
})
