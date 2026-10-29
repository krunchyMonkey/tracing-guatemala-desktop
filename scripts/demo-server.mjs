import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'

// Serves the built browser demo (dist-demo/) over plain HTTP for the trusted home
// LAN (#100). It binds to one private (or loopback) IPv4 address of this
// computer, never to every interface, and keeps Vite's host check and CORS
// defaults. Used by scripts/demo-lan.mjs and the browser E2E tests.

export const DEFAULT_PORT = 4173
export const demoDir = fileURLToPath(new URL('../dist-demo/', import.meta.url))
const configFile = fileURLToPath(new URL('../vite.demo.config.ts', import.meta.url))

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function octets(address) {
  const match = IPV4.exec(address)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every((n) => n <= 255) ? parts : null
}

/** RFC 1918 home/office ranges: 10/8, 172.16/12, 192.168/16. */
export function isPrivateIPv4(address) {
  const o = octets(address)
  if (!o) return false
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)
}

export function isLoopbackIPv4(address) {
  return octets(address)?.[0] === 127
}

/** This computer's IPv4 addresses, as { address, name } (name is the network adapter). */
export function localIPv4Addresses(interfaces = networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? []).filter((e) => e.family === 'IPv4' || e.family === 4).map((e) => ({ address: e.address, name }))
  )
}

// Adapters that virtual machines, WSL and containers add; never the home network.
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|vboxnet|VMware|vmnet|docker|br-|virbr|Loopback/i

/**
 * Picks the address to bind. With `requested`, it must be a private or loopback
 * IPv4 address of this computer. Without it, the only private address is used
 * (ignoring virtual adapters when exactly one real one is left); with none or
 * several, the owner has to choose.
 */
export function chooseLanHost(requested, addresses = localIPv4Addresses()) {
  const lan = addresses.filter((a) => isPrivateIPv4(a.address))
  if (requested) {
    if (!isPrivateIPv4(requested) && !isLoopbackIPv4(requested)) {
      return {
        ok: false,
        error: `Refusing to listen on ${requested}. Use this computer's home-network address (10.x, 172.16-31.x or 192.168.x), or 127.0.0.1 for this computer only. Never 0.0.0.0 or a public address.`
      }
    }
    if (!isLoopbackIPv4(requested) && !addresses.some((a) => a.address === requested)) {
      return { ok: false, error: `${requested} isn't an address of this computer. Addresses found: ${describe(lan)}.` }
    }
    return { ok: true, host: requested }
  }
  if (lan.length === 1) return { ok: true, host: lan[0].address }
  const physical = lan.filter((a) => !VIRTUAL_ADAPTER.test(a.name))
  if (physical.length === 1 && lan.length > 1) {
    const skipped = lan.filter((a) => a !== physical[0])
    return { ok: true, host: physical[0].address, note: `Using ${describe(physical)}; skipped virtual adapters ${describe(skipped)}. Use --host to pick another.` }
  }
  if (lan.length === 0) {
    return {
      ok: false,
      error: 'No home-network (private) IPv4 address found. Connect to your home Wi-Fi, or use --host 127.0.0.1 for this computer only.'
    }
  }
  return { ok: false, error: `Several network addresses found: ${describe(lan)}. Choose your home network's with --host <address>.` }
}

function describe(addresses) {
  return addresses.length === 0 ? 'none' : addresses.map((a) => `${a.address} (${a.name})`).join(', ')
}

/** Starts the HTTP preview of dist-demo/. Resolves to { url, close }. */
export async function startDemoServer({ host, port = DEFAULT_PORT }) {
  if (!existsSync(join(demoDir, 'index.html'))) {
    throw new Error('dist-demo/ is missing. Run `npm run demo:build` first.')
  }
  const server = await preview({
    configFile,
    configLoader: 'runner',
    logLevel: 'warn',
    preview: { host, port, strictPort: true, open: false }
  })
  return {
    url: `http://${host}:${port}/`,
    close: () => server.close()
  }
}
