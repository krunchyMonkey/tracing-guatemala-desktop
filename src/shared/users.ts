// Provider-neutral user directory contracts (#179). The application owns
// users and roles; an external identity provider (Google today, #178) only
// supplies VerifiedIdentityClaims. No Node imports: the renderer bundles this.
// The provider's stable subject is the ONLY key an identity is bound by; email
// and name are displayed claims and never grant or move access. The raw
// subject never appears in AppUser or SignInRequest.

export const USER_NAME_MAX = 120
export const EMAIL_MAX = 254

export type UserRole = 'owner' | 'researcher'
export type UserStatus = 'pending' | 'active' | 'disabled'
export type IdentityProvider = 'google'

export const USER_ROLES: readonly UserRole[] = ['owner', 'researcher']

export interface AppUser {
  id: string
  displayName: string
  role: UserRole
  status: UserStatus
  /** Where the owner can reach this person. Not an identity and never used to sign in. */
  contactEmail: string | null
  identity: { provider: IdentityProvider; email: string | null; emailAuthoritative: boolean; boundAt: string } | null
  /** Bumped when a role, disable, re-enable or revoke should end existing sessions. */
  authVersion: number
  /** Optimistic-concurrency token: bumped on every change. */
  version: number
  createdAt: string
  updatedAt: string
  lastSignInAt: string | null
}

export interface SignInRequest {
  id: string
  email: string | null
  emailAuthoritative: boolean
  name: string | null
  firstSeenAt: string
  lastSeenAt: string
  attempts: number
}

/** What a provider verifier (#178) hands over once a token is fully verified. */
export interface VerifiedIdentityClaims {
  provider: IdentityProvider
  subject: string
  email: string | null
  emailVerified: true
  /** True only when the provider is authoritative for this address (e.g. a Gmail address or a Workspace domain). Conservative default: false. */
  emailAuthoritative: boolean
  name: string | null
}

export type UserFailure =
  | 'not-found'
  | 'invalid'
  | 'stale'
  | 'last-owner'
  | 'identity-in-use'
  | 'already-bound'
  | 'request-not-found'
  | 'full'

export type UserMutationResult = { ok: true; user: AppUser } | { ok: false; reason: UserFailure }
export type SignInRequestResult = { ok: true; request: SignInRequest } | { ok: false; reason: UserFailure }

export type IdentityResolution =
  | { kind: 'active'; user: AppUser }
  | { kind: 'pending' | 'disabled'; userId: string }
  | { kind: 'unknown' }

export interface UserAuthState {
  status: UserStatus
  role: UserRole
  authVersion: number
}

export type ApproveTarget = { userId: string } | { displayName: string; role: UserRole }

export interface NewUserInput {
  displayName: string
  role: UserRole
  contactEmail?: string | null
}

/** Trimmed 1..120 characters without control characters, or null. */
export function checkUserName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  // eslint-disable-next-line no-control-regex
  if (name.length < 1 || name.length > USER_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return null
  return name
}

/** Lowercased address of simple shape (one @, no spaces, a dot in the domain), at most 254 characters, or null. */
export function checkEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  if (email.length > EMAIL_MAX) return null
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email) ? email : null
}

export function isUserRole(value: unknown): value is UserRole {
  return value === 'owner' || value === 'researcher'
}
