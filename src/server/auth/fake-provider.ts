import type { CompleteResult, IdentityFailure, IdentityProvider, VerifiedIdentity } from './identity'

// Deterministic fake for tests and E2E (#178). It performs no verification at
// all, so it must never be reachable in a real run: it is exported only from
// this file and nothing in the production wiring imports it. #180 will gate
// its use behind TG_TEST_HOOKS=1.

export interface FakeProviderOptions {
  /** Identities by the `code` param the test passes to completeSignIn. */
  identities?: Record<string, VerifiedIdentity>
  /** Failures by `code`. */
  failures?: Record<string, IdentityFailure>
  /** Where beginSignIn sends the browser; a test serves a fake consent page here. */
  authUrl?: string
}

export function createFakeIdentityProvider(options: FakeProviderOptions = {}): IdentityProvider {
  const pending = new Set<string>()
  let counter = 0
  return {
    id: 'google',
    beginSignIn() {
      const loginId = `fake-login-${++counter}`
      pending.add(loginId)
      return { redirectUrl: `${options.authUrl ?? 'https://fake.invalid/auth'}?login=${loginId}`, loginId }
    },
    async completeSignIn(loginId, params): Promise<CompleteResult> {
      if (!loginId || !pending.delete(loginId)) return { ok: false, reason: 'expired-login' }
      if (params.get('error') === 'access_denied') return { ok: false, reason: 'denied-by-user' }
      const code = params.get('code') ?? ''
      const failure = options.failures?.[code]
      if (failure) return { ok: false, reason: failure }
      const identity = options.identities?.[code]
      if (!identity) return { ok: false, reason: 'invalid-request' }
      return { ok: true, identity }
    }
  }
}
