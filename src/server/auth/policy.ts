import type { UserRole } from '../../shared/users'

// Server-side authorization of the data calls (#180): one function, one table.
// The browser never decides; hiding a button is not a control. A user principal carries the
// internal app_users id of the validated session (#209); no decision here uses it yet (#210).

export type Principal = { kind: 'host' } | { kind: 'device' } | { kind: 'user'; role: UserRole; userId: string }

/** Backups, device administration and LAN/network actions: the loopback host session only, whoever is signed in remotely. */
export const NEVER_REMOTE_CALLS: ReadonlySet<string> = new Set([
  'createBackup',
  'restoreBackup',
  'getBackupStatus',
  'getLanStatus',
  'createPairingCode',
  'listDevices',
  'revokeDevice',
  'revokeAllDevices',
  'disableLan'
])

/** The user directory (#179): the host session and remote owners. */
export const USER_ADMIN_CALLS: ReadonlySet<string> = new Set([
  'listUsers',
  'listSignInRequests',
  'createUser',
  'approveSignInRequest',
  'dismissSignInRequest',
  'setUserRole',
  'setUserStatus',
  'revokeUserSessions'
])

/** Calls about the signed-in person's own account. */
export const SELF_CALLS: ReadonlySet<string> = new Set(['getMyAccount', 'revokeMySessions'])

export type Decision = { allowed: true } | { allowed: false; code: 'host-only' | 'forbidden' }

const ALLOW: Decision = { allowed: true }
const HOST_ONLY: Decision = { allowed: false, code: 'host-only' }
const FORBIDDEN: Decision = { allowed: false, code: 'forbidden' }

export function authorizeCall(name: string, principal: Principal): Decision {
  switch (principal.kind) {
    case 'host':
      return name === 'revokeMySessions' ? FORBIDDEN : ALLOW
    case 'device':
      if (NEVER_REMOTE_CALLS.has(name) || USER_ADMIN_CALLS.has(name)) return HOST_ONLY
      return SELF_CALLS.has(name) ? FORBIDDEN : ALLOW
    case 'user':
      if (NEVER_REMOTE_CALLS.has(name)) return HOST_ONLY
      if (USER_ADMIN_CALLS.has(name)) return principal.role === 'owner' ? ALLOW : FORBIDDEN
      return ALLOW
  }
}
