import { createFakeIdentityProvider } from './fake-provider'
import type { IdentityProvider } from './identity'

// Which identity provider the CLI may use (#180). The fake performs no
// verification at all, so it needs BOTH test environment flags.

export function fakeIdentityAllowed(env: NodeJS.ProcessEnv): boolean {
  return env['TG_TEST_HOOKS'] === '1' && env['TG_TEST_FAKE_IDENTITY'] === '1'
}

/** A fixed fictional set for end-to-end tests: sign in with `code=alex` or `code=bea`. Null unless both flags are set. */
export function testFakeProvider(env: NodeJS.ProcessEnv): IdentityProvider | null {
  if (!fakeIdentityAllowed(env)) return null
  const person = (subject: string, email: string, name: string) => ({
    provider: 'google' as const,
    subject,
    email,
    emailVerified: true as const,
    emailAuthoritative: true,
    name
  })
  return createFakeIdentityProvider({
    identities: {
      alex: person('fake-sub-alex', 'alex@example.test', 'Alex Fictional'),
      bea: person('fake-sub-bea', 'bea@example.test', 'Bea Fictional')
    }
  })
}
