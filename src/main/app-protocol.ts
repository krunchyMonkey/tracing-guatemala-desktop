import { readFile } from 'node:fs/promises'
import { protocol } from 'electron'
import { buildContentSecurityPolicy } from '../shared/csp'
import { contentTypeFor, resolveRendererFile } from './renderer-files'
import { APP_SCHEME } from './renderer-target'

/**
 * Serve the built renderer from app://renderer/ instead of file://, so the
 * renderer has a real origin, a CSP response header, and no file-system reach.
 */
export function registerAppProtocol(rendererDir: string): void {
  const csp = buildContentSecurityPolicy({ mode: 'production' })

  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET') return new Response(null, { status: 405 })

    const filePath = resolveRendererFile(rendererDir, request.url)
    if (!filePath) return new Response(null, { status: 404 })

    try {
      const body = await readFile(filePath)
      return new Response(body, {
        headers: {
          'Content-Type': contentTypeFor(filePath),
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
