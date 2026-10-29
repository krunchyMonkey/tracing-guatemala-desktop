import { describe, expect, it } from 'vitest'
import { chooseLanHost, isPrivateIPv4, localIPv4Addresses } from '../../scripts/demo-server.mjs'

// Address rules for `npm run demo:lan` (#100): one private or loopback IPv4
// address of this computer, never every interface or a public address.

const home = { address: '192.168.1.24', name: 'Wi-Fi' }
const loopback = { address: '127.0.0.1', name: 'Loopback' }

describe('isPrivateIPv4', () => {
  it.each(['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.0.10'])('accepts %s', (address) => {
    expect(isPrivateIPv4(address)).toBe(true)
  })

  it.each(['0.0.0.0', '127.0.0.1', '172.15.0.1', '172.32.0.1', '8.8.8.8', '192.169.0.1', '192.168.1.256', 'localhost', '::1', ''])(
    'rejects %s',
    (address) => {
      expect(isPrivateIPv4(address)).toBe(false)
    }
  )
})

describe('chooseLanHost', () => {
  it('uses the only home-network address when none is requested', () => {
    expect(chooseLanHost(undefined, [loopback, home])).toEqual({ ok: true, host: '192.168.1.24' })
  })

  it('asks the owner to choose when there are several or none', () => {
    const several = chooseLanHost(undefined, [home, { address: '10.0.0.7', name: 'Ethernet' }])
    expect(several).toEqual({ ok: false, error: expect.stringMatching(/192\.168\.1\.24 \(Wi-Fi\), 10\.0\.0\.7 \(Ethernet\)/) })
    expect(chooseLanHost(undefined, [loopback])).toEqual({ ok: false, error: expect.stringMatching(/No home-network/) })
  })

  it('skips virtual machine and WSL adapters when exactly one real adapter is left', () => {
    const hyperV = { address: '172.31.128.1', name: 'vEthernet (Default Switch)' }
    const wsl = { address: '192.168.80.1', name: 'vEthernet (WSL (Hyper-V firewall))' }
    const choice = chooseLanHost(undefined, [{ address: '192.168.68.64', name: 'Ethernet' }, hyperV, wsl, loopback])
    expect(choice).toEqual({ ok: true, host: '192.168.68.64', note: expect.stringMatching(/skipped virtual adapters 172\.31\.128\.1/) })
    expect(chooseLanHost(undefined, [hyperV, wsl])).toEqual({ ok: false, error: expect.stringMatching(/^Several/) })
  })

  it('accepts a requested private address of this computer, or loopback', () => {
    expect(chooseLanHost('192.168.1.24', [loopback, home])).toEqual({ ok: true, host: '192.168.1.24' })
    expect(chooseLanHost('127.0.0.1', [home])).toEqual({ ok: true, host: '127.0.0.1' })
  })

  it.each(['0.0.0.0', '203.0.113.9', 'my-pc.local', '::'])('refuses to listen on %s', (requested) => {
    expect(chooseLanHost(requested, [loopback, home])).toEqual({ ok: false, error: expect.stringMatching(/^Refusing/) })
  })

  it('refuses a private address that belongs to another device', () => {
    expect(chooseLanHost('192.168.1.99', [loopback, home])).toEqual({
      ok: false,
      error: expect.stringMatching(/isn't an address of this computer/)
    })
  })
})

describe('localIPv4Addresses', () => {
  it('lists IPv4 addresses with their adapter names', () => {
    const v4 = { address: '192.168.1.24', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '', cidr: null }
    const v6 = { address: 'fe80::1', family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 1 }
    expect(localIPv4Addresses({ 'Wi-Fi': [v4, v6] as never })).toEqual([home])
  })
})
