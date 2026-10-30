import { promises as dns } from 'node:dns'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { isDemoHostname } from '../shared/dns-name'

// Validation for the opt-in home-network listener (#135). The address must be
// given explicitly and must be one private IPv4 address that belongs to exactly
// one network adapter of this computer. Nothing is ever guessed or auto-picked,
// and there is no wildcard bind.

export type Octets = [number, number, number, number]

/** Strict dotted quad: four decimal parts, digits only, no leading zeros, no spaces. */
export function parseIPv4(value: string): Octets | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    octets.push(n)
  }
  return octets as Octets
}

/** RFC 1918 only: 10/8, 172.16/12 and 192.168/16. */
export function isPrivateIPv4(value: string): boolean {
  const o = parseIPv4(value)
  if (!o) return false
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)
}

export type LanHostCheck = { ok: true; address: string; interfaceName: string } | { ok: false; error: string }

/** Thrown when the requested home-network address is refused. The message is safe to show. */
export class LanHostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LanHostError'
  }
}

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>

function privateAddresses(interfaces: Interfaces): { address: string; name: string }[] {
  return Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((e) => (e.family === 'IPv4' || (e.family as unknown) === 4) && !e.internal && isPrivateIPv4(e.address))
      .map((e) => ({ address: e.address, name }))
  )
}

export function validateLanHost(requested: string, interfaces: Interfaces = networkInterfaces()): LanHostCheck {
  const refuse = (error: string): LanHostCheck => ({ ok: false, error })
  const o = parseIPv4(requested)
  if (!o) {
    return refuse(`"${requested.slice(0, 60)}" is not an IPv4 address. Give this computer's home-network address as four numbers, like 192.168.1.20.`)
  }
  if (o.every((n) => n === 0)) return refuse('0.0.0.0 would listen on every network. Give one specific home-network address instead.')
  if (o[0] === 127) {
    return refuse('127.0.0.1 is this computer only, which plain `npm run live` already is. Leave out --lan-host, or give the home-network address.')
  }
  if (o[0] === 169 && o[1] === 254) return refuse(`${requested} is a link-local address, not a home-network address.`)
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return refuse(`${requested} is a carrier-grade NAT address, not a home-network address.`)
  if (!isPrivateIPv4(requested)) {
    return refuse(`${requested} is not a home-network address. Use 10.x.x.x, 172.16 to 172.31.x.x or 192.168.x.x. Public addresses are never allowed.`)
  }

  const found = privateAddresses(interfaces)
  const matches = Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? []).filter((e) => (e.family === 'IPv4' || (e.family as unknown) === 4) && !e.internal && e.address === requested).map(() => name)
  )
  if (matches.length === 0) {
    const list = found.length ? found.map((a) => `${a.address} (${a.name})`).join(', ') : 'none'
    return refuse(`${requested} is not an address of this computer. Home-network addresses found: ${list}. If the computer's network address changed, restart with the new --lan-host address; paired devices pair again.`)
  }
  if (matches.length > 1) {
    return refuse(
      `${requested} appears on more than one network adapter (${matches.join(', ')}), so it is unclear which network would be exposed. Nothing was started.`
    )
  }
  return { ok: true, address: requested, interfaceName: matches[0]! }
}

// The LAN demo (#137) must be a different *site* from the Live address, and
// cookies ignore ports, so it is reached by a DNS name that points at this
// computer. The name is checked for syntax and must resolve to the LAN address.

/** Looks a name up as IPv4 addresses. Test-only injection replaces it. */
export type LanDemoResolve = (name: string) => Promise<string[]>

const systemResolve: LanDemoResolve = async (name) => (await dns.lookup(name, { all: true, family: 4 })).map((entry) => entry.address)

export function validateLanDemoName(requested: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = requested.trim().toLowerCase()
  if (!isDemoHostname(name)) {
    return {
      ok: false,
      error: `"${requested.slice(0, 80)}" can't be used as a demo name. Use a host name such as tg-demo.home.arpa (letters, digits and hyphens, at least one dot; not an IP address, not localhost).`
    }
  }
  return { ok: true, name }
}

/** Resolves `name` and requires the LAN address among the answers; returns an error message or null. */
export async function checkLanDemoResolves(name: string, address: string, resolve: LanDemoResolve = systemResolve): Promise<string | null> {
  let found: string[]
  try {
    found = await resolve(name)
  } catch {
    return `${name} does not resolve to an address. Add it to your router's DNS or this network's hosts file, pointing at ${address}.`
  }
  if (!found.includes(address)) {
    return `${name} resolves to ${found.length ? found.join(', ') : 'nothing'}, not to ${address}. Point it at ${address}.`
  }
  return null
}
