import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

// Household-device access for the opt-in home-network listener (#136). Memory
// only: restarting the host forgets every device, session and pairing code, so
// devices pair again. None of this encrypts traffic: over plain HTTP a code, a
// cookie and every record can be read by anyone on the network.
//
//  - The host shows a short-lived pairing code (Settings on this computer).
//  - A device presents it once to enroll; that creates a named device and its
//    one session. Enrolling again with an old session drops the old one.
//  - Sessions end after 60 minutes idle or 12 hours in total, or when revoked.

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 8
export const CODE_TTL_MS = 5 * 60_000
export const MAX_CODE_FAILURES = 5
export const ENROLL_WINDOW_MS = 60_000
export const MAX_ENROLL_ATTEMPTS = 10
export const MAX_DEVICES = 10
export const IDLE_EXPIRY_MS = 60 * 60_000
export const ABSOLUTE_EXPIRY_MS = 12 * 60 * 60_000
export const MAX_NAME_LENGTH = 40
export const DEFAULT_DEVICE_NAME = 'Device'

export interface Device {
  /** Public id, used only to revoke. Not a secret and not a session. */
  id: string
  name: string
  enrolledAt: string
  lastSeenAt: string
}

export interface DeviceSession {
  id: string
  csrfToken: string
  deviceId: string
  createdAt: number
  lastSeenAt: number
}

interface DeviceRecord {
  id: string
  name: string
  enrolledAt: number
  lastSeenAt: number
}

export type EnrollResult =
  | { ok: true; device: Device; session: DeviceSession }
  | { ok: false; reason: 'invalid-code' | 'too-many-attempts' | 'too-many-devices' | 'invalid-name' }

const secret = (bytes: number) => randomBytes(bytes).toString('base64url')

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Uppercase, with spaces and dashes removed. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '')
}

export function displayCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Trimmed, 1 to 40 characters, no control characters; blank means the default. Null when invalid. */
export function cleanDeviceName(input: string | undefined): string | null {
  if (input === undefined) return DEFAULT_DEVICE_NAME
  const name = input.trim()
  if (name.length === 0) return DEFAULT_DEVICE_NAME
  if ([...name].length > MAX_NAME_LENGTH) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return null
  return name
}

export class DeviceAccess {
  private readonly now: () => Date
  private code: { value: string; expiresAt: number; failures: number } | null = null
  private attempts: number[] = []
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly sessions = new Map<string, DeviceSession>()

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date())
  }

  private time(): number {
    return this.now().getTime()
  }

  /** Makes a new pairing code, replacing any earlier one. */
  createCode(): { code: string; expiresAt: string } {
    let value = ''
    for (let i = 0; i < CODE_LENGTH; i++) value += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    const expiresAt = this.time() + CODE_TTL_MS
    this.code = { value, expiresAt, failures: 0 }
    return { code: displayCode(value), expiresAt: new Date(expiresAt).toISOString() }
  }

  /**
   * Pairs a device. `previousSessionId` is the LAN session cookie the browser
   * already holds, if any: that session and its device are dropped (rotation).
   */
  enroll(code: string, name: string | undefined, previousSessionId?: string): EnrollResult {
    const now = this.time()
    // Global limit across all clients, checked before the code is looked at.
    this.attempts = this.attempts.filter((t) => now - t < ENROLL_WINDOW_MS)
    if (this.attempts.length >= MAX_ENROLL_ATTEMPTS) return { ok: false, reason: 'too-many-attempts' }
    this.attempts.push(now)

    const cleanName = cleanDeviceName(name)
    if (cleanName === null) return { ok: false, reason: 'invalid-name' }

    const current = this.code
    if (current && now >= current.expiresAt) this.code = null
    const active = this.code
    const given = normalizeCode(code)
    if (!active || given.length !== active.value.length || !sameSecret(given, active.value)) {
      if (active && ++active.failures >= MAX_CODE_FAILURES) this.code = null
      return { ok: false, reason: 'invalid-code' }
    }

    // The code was right: the old session of this browser goes first.
    if (previousSessionId) {
      const previous = this.lookup(previousSessionId)
      if (previous) this.removeDevice(previous.deviceId)
    }
    this.purgeExpired(now)
    if (this.devices.size >= MAX_DEVICES) return { ok: false, reason: 'too-many-devices' }

    this.code = null // one use
    const record: DeviceRecord = { id: secret(16), name: cleanName, enrolledAt: now, lastSeenAt: now }
    const session: DeviceSession = { id: secret(32), csrfToken: secret(32), deviceId: record.id, createdAt: now, lastSeenAt: now }
    this.devices.set(record.id, record)
    this.sessions.set(session.id, session)
    return { ok: true, device: this.publicDevice(record), session }
  }

  private lookup(sessionId: string): DeviceSession | null {
    for (const session of this.sessions.values()) {
      if (sameSecret(sessionId, session.id)) return session
    }
    return null
  }

  private expired(session: DeviceSession, now: number): boolean {
    return now - session.lastSeenAt >= IDLE_EXPIRY_MS || now - session.createdAt >= ABSOLUTE_EXPIRY_MS
  }

  private purgeExpired(now: number): void {
    for (const session of [...this.sessions.values()]) {
      if (this.expired(session, now)) this.removeDevice(session.deviceId)
    }
  }

  private removeDevice(deviceId: string): boolean {
    const existed = this.devices.delete(deviceId)
    for (const [id, session] of this.sessions) {
      if (session.deviceId === deviceId) this.sessions.delete(id)
    }
    return existed
  }

  /** A live session and its device, refreshed as seen now; an expired one is deleted and not returned. */
  find(sessionId: string | undefined): { session: DeviceSession; device: Device } | null {
    if (!sessionId) return null
    const session = this.lookup(sessionId)
    if (!session) return null
    const now = this.time()
    const record = this.devices.get(session.deviceId)
    if (!record || this.expired(session, now)) {
      this.removeDevice(session.deviceId)
      this.sessions.delete(session.id)
      return null
    }
    session.lastSeenAt = now
    record.lastSeenAt = now
    return { session, device: this.publicDevice(record) }
  }

  checkCsrf(session: DeviceSession, header: string | string[] | undefined): boolean {
    return typeof header === 'string' && sameSecret(header, session.csrfToken)
  }

  private publicDevice(record: DeviceRecord): Device {
    return {
      id: record.id,
      name: record.name,
      enrolledAt: new Date(record.enrolledAt).toISOString(),
      lastSeenAt: new Date(record.lastSeenAt).toISOString()
    }
  }

  listDevices(): Device[] {
    this.purgeExpired(this.time())
    return [...this.devices.values()].sort((a, b) => a.enrolledAt - b.enrolledAt).map((d) => this.publicDevice(d))
  }

  revokeDevice(id: string): boolean {
    return this.removeDevice(id)
  }

  /** Removes every device and session; returns how many devices there were. */
  revokeAll(): number {
    const count = this.devices.size
    this.devices.clear()
    this.sessions.clear()
    return count
  }

  /** Removes the session's device and the session. */
  logout(sessionId: string | undefined): void {
    if (!sessionId) return
    const session = this.lookup(sessionId)
    if (session) this.removeDevice(session.deviceId)
  }
}
