import { extname, relative, resolve, sep, isAbsolute } from 'node:path'
import { APP_HOST, APP_SCHEME } from './renderer-target'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Map an app://renderer/... request onto a file inside the built renderer
 * directory. Returns null for any other host or for paths that escape the root.
 */
export function resolveRendererFile(rootDir: string, requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null

  return resolveStaticPath(rootDir, url.pathname)
}

/**
 * Map a URL path (still percent-encoded) onto a file inside `rootDir`; `/` is
 * index.html. Returns null for paths that escape the root. Also used by the
 * local web host (#110) to serve the built web client.
 */
export function resolveStaticPath(rootDir: string, urlPathname: string): string | null {
  let pathname: string
  try {
    pathname = decodeURIComponent(urlPathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null
  if (pathname === '/' || pathname === '') pathname = '/index.html'

  const root = resolve(rootDir)
  const candidate = resolve(root, `.${pathname}`)
  const rel = relative(root, candidate)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return null
  return candidate
}
