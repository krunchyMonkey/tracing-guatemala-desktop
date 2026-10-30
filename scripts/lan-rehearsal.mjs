// Phase 2.5 home-network (LAN) rehearsal (#138, engineering side). Run after `npm run web:build`:
//   npm run lan:rehearsal
// Drives the BUILT Live host (dist-web/server/main.mjs) as the owner would: the
// command-line refusals, the exact listener addresses, device pairing over HTTP,
// host-only refusals, turning home-network access off, restart and rollback to
// localhost-only. It prints PASS, FAIL, SKIP or MANUAL per step. MANUAL steps need
// a person with real devices on a real network and are never reported as PASS.
// Fictional data only, in throwaway folders that are removed at the end; this
// computer's own private address is discovered at run time and never printed.
// This is engineering evidence over ONE machine. It does not prove network
// isolation, guest-network refusal or Wi-Fi behaviour, and it is NOT researcher
// approval (#21). Exits non-zero when any step fails.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const hostFile = join(root, 'dist-web', 'server', 'main.mjs')
if (!existsSync(hostFile)) {
  console.error('The Live host is not built: run `npm run web:build` first.')
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'tg-lan-rehearsal-'))
const profile = join(work, 'profile')
const fakeHome = join(work, 'home')
const running = new Set()
const results = { pass: 0, fail: 0, manual: 0, skip: 0 }
let number = 0

const interfaces = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
const privateAddresses = interfaces
  .filter((e) => e.family === 'IPv4' && !e.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(e.address))
  .map((e) => e.address)
const lanIp = privateAddresses.find((address) => privateAddresses.filter((a) => a === address).length === 1)
const notOurs = ['10.254.254.254', '192.168.254.254', '172.31.254.254'].find((a) => !interfaces.some((e) => e.address === a))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function step(name, fn) {
  number += 1
  const label = String(number).padStart(2, '0')
  try {
    await fn()
    results.pass += 1
    console.log(`PASS  ${label} ${name}`)
  } catch (error) {
    results.fail += 1
    console.log(`FAIL  ${label} ${name}\n        ${(error instanceof Error ? error.message : String(error)).replace(/\n/g, '\n        ')}`)
  }
}

function skip(name, why) {
  number += 1
  results.skip += 1
  console.log(`SKIP  ${String(number).padStart(2, '0')} ${name} (${why})`)
}

/** Something this script cannot check without real devices or a person. */
function manual(name) {
  number += 1
  results.manual += 1
  console.log(`MANUAL ${String(number).padStart(2, '0')} ${name}`)
}

function freePort() {
  return new Promise((ready, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ready(port))
    })
  })
}

async function freePortPair() {
  for (let i = 0; i < 50; i++) {
    const port = await freePort()
    const free = (host, p) =>
      new Promise((done) => {
        const probe = createServer()
        probe.once('error', () => done(false))
        probe.listen(p, host, () => probe.close(() => done(true)))
      })
    if ((await free('127.0.0.1', port)) && (await free('127.0.0.1', port + 1)) && (!lanIp || ((await free(lanIp, port)) && (await free(lanIp, port + 1))))) return port
  }
  throw new Error('no free port pair')
}

