// Provider-neutral sign-in port (#178). Transport independent: no HTTP routes,
// no sessions, no database. #180 wires routes and sessions on top of this and
// unifies VerifiedIdentity with the account store's claims type (#179).

export interface VerifiedIdentity {
  provider: 'google'
  /** Stable provider account id (Google `sub`). */
  subject: string
  email: string
  emailVerified: true
  /** True when the provider is the authority for this address (Gmail or a Workspace domain). */
  emailAuthoritative: boolean
  name: string | null
}

export type IdentityFailure =
  | 'invalid-request'
  | 'state-mismatch'
  | 'expired-login'
  | 'denied-by-user'
  | 'invalid-token'
  | 'bad-signature'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'expired-token'
  | 'nonce-mismatch'
  | 'unverified-email'
  | 'provider-unavailable'
  | 'too-many-attempts'

export type CompleteResult = { ok: true; identity: VerifiedIdentity } | { ok: false; reason: IdentityFailure }

export interface IdentityProvider {
  id: 'google'
  /** Throws Error('too-many-attempts') when begun too often. */
  beginSignIn(): { redirectUrl: string; loginId: string }
  completeSignIn(loginId: string | undefined, params: URLSearchParams): Promise<CompleteResult>
}

export type AccountDecision =
  | { allowed: true; userId: string }
  | { allowed: false; reason: 'unknown' | 'pending' | 'disabled' }

/** Looks up an existing account. It must never register one or grant a role. */
export type AccountGate = (identity: VerifiedIdentity) => AccountDecision

export type SignInResult =
  | { ok: true; identity: VerifiedIdentity; userId: string }
  | { ok: false; reason: IdentityFailure }
  | { ok: false; reason: 'account-denied'; account: 'unknown' | 'pending' | 'disabled'; identity: VerifiedIdentity }

/** Verifies the identity, then lets only an approved active account proceed. */
export async function signIn(
  provider: IdentityProvider,
  gate: AccountGate,
  loginId: string | undefined,
  params: URLSearchParams
): Promise<SignInResult> {
  const result = await provider.completeSignIn(loginId, params)
  if (!result.ok) return result
  const decision = gate(result.identity)
  if (!decision.allowed) {
    return { ok: false, reason: 'account-denied', account: decision.reason, identity: result.identity }
  }
  return { ok: true, identity: result.identity, userId: decision.userId }
}
