export interface CspOptions {
  mode: 'production' | 'development'
  /** Origin of the Vite dev server, e.g. http://localhost:5173. Development only. */
  devServerOrigin?: string
  /** `frame-ancestors` is ignored (with a console warning) when delivered via <meta>. */
  forMetaTag?: boolean
  /**
   * Production only: allow fetch() to the page's own origin. Only the loopback
   * Live web host (#110) sets this; the desktop app and the LAN demo keep
   * `connect-src 'none'`.
   */
  connectToSelf?: boolean
}

/**
 * Content Security Policy for the renderer. Production allows only the app's own
 * bundled scripts/styles and no network connections at all. Development relaxes
 * script/style/connect just enough for Vite HMR and React Refresh.
 */
export function buildContentSecurityPolicy({
  mode,
  devServerOrigin,
  forMetaTag = false,
  connectToSelf = false
}: CspOptions): string {
  const isDev = mode === 'development'
  if (isDev && !devServerOrigin) {
    throw new Error('A development CSP requires the dev server origin.')
  }

  const devSocket = devServerOrigin?.replace(/^http/, 'ws')
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'script-src': isDev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': isDev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'connect-src': isDev ? ["'self'", devSocket!] : connectToSelf ? ["'self'"] : ["'none'"],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'worker-src': ["'none'"],
    'manifest-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"]
  }
  if (!forMetaTag) {
    directives['frame-ancestors'] = ["'none'"]
  }

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ')
}
