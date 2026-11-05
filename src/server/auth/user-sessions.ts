import { randomBytes, timingSafeEqual } from 'node:crypto'

// Application sessions for signed-in people (#180). A session proves "this
// browser completed a Google sign-in for internal user X at auth version N".
// It holds NO role and NO status: every request re-reads the user's current
// status, role and auth version from the user directory (users.getAuthState),
// so a role change, disable or revoke-all (which bump auth_version) takes
// effect on the very next request, on any host that shares the database.
//
// This interface is deliberately small and injectable (#187). It is synchronous
// today because the only implementation is in memory. A store shared by several
// backend nodes (Phase 2.8) will need an asynchronous variant of the same shape
// (Promise-returning methods); the authorization rule above does not change.
// Memory only: restarting the host invalidates every session (fail closed).

export interface UserSession {
  id: string
  csrfToken: string
  userId: string
  /** The user's auth_version when the session was created. */
  authVersion: number
  createdAt: number
  lastSeenAt: number
}

export interface UserSessionStore {
  create(userId: string, authVersion: number): UserSession
  /** Null for an unknown, idle-expired or absolute-expired id (which is also removed). */
  find(id: string | undefined): UserSession | null
  touch(id: string): void
  delete(id: string): void
  deleteForUser(userId: string): void
  deleteAll(): void
}

export interface MemoryUserSessionOptions {
  now?: () => number
  idleMs?: number
  absoluteMs?: number
  max?: number
  maxPerUser?: number
}

export const SESSION_IDLE_MS = 8 * 60 * 60_000
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000

const secret = () => randomBytes(32).toString('base64url')

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function sameSessionSecret(a: string, b: string): boolean {
  return same(a, b)
}

export function createMemoryUserSessionStore(options: MemoryUserSessionOptions = {}): UserSessionStore {
  const now = options.now ?? Date.now
  const idleMs = options.idleMs ?? SESSION_IDLE_MS
  const absoluteMs = options.absoluteMs ?? SESSION_ABSOLUTE_MS
  const max = options.max ?? 200
  const maxPerUser = options.maxPerUser ?? 10
  // Map keeps insertion order: the first entry is the oldest.
  const sessions = new Map<string, UserSession>()

  const expired = (s: UserSession, at: number) => at - s.lastSeenAt > idleMs || at - s.createdAt > absoluteMs

  function evictOldest(match: (s: UserSession) => boolean, limit: number): void {
    const matching = [...sessions.values()].filter(match)
    for (let i = 0; i < matching.length - limit; i++) sessions.delete(matching[i]!.id)
  }

  return {
    create(userId, authVersion) {
      const at = now()
      const session: UserSession = {
        id: secret(),
        csrfToken: secret(),
        userId,
        authVersion,
        createdAt: at,
        lastSeenAt: at
      }
      sessions.set(session.id, session)
      evictOldest((s) => s.userId === userId, maxPerUser)
      evictOldest(() => true, max)
      return session
    },
    find(id) {
      if (!id) return null
      for (const session of sessions.values()) {
        if (!same(id, session.id)) continue
        if (expired(session, now())) {
          sessions.delete(session.id)
          return null
        }
        return session
      }
      return null
    },
    touch(id) {
      const session = sessions.get(id)
      if (session) session.lastSeenAt = now()
    },
    delete(id) {
      sessions.delete(id)
    },
    deleteForUser(userId) {
      for (const session of [...sessions.values()]) if (session.userId === userId) sessions.delete(session.id)
    },
    deleteAll() {
      sessions.clear()
    }
  }
}
