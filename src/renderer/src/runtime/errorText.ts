// Plain-language text for the host's refusals (#246). Raw codes and server text are never shown:
// an unknown failure gets the generic line the caller already has.

export type RefusalKind = 'owner-required' | 'research-unavailable' | 'forbidden'

const messages: Record<RefusalKind, string> = {
  'owner-required':
    'This computer’s host session can’t add or change research once accounts exist. Sign in with your Google account to work on your research.',
  'research-unavailable': 'Research isn’t available right now because this profile needs an update. Nothing was lost. Ask the person who runs the app to check it.',
  forbidden: 'Your account isn’t allowed to do this. Nothing was changed.'
}

/** The code a rejected Live call carries, or null for any other failure. Duck-typed so the desktop bundle needs no Live code. */
function liveCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const { name, code } = error as { name?: unknown; code?: unknown }
  return name === 'LiveApiError' && typeof code === 'string' ? code : null
}

/** Which known refusal a failure is, if any. */
export function refusalKind(error: unknown): RefusalKind | null {
  const code = liveCode(error)
  return code !== null && Object.hasOwn(messages, code) ? (code as RefusalKind) : null
}

export function refusalMessage(kind: RefusalKind): string {
  return messages[kind]
}

/** A readable message for a known refusal, or `fallback` for anything else. */
export function describeFailure(error: unknown, fallback: string): string {
  const kind = refusalKind(error)
  return kind ? messages[kind] : fallback
}
