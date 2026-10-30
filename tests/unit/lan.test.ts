import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { isPrivateIPv4, parseIPv4, validateLanHost } from '../../src/server/lan'

// Home-network address validation (#135) with injected adapters. Fictional addresses only.

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` }
}

const adapters = (): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
  Loopback: [v4('127.0.0.1', true)],
  Ethernet: [v4('192.168.1.20'), v4('172.16.0.5'), v4('172.31.255.9'), v4('169.254.8.8')],
  Wifi: [v4('10.4.0.7'), v4('172.15.0.1'), v4('172.32.0.1'), v4('100.64.0.1'), v4('8.8.8.8')],
  Docker: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:01', internal: false, cidr: 'fe80::1/64', scopeid: 1 }]
})

describe('parseIPv4', () => {
  it.each(['192.168.1', '192.168.01.5', '192.168.1.256', ' 192.168.1.5', '192.168.1.5 ', '1.2.3.4.5', '1.2.3.-4', '0x7f.0.0.1', '1.2.3.', '', '::1'])(
    'rejects %j',
    (value) => expect(parseIPv4(value)).toBeNull()
  )
  it('accepts strict dotted quads', () => {
    expect(parseIPv4('192.168.1.20')).toEqual([192, 168, 1, 20])
    expect(parseIPv4('0.0.0.0')).toEqual([0, 0, 0, 0])
  })
})

describe('isPrivateIPv4', () => {
  it.each(['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1'])('accepts %s', (a) => expect(isPrivateIPv4(a)).toBe(true))
  it.each(['172.15.0.1', '172.32.0.1', '100.64.0.1', '8.8.8.8', '127.0.0.1', '169.254.1.1', '192.169.0.1', 'x'])('rejects %s', (a) =>
    expect(isPrivateIPv4(a)).toBe(false)
  )
})

describe('validateLanHost', () => {
  it.each([
    ['192.168.1.20', 'Ethernet'],
    ['10.4.0.7', 'Wifi'],
    ['172.16.0.5', 'Ethernet'],
    ['172.31.255.9', 'Ethernet']
  ])('accepts %s', (address, interfaceName) => {
    expect(validateLanHost(address, adapters())).toEqual({ ok: true, address, interfaceName })
  })

  it.each([
    ['172.15.0.1', /not a home-network address/],
    ['172.32.0.1', /not a home-network address/],
    ['0.0.0.0', /every network/],
    ['127.0.0.1', /this computer only/],
    ['169.254.1.1', /link-local/],
    ['169.254.8.8', /link-local/],
    ['100.64.0.1', /carrier-grade/],
    ['8.8.8.8', /Public addresses are never allowed/],
    ['192.168.1', /not an IPv4 address/],
    ['192.168.01.5', /not an IPv4 address/],
    ['192.168.1.256', /not an IPv4 address/],
    [' 192.168.1.5', /not an IPv4 address/],
    ['mypc.local', /not an IPv4 address/],
    ['::1', /not an IPv4 address/],
    ['fe80::1', /not an IPv4 address/]
  ])('refuses %j', (address, message) => {
    const result = validateLanHost(address, adapters())
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(message)
  })

  it('refuses a private address this computer does not have and lists the ones it does', () => {
    const result = validateLanHost('192.168.9.9', adapters())
    expect(result.ok).toBe(false)
    const error = result.ok ? '' : result.error
    expect(error).toMatch(/not an address of this computer/)
    expect(error).toContain('192.168.1.20')
    expect(error).toContain('10.4.0.7')
    expect(error).not.toContain('8.8.8.8')
  })

  it('refuses an address that only an internal entry has', () => {
    expect(validateLanHost('192.168.50.1', { Virtual: [v4('192.168.50.1', true)] }).ok).toBe(false)
  })

  it('refuses an address present on two adapters', () => {
    const result = validateLanHost('192.168.1.20', { Ethernet: [v4('192.168.1.20')], Wifi: [v4('192.168.1.20')] })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/more than one network adapter/)
  })

  it('never picks an address by itself', () => {
    expect(validateLanHost('', adapters()).ok).toBe(false)
  })
})