function connects(host, port) {
  return new Promise((done) => {
    const socket = connect({ host, port })
    const finish = (ok) => {
      socket.destroy()
      done(ok)
    }
    socket.setTimeout(1_000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

// ---------- the host process ----------

/** The environment makes "your default data folder" a throwaway folder, so nothing real can be touched. */
const hostEnv = () => ({
  ...process.env,
  APPDATA: fakeHome,
  XDG_CONFIG_HOME: fakeHome,
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  TG_TEST_HOOKS: '',
  TG_TEST_RESOLVE: ''
})

function spawnHost(args) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', hostFile, ...args], { cwd: root, env: hostEnv() })
  const host = { child, output: '' }
  running.add(child)
  child.once('exit', () => running.delete(child))
  const onData = (chunk) => (host.output += chunk.toString())
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  host.exited = new Promise((done) => child.once('exit', (code) => done(code)))
  return host
}

/** Runs the host expecting it to refuse: exits non-zero, says why, never prints a launch link. */
async function expectRefusal(args, message) {
  const host = spawnHost(args)
  const code = await Promise.race([host.exited, new Promise((done) => setTimeout(() => done('timeout'), 15_000))])
  if (code === 'timeout') host.child.kill()
  assert(code !== 'timeout', `the host did not exit:\n${host.output}`)
  assert(code !== 0, 'the host should have refused but exited normally')
  assert(message.test(host.output), `expected ${message} in:\n${host.output}`)
  assert(!/launch\?token=/.test(host.output), 'a launch link was printed by a refused start')
  assert(!/Home network \(opt-in\)/.test(host.output), 'a refused start printed the home-network banner')
}

async function startHost(port, extra = []) {
  const host = spawnHost(['--port', String(port), '--data-dir', profile, ...extra])
  host.port = port
  host.origin = `http://127.0.0.1:${port}`
  host.launchUrl = await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`the host did not start in time:\n${host.output}`)), 20_000)
    const check = () => {
      const match = /http:\/\/127\.0\.0\.1:\d+\/launch\?token=[\w-]+/.exec(host.output)
      if (match && host.output.includes('Press Ctrl+C to stop')) {
        clearTimeout(timer)
        ready(match[0])
      }
    }
    host.child.stdout.on('data', check)
    host.child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`the host exited with ${code}:\n${host.output}`))
    })
  })
  return host
}

async function stopHost(host) {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return
  const exited = new Promise((done) => host.child.once('exit', done))
  host.child.kill()
  await exited
}

// ---------- HTTP as the host's browser and a device's browser ----------

async function signIn(host) {
  const launch = await fetch(host.launchUrl, { redirect: 'manual' })
  assert(launch.status === 303, `launch link answered ${launch.status}, expected 303`)
  const cookie = launch.headers.get('set-cookie')?.split(';')[0]
  assert(cookie, 'launch link did not set a session cookie')
  const session = await (await fetch(`${host.origin}/api/v1/session`, { headers: { Cookie: cookie } })).json()
  assert(session.authenticated && session.csrfToken, 'session is not signed in')
  return { host, cookie, csrf: session.csrfToken }
}

