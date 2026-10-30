import { describe, expect, it } from 'vitest'
import {
  ABSOLUTE_EXPIRY_MS,
  CODE_ALPHABET,
  CODE_TTL_MS,
  cleanDeviceName,
  DeviceAccess,
  IDLE_EXPIRY_MS,
  MAX_DEVICES,
  normalizeCode
} from '../../src/server/devices'

// Household-device pairing and sessions (#136), with a fake clock. Fictional data only.

function setup() {
  const clock = { t: Date.parse('2026-10-30T09:00:00.000Z') }
  const access = new DeviceAccess({ now: () => new Date(clock.t) })
  return { clock, access, advance: (ms: number) => (clock.t += ms) }
}

function enrolled(access: DeviceAccess, name = 'Tablet') {
  const { code } = access.createCode()
  const result = access.enroll(code, name)
  if (!result.ok) throw new Error(`enroll failed: ${result.reason}`)
  return result
}

describe('pairing code', () => {
  it('has 8 characters from the allowed alphabet, shown as ABCD-EFGH', () => {
    const { access } = setup()
    for (let i = 0; i < 200; i++) {
      const { code, expiresAt } = access.createCode()
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      for (const ch of code.replace('-', '')) expect(CODE_ALPHABET).toContain(ch)
      expect(Date.parse(expiresAt)).toBe(Date.parse('2026-10-30T09:00:00.000Z') + CODE_TTL_MS)
    }
    expect(CODE_ALPHABET).toHaveLength(31)
    expect(CODE_ALPHABET).not.toMatch(/[ILO01]/)
  })

  it('is accepted in any case, with spaces or no dash', () => {
    expect(normalizeCode(' ab cd-ef gh ')).toBe('ABCDEFGH')
    const { access } = setup()
    const { code } = access.createCode()
    expect(access.enroll(code.toLowerCase().replace('-', ' '), 'Phone').ok).toBe(true)
  })

  it('expires after 5 minutes', () => {
    const { access, advance } = setup()
    const { code } = access.createCode()
    advance(CODE_TTL_MS)
    expect(access.enroll(code, 'Phone')).toEqual({ ok: false, reason: 'invalid-code' })
  })

  it('works just before it expires', () => {
    const { access, advance } = setup()
    const { code } = access.createCode()
    advance(CODE_TTL_MS - 1)
    expect(access.enroll(code, 'Phone').ok).toBe(true)
  })

  it('is replaced by a newer code', () => {
    const { access } = setup()
    const first = access.createCode().code
    const second = access.createCode().code
    expect(access.enroll(first, 'Phone')).toEqual({ ok: false, reason: 'invalid-code' })
    expect(access.enroll(second, 'Phone').ok).toBe(true)
  })

  it('is invalidated by 5 wrong attempts, even for the right code afterwards', () => {
    const { access } = setup()
    const { code } = access.createCode()
    for (let i = 0; i < 4; i++) expect(access.enroll('WRONGCODE', 'x')).toEqual({ ok: false, reason: 'invalid-code' })
    // The 5th wrong attempt kills it.
    expect(access.enroll('WRONGCODE', 'x')).toEqual({ ok: false, reason: 'invalid-code' })
    expect(access.enroll(code, 'Phone')).toEqual({ ok: false, reason: 'invalid-code' })
  })

  it('still works after 4 wrong attempts', () => {
    const { access } = setup()
    const { code } = access.createCode()
    for (let i = 0; i < 4; i++) access.enroll('WRONGCODE', 'x')
    expect(access.enroll(code, 'Phone').ok).toBe(true)
  })

  it('cannot be replayed after a successful enrollment', () => {
    const { access } = setup()
    const { code } = access.createCode()
    expect(access.enroll(code, 'Phone').ok).toBe(true)
    expect(access.enroll(code, 'Other')).toEqual({ ok: false, reason: 'invalid-code' })
    expect(access.listDevices()).toHaveLength(1)
  })

  it('answers the same way for wrong, missing and wrong-length codes', () => {
    const { access } = setup()
    expect(access.enroll('ABCD-EFGH', 'x')).toEqual({ ok: false, reason: 'invalid-code' })
    access.createCode()
    expect(access.enroll('', 'x')).toEqual({ ok: false, reason: 'invalid-code' })
    expect(access.enroll('A', 'x')).toEqual({ ok: false, reason: 'invalid-code' })
  })
})

