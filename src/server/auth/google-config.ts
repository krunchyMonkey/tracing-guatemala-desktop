import { readFileSync } from 'node:fs'

// Reads the OAuth client JSON downloaded from Google Cloud (#178). Messages are
// fixed strings; they never include the secret or any file content.

export interface GoogleClientConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export const GOOGLE_CALLBACK_PATH = '/api/v1/auth/google/callback'
const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com'

export function readGoogleClientFile(path: string, httpsName: string): GoogleClientConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error('Google client file could not be read.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Google client file is not valid JSON.')
  }
  const web = (parsed as { web?: unknown } | null)?.web as
    | { client_id?: unknown; client_secret?: unknown; redirect_uris?: unknown }
    | undefined
  if (!web || typeof web !== 'object') throw new Error('Google client file must be a "web" application client.')
  const { client_id: clientId, client_secret: clientSecret, redirect_uris: uris } = web
  if (typeof clientId !== 'string' || !clientId.endsWith(CLIENT_ID_SUFFIX) || clientId.length <= CLIENT_ID_SUFFIX.length) {
    throw new Error('Google client file has no valid client_id.')
  }
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
    throw new Error('Google client file has no client_secret.')
  }
  const redirectUri = `https://${httpsName}${GOOGLE_CALLBACK_PATH}`
  if (!Array.isArray(uris) || !uris.includes(redirectUri)) {
    throw new Error('Google client file does not list the expected redirect URI for this HTTPS name.')
  }
  return { clientId, clientSecret, redirectUri }
}