/** A raw request to an address and port, with full control of the headers (fetch refuses to set Host). */
function raw(address, port, method, path, headers = {}, body) {
  return new Promise((done, fail) => {
    const req = request({ host: address, port, method, path, agent: false, setHost: false, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', fail)
    req.end(body)
  })
}

const json = (headers = {}) => ({ 'Content-Type': 'application/json', ...headers })

async function hostCall(signed, name, ...args) {
  const r = await raw('127.0.0.1', signed.host.port, 'POST', `/api/v1/call/${name}`, json({ Host: `127.0.0.1:${signed.host.port}`, Origin: signed.host.origin, Cookie: signed.cookie, 'X-TG-CSRF': signed.csrf }), JSON.stringify({ args }))
  return { status: r.status, body: r.text ? JSON.parse(r.text) : null }
}

async function hostResult(signed, name, ...args) {
  const r = await hostCall(signed, name, ...args)
  assert(r.status === 200, `${name} answered ${r.status}: ${JSON.stringify(r.body)}`)
  return r.body.result
}

const lanHost = (port) => `${lanIp}:${port}`
const lanOrigin = (port) => `http://${lanHost(port)}`

/** The device's browser: enroll with a code, then read the session. */
async function enroll(port, code, deviceName = 'Rehearsal tablet') {
  const r = await raw(lanIp, port, 'POST', '/api/v1/lan/enroll', json({ Host: lanHost(port), Origin: lanOrigin(port) }), JSON.stringify({ code, deviceName }))
  assert(r.status === 200, `enroll answered ${r.status}: ${r.text}`)
  const cookie = String(r.headers['set-cookie']?.[0]).split(';')[0]
  const session = JSON.parse((await raw(lanIp, port, 'GET', '/api/v1/session', { Host: lanHost(port), Cookie: cookie })).text)
  assert(session.authenticated === true && session.csrfToken && session.remote === true, 'the device session is not signed in')
  return { port, cookie, csrf: session.csrfToken }
}

async function deviceCall(device, name, ...args) {
  const r = await raw(
    lanIp,
    device.port,
    'POST',
    `/api/v1/call/${name}`,
    json({ Host: lanHost(device.port), Origin: lanOrigin(device.port), Cookie: device.cookie, 'X-TG-CSRF': device.csrf }),
    JSON.stringify({ args })
  )
  return { status: r.status, body: r.text ? JSON.parse(r.text) : null, headers: r.headers }
}

const everyone = { text: '', status: 'all', sources: [], sort: 'name' }
const clientInput = (displayName, username) => ({
  displayName,
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: username,
  email: null,
  otherContact: null,
  preferredContactChannel: 'fiverr'
})

// ---------- the rehearsal ----------

let host = null
try {
  console.log('Phase 2.5 LAN rehearsal: fictional data, one machine, plain HTTP. Addresses are not printed.\n')

  // --- command-line refusals: nothing starts, nothing is written ---
  const port0 = await freePortPair()
  let refusals = 0
  const fixedArgs = (address) => ['--port', String(port0), '--data-dir', join(work, `refused-${refusals++}`), '--init-lan-test-profile', '--lan-host', address]
  await step('CLI refuses a public address (8.8.8.8)', () => expectRefusal(fixedArgs('8.8.8.8'), /not a home-network address/))
  await step('CLI refuses 0.0.0.0 (every network)', () => expectRefusal(fixedArgs('0.0.0.0'), /every network/))
  await step('CLI refuses a loopback address (127.0.0.1)', () => expectRefusal(fixedArgs('127.0.0.1'), /this computer only/))
  await step('CLI refuses a name instead of an address (localhost)', () => expectRefusal(fixedArgs('localhost'), /not an IPv4 address/))
  if (notOurs) await step('CLI refuses a private address that is not this computer’s', () => expectRefusal(fixedArgs(notOurs), /not an address of this computer/))
  else skip('CLI refuses a private address that is not this computer’s', 'every test address belongs to this computer')
  if (lanIp) {
    await step('CLI refuses the default data folder', () => expectRefusal(['--port', String(port0), '--lan-host', lanIp], /can't be used with your default data folder/))
    const unmarked = join(work, 'unmarked')
    await step('CLI refuses a folder that is not marked as a fictional test profile', async () => {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(unmarked, { recursive: true })
      writeFileSync(join(unmarked, 'something.txt'), 'not a profile')
      await expectRefusal(['--port', String(port0), '--data-dir', unmarked, '--lan-host', lanIp], /isn't marked as a fictional test profile/)
      assert(!existsSync(join(unmarked, 'lan-test-profile.json')), 'a refused start must not mark the folder')
      assert(!existsSync(join(unmarked, 'data')), 'a refused start must not create data')
    })
    await step('CLI refuses to mark a folder that already has files in it (--init-lan-test-profile)', async () => {
      await expectRefusal(['--port', String(port0), '--data-dir', unmarked, '--init-lan-test-profile', '--lan-host', lanIp], /only works on a folder that doesn't exist yet or is empty/)
    })
    await step('nothing listens after the refusals', async () => {
      for (const address of ['127.0.0.1', lanIp]) assert(!(await connects(address, port0)), `something listens on ${address === lanIp ? 'the LAN address' : address}:${port0}`)
    })
  } else {
    for (const name of ['CLI refuses the default data folder', 'CLI refuses an unmarked folder', 'CLI refuses to mark a non-empty folder']) skip(name, 'this computer has no private IPv4 address')
  }

  if (!lanIp) {
    skip('Start, pair, host-only refusals, disable, restart and rollback', 'this computer has no private IPv4 address')
  } else {
    // --- start on a fictional test profile ---
    const port = await freePortPair()
    host = await startHost(port, ['--init-lan-test-profile', '--lan-host', lanIp])
    await step('start on a new fictional test profile: banner names the LAN address, HTTP warning and fictional-only', () => {
      assert(host.output.includes(`${lanOrigin(port)}/`), 'the LAN address is not announced')
      assert(host.output.includes('UNENCRYPTED HTTP') && host.output.includes('FICTIONAL TEST'), 'the unencrypted/fictional warning is missing')
      assert(host.output.includes('Prepared a fictional-test-data profile'), 'the profile was not prepared')
      assert(existsSync(join(profile, 'lan-test-profile.json')), 'the marker file is missing')
    })
    await step('the private launch link is for this computer only (127.0.0.1) and the LAN address does not take it', async () => {
      assert(host.launchUrl.startsWith(`http://127.0.0.1:${port}/launch?token=`), 'the launch link is not a loopback link')
      const path = new URL(host.launchUrl).pathname + new URL(host.launchUrl).search
      const r = await raw(lanIp, port, 'GET', path, { Host: lanHost(port) })
      assert(r.status === 404 && !r.headers['set-cookie'], `LAN /launch answered ${r.status}`)
    })
    await step('exact listeners: the LAN address on the port, loopback on the port; nothing else', async () => {
      assert(await connects(lanIp, port), 'the LAN address does not accept connections')
      assert(await connects('127.0.0.1', port), 'loopback does not accept connections')
      assert(!(await connects(lanIp, port + 1)), 'the LAN address listens on port + 1 although no --lan-demo-name was given')
      const others = interfaces.filter((e) => e.address !== lanIp && e.address !== '127.0.0.1' && !(e.family === 'IPv6' && e.address.startsWith('fe80'))).map((e) => e.address)
      for (const address of ['127.0.0.2', '::1', ...others]) assert(!(await connects(address, port)), 'a listener answers on an address that is not the LAN address or 127.0.0.1 (wildcard bind?)')
    })

    const signed = await signIn(host)
    let device = null
    await step('pairing: the host shows a code, the device enrolls over HTTP with a session cookie', async () => {
      const { code } = await hostResult(signed, 'createPairingCode')
      assert(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), 'the code has an unexpected shape')
      device = await enroll(port, code)
      const devices = await hostResult(signed, 'listDevices')
      assert(devices.length === 1 && devices[0].name === 'Rehearsal tablet', 'the host does not list the device')
      const replay = await raw(lanIp, port, 'POST', '/api/v1/lan/enroll', json({ Host: lanHost(port), Origin: lanOrigin(port) }), JSON.stringify({ code }))
      assert(replay.status === 401, 'a used code was accepted again')
    })
    await step('the device creates fictional data that the host sees (one SQLite)', async () => {
      const made = await deviceCall(device, 'createClient', clientInput('Ana Ejemplo', 'fictional_lan_01'))
      assert(made.status === 200 && made.body.result.ok === true, `createClient answered ${made.status}`)
      const names = (await hostResult(signed, 'listClients', everyone)).map((c) => c.displayName)
      assert(JSON.stringify(names) === '["Ana Ejemplo"]', 'the host does not see the device’s client')
    })
    await step('wrong Host, missing Origin, foreign Origin, no session: 421 / 403 / 403 / 401; no CORS or cookie headers', async () => {
      const body = JSON.stringify({ args: [everyone] })
      const headers = json({ Origin: lanOrigin(port), Cookie: device.cookie, 'X-TG-CSRF': device.csrf })
      const cases = [
        ['wrong Host', { ...headers, Host: `attacker.example:${port}` }, 421],
        ['no port in Host', { ...headers, Host: lanIp }, 421],
        ['foreign Origin', { ...headers, Host: lanHost(port), Origin: 'http://attacker.example' }, 403],
        ['Origin: null', { ...headers, Host: lanHost(port), Origin: 'null' }, 403],
        ['missing Origin', { 'Content-Type': 'application/json', Host: lanHost(port), Cookie: device.cookie, 'X-TG-CSRF': device.csrf }, 403],
        ['no session', json({ Host: lanHost(port), Origin: lanOrigin(port) }), 401]
      ]
      for (const [label, h, expected] of cases) {
        const r = await raw(lanIp, port, 'POST', '/api/v1/call/listClients', h, body)
        assert(r.status === expected, `${label}: ${r.status}, expected ${expected}`)
        assert(!r.text.includes('Ana Ejemplo'), `${label}: data in the body`)
        assert(!Object.keys(r.headers).some((k) => k.startsWith('access-control-')), `${label}: CORS headers`)
      }
      const preflight = await raw(lanIp, port, 'OPTIONS', '/api/v1/call/listClients', { Host: lanHost(port), Origin: 'http://attacker.example', 'Access-Control-Request-Method': 'POST' })
      assert(!Object.keys(preflight.headers).some((k) => k.startsWith('access-control-')), 'preflight got CORS headers')
    })
    await step('host-only refusals from the device: backups, device administration, disableLan (403 host-only)', async () => {
      for (const name of ['createBackup', 'restoreBackup', 'getBackupStatus', 'createPairingCode', 'listDevices', 'revokeAllDevices', 'disableLan']) {
        const r = await deviceCall(device, name)
        assert(r.status === 403 && r.body.error === 'host-only', `${name} answered ${r.status} ${JSON.stringify(r.body)}`)
      }
      for (const [method, path] of [
        ['POST', '/api/v1/backup/upload'],
        ['GET', '/api/v1/backup/download/x.tgbackup']
      ]) {
        const r = await raw(lanIp, port, method, path, { Host: lanHost(port), Origin: lanOrigin(port), Cookie: device.cookie, 'X-TG-CSRF': device.csrf, 'Content-Type': 'application/octet-stream' }, method === 'POST' ? 'x' : undefined)
        assert(r.status === 403, `${method} ${path} answered ${r.status}`)
      }
      assert((await deviceCall(device, 'getAppInfo')).status === 200, 'the device was signed out by the refusals')
    })
    let backupFile = null
    await step('the host can back up while LAN is on; restore and upload are refused (409) while it is on', async () => {
      const made = await hostResult(signed, 'createBackup')
      assert(made.ok === true && made.clients === 1, 'backup failed')
      backupFile = made.fileName
      const r = await hostCall(signed, 'restoreBackup', 'x'.repeat(10))
      assert(r.status === 409 && r.body.error === 'restore-disabled-while-lan', `restoreBackup answered ${r.status}`)
      const up = await raw('127.0.0.1', port, 'POST', '/api/v1/backup/upload', { Host: `127.0.0.1:${port}`, Origin: host.origin, Cookie: signed.cookie, 'X-TG-CSRF': signed.csrf, 'Content-Type': 'application/octet-stream' }, 'x')
      assert(up.status === 409, `upload answered ${up.status}`)
    })
    await step('revoke: the host revokes the device and its next call is 401', async () => {
      const [entry] = await hostResult(signed, 'listDevices')
      assert((await hostResult(signed, 'revokeDevice', entry.id)).revoked === true, 'revoke failed')
      assert((await deviceCall(device, 'getAppInfo')).status === 401, 'the revoked device still has access')
      device = await enroll(port, (await hostResult(signed, 'createPairingCode')).code)
    })
    await step('disableLan: LAN listener closes at once, devices are signed out, loopback keeps working', async () => {
      assert((await hostResult(signed, 'disableLan')).disabled === true, 'disableLan did not report disabled')
      await new Promise((done) => setTimeout(done, 300))
      assert(!(await connects(lanIp, port)), 'the LAN address still accepts connections')
      assert(JSON.stringify(await hostResult(signed, 'getLanStatus')) === '{"enabled":false,"origin":null}', 'status still says enabled')
      assert((await hostResult(signed, 'listClients', everyone)).length === 1, 'the host lost its data')
      assert(host.output.includes('Home-network access was turned off'), 'the console did not say it was turned off')
    })
    await step('after disableLan restore works again, and the restored data is intact', async () => {
      const bytes = readFileSync(join(profile, 'backups', backupFile))
      await hostResult(signed, 'createClient', clientInput('Added After Backup', 'fictional_lan_02'))
      const up = await fetch(`${host.origin}/api/v1/backup/upload`, {
        method: 'POST',
        headers: { Origin: host.origin, Cookie: signed.cookie, 'X-TG-CSRF': signed.csrf, 'Content-Type': 'application/octet-stream', 'X-TG-File-Name': encodeURIComponent(backupFile) },
        body: bytes
      })
      const choice = (await up.json()).result
      assert(up.status === 200 && choice.ok === true, `upload answered ${up.status}`)
      assert((await hostResult(signed, 'restoreBackup', choice.token)).ok === true, 'restore failed')
      const names = (await hostResult(signed, 'listClients', everyone)).map((c) => c.displayName)
      assert(JSON.stringify(names) === '["Ana Ejemplo"]', `unexpected clients after restore: ${JSON.stringify(names)}`)
    })
    await step('stop the host; the data is saved', async () => {
      await stopHost(host)
      assert(readdirSync(join(profile, 'data')).some((f) => f.endsWith('.sqlite')), 'the database file is missing')
    })

    // --- restart: devices must pair again ---
    host = await startHost(port, ['--lan-host', lanIp])
    const signed2 = await signIn(host)
    await step('restart on the same profile and port: every old device session is gone (401), the old code is dead', async () => {
      assert((await deviceCall(device, 'getAppInfo')).status === 401, 'the old device session survived a restart')
      const probe = JSON.parse((await raw(lanIp, port, 'GET', '/api/v1/session', { Host: lanHost(port), Cookie: device.cookie })).text)
      assert(probe.authenticated === false, 'the session probe still says signed in')
      assert((await hostResult(signed2, 'listDevices')).length === 0, 'the host lists a device after restart')
    })
    await step('pair again after the restart: the data from before is there for the device and the host', async () => {
      device = await enroll(port, (await hostResult(signed2, 'createPairingCode')).code)
      const seen = await deviceCall(device, 'listClients', everyone)
      assert(JSON.stringify(seen.body.result.map((c) => c.displayName)) === '["Ana Ejemplo"]', 'the device does not see the stored client')
      const names = (await hostResult(signed2, 'listClients', everyone)).map((c) => c.displayName)
      assert(JSON.stringify(names) === '["Ana Ejemplo"]', 'the host does not see the stored client')
    })
    await step('the log lines show no addresses, tokens, cookies or names', () => {
      const lines = host.output.split(/\r?\n/).filter((l) => l.startsWith('lan '))
      assert(lines.length > 0, 'no lan log lines')
      for (const line of lines) assert(/^lan (GET|POST|PUT|DELETE|OPTIONS|HEAD) \S+ \d{3}$/.test(line), `unexpected log line: ${line}`)
    })
    await stopHost(host)

    // --- rollback to localhost-only ---
    host = await startHost(port, [])
    await step('rollback: start without --lan-host; the LAN address does not connect, the data is still there on loopback', async () => {
      assert(!host.output.includes('Home network (opt-in)'), 'the banner mentions the home network')
      assert(!(await connects(lanIp, port)), 'the LAN address accepts connections without --lan-host')
      assert(!(await connects(lanIp, port + 1)), 'the LAN address accepts connections on port + 1 without --lan-host')
      const loopback = await signIn(host)
      const names = (await hostResult(loopback, 'listClients', everyone)).map((c) => c.displayName)
      assert(JSON.stringify(names) === '["Ana Ejemplo"]', 'the stored client is missing')
      assert(JSON.stringify(await hostResult(loopback, 'getLanStatus')) === '{"enabled":false,"origin":null}', 'LAN status is not off')
    })
    await stopHost(host)
    host = null
  }

  // --- what a script cannot check ---
  manual('Second physical device (phone) on the trusted home Wi-Fi: pair, use, sign out (docs/pilot/phase-2.5-lan-validation.md)')
  manual('Second physical device (tablet) on the trusted home Wi-Fi: pair, use, revoke')
  manual('A device on a guest or IoT network must fail to connect')
  manual('Host computer sleep and wake with a device paired')
  manual('Wi-Fi or DHCP address change while running, then restart with the new --lan-host')
  manual('Windows firewall prompt answered for Private networks only')
  manual('--lan-demo-name resolves on each device (router DNS or hosts file)')
  manual('Mobile browser layouts on real devices (phone and tablet)')

  console.log(`\nPhase 2.5 LAN rehearsal: ${results.pass} passed, ${results.fail} failed, ${results.skip} skipped, ${results.manual} manual.`)
  if (results.fail === 0) console.log('All automated steps passed. This is engineering evidence over one machine, not network isolation and not researcher acceptance.')
} catch (error) {
  results.fail += 1
  console.error(`\nFAIL  ${error instanceof Error ? error.stack : error}`)
  if (host) console.error(`\nHost output:\n${host.output}`)
} finally {
  for (const child of running) child.kill()
  await new Promise((done) => setTimeout(done, 300))
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
process.exit(results.fail > 0 ? 1 : 0)