describe('global enrollment limiter', () => {
  it('refuses the 11th attempt in 60 seconds, even with the right code', () => {
    const { access } = setup()
    for (let i = 0; i < 10; i++) access.enroll('WRONGCODE', 'x')
    const { code } = access.createCode()
    expect(access.enroll(code, 'Phone')).toEqual({ ok: false, reason: 'too-many-attempts' })
  })

  it('does not look at the code once limited (it is not used up)', () => {
    const { access, advance } = setup()
    for (let i = 0; i < 10; i++) access.enroll('WRONGCODE', 'x')
    const { code } = access.createCode()
    for (let i = 0; i < 5; i++) expect(access.enroll('WRONGCODE', 'x')).toEqual({ ok: false, reason: 'too-many-attempts' })
    advance(61_000)
    expect(access.enroll(code, 'Phone').ok).toBe(true)
  })

  it('is a rolling window', () => {
    const { access, advance } = setup()
    for (let i = 0; i < 10; i++) {
      access.enroll('WRONGCODE', 'x')
      advance(5_000)
    }
    // The first attempt is now 50 s old... advance to 61 s after it.
    advance(11_000)
    const { code } = access.createCode()
    expect(access.enroll(code, 'Phone').ok).toBe(true)
  })
})

describe('devices and sessions', () => {
  it('creates a device with a public id and a separate secret session', () => {
    const { access } = setup()
    const { device, session } = enrolled(access, '  Kitchen tablet ')
    expect(device.name).toBe('Kitchen tablet')
    expect(device.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(session.id).not.toBe(device.id)
    expect(session.csrfToken).not.toBe(session.id)
    expect(access.listDevices()).toEqual([device])
  })

  it('finds a session and checks its CSRF token', () => {
    const { access } = setup()
    const { session } = enrolled(access)
    const found = access.find(session.id)
    expect(found?.session.id).toBe(session.id)
    expect(access.checkCsrf(session, session.csrfToken)).toBe(true)
    expect(access.checkCsrf(session, 'nope')).toBe(false)
    expect(access.checkCsrf(session, undefined)).toBe(false)
    expect(access.find('unknown')).toBeNull()
    expect(access.find(undefined)).toBeNull()
  })

  it('refreshes lastSeenAt on each authorized request', () => {
    const { access, advance } = setup()
    const { session, device } = enrolled(access)
    advance(10 * 60_000)
    access.find(session.id)
    expect(access.listDevices()[0]!.lastSeenAt).toBe(new Date(Date.parse(device.enrolledAt) + 10 * 60_000).toISOString())
  })

  it('expires after 60 minutes idle and deletes the session', () => {
    const { access, advance } = setup()
    const { session } = enrolled(access)
    advance(IDLE_EXPIRY_MS - 1)
    expect(access.find(session.id)).not.toBeNull()
    advance(IDLE_EXPIRY_MS)
    expect(access.find(session.id)).toBeNull()
    expect(access.find(session.id)).toBeNull()
    expect(access.listDevices()).toEqual([])
  })

  it('expires after 12 hours however active', () => {
    const { access, advance } = setup()
    const { session } = enrolled(access)
    for (let elapsed = 0; elapsed < ABSOLUTE_EXPIRY_MS - 30 * 60_000; elapsed += 30 * 60_000) {
      advance(30 * 60_000)
      expect(access.find(session.id)).not.toBeNull()
    }
    advance(30 * 60_000)
    expect(access.find(session.id)).toBeNull()
  })

  it('drops the presented old session and device when enrolling again', () => {
    const { access } = setup()
    const first = enrolled(access, 'Phone')
    const { code } = access.createCode()
    const second = access.enroll(code, 'Phone', first.session.id)
    expect(second.ok).toBe(true)
    expect(access.find(first.session.id)).toBeNull()
    expect(access.listDevices()).toHaveLength(1)
    expect(access.listDevices()[0]!.id).not.toBe(first.device.id)
  })

  it('keeps the old session when the code was wrong', () => {
    const { access } = setup()
    const first = enrolled(access)
    access.createCode()
    access.enroll('WRONGCODE', 'x', first.session.id)
    expect(access.find(first.session.id)).not.toBeNull()
  })

  it('revokes one device and its session', () => {
    const { access } = setup()
    const a = enrolled(access, 'A')
    const b = enrolled(access, 'B')
    expect(access.revokeDevice(a.device.id)).toBe(true)
    expect(access.revokeDevice(a.device.id)).toBe(false)
    expect(access.find(a.session.id)).toBeNull()
    expect(access.find(b.session.id)).not.toBeNull()
  })

  it('revokes every device', () => {
    const { access } = setup()
    const a = enrolled(access, 'A')
    const b = enrolled(access, 'B')
    expect(access.revokeAll()).toBe(2)
    expect(access.find(a.session.id)).toBeNull()
    expect(access.find(b.session.id)).toBeNull()
    expect(access.revokeAll()).toBe(0)
  })

  it('logs out by removing the device and its session', () => {
    const { access } = setup()
    const a = enrolled(access, 'A')
    const b = enrolled(access, 'B')
    access.logout(a.session.id)
    expect(access.find(a.session.id)).toBeNull()
    expect(access.listDevices().map((d) => d.name)).toEqual(['B'])
    access.logout('unknown')
    access.logout(undefined)
    expect(access.find(b.session.id)).not.toBeNull()
  })

  it('allows at most 10 devices, and a slot frees up on revoke', () => {
    const { access, advance } = setup()
    const sessions = []
    for (let i = 0; i < MAX_DEVICES; i++) {
      sessions.push(enrolled(access, `Device ${i}`))
      advance(7_000) // stay under the global limiter
    }
    advance(60_000)
    const { code } = access.createCode()
    expect(access.enroll(code, 'One too many')).toEqual({ ok: false, reason: 'too-many-devices' })
    access.revokeDevice(sessions[0]!.device.id)
    expect(access.enroll(code, 'Fits now').ok).toBe(true)
  })

  it('lets a re-enrolling device reuse its own slot at the cap', () => {
    const { access, advance } = setup()
    const sessions = []
    for (let i = 0; i < MAX_DEVICES; i++) {
      sessions.push(enrolled(access, `Device ${i}`))
      advance(7_000)
    }
    advance(60_000)
    const { code } = access.createCode()
    expect(access.enroll(code, 'Again', sessions[3]!.session.id).ok).toBe(true)
    expect(access.listDevices()).toHaveLength(MAX_DEVICES)
  })

  it('forgets expired devices so they do not fill the cap', () => {
    const { access, advance } = setup()
    for (let i = 0; i < MAX_DEVICES; i++) {
      enrolled(access, `Device ${i}`)
      advance(7_000)
    }
    advance(IDLE_EXPIRY_MS)
    expect(enrolled(access, 'Fresh').device.name).toBe('Fresh')
    expect(access.listDevices()).toHaveLength(1)
  })
})

describe('device names', () => {
  it('trims, defaults and bounds', () => {
    expect(cleanDeviceName(undefined)).toBe('Device')
    expect(cleanDeviceName('   ')).toBe('Device')
    expect(cleanDeviceName('  Ana’s phone ')).toBe('Ana’s phone')
    expect(cleanDeviceName('x'.repeat(40))).toBe('x'.repeat(40))
    expect(cleanDeviceName('x'.repeat(41))).toBeNull()
  })

  it('refuses control characters', () => {
    for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a b']) expect(cleanDeviceName(bad)).toBeNull()
  })

  it('rejects an invalid name without using up the code', () => {
    const { access } = setup()
    const { code } = access.createCode()
    expect(access.enroll(code, 'bad\nname')).toEqual({ ok: false, reason: 'invalid-name' })
    expect(access.enroll(code, 'Good name').ok).toBe(true)
  })
})
