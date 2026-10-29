export const APP_SCHEME = 'app'
export const APP_HOST = 'renderer'

export interface RendererTarget {
  mode: 'development' | 'production'
  /** URL the main window loads. */
  entryUrl: string
  /** `scheme://host[:port]` the renderer is trusted to run from. */
  origin: string
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Decide where the renderer is loaded from. Callers pass the dev server URL only
 * for unpackaged builds, so a packaged app can never be pointed at a server.
 */
export function resolveRendererTarget(devServerUrl: string | undefined): RendererTarget {
  if (devServerUrl) {
    const url = new URL(devServerUrl)
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error('The renderer dev server must be served over http from a loopback address.')
    }
    return { mode: 'development', entryUrl: url.href, origin: `${url.protocol}//${url.host}` }
  }

  const origin = `${APP_SCHEME}://${APP_HOST}`
  return { mode: 'production', entryUrl: `${origin}/index.html`, origin }
}
