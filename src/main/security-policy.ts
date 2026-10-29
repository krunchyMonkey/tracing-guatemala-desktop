import type { RendererTarget } from './renderer-target'

/**
 * `scheme://host[:port]` for any URL, or null if it cannot be parsed. WHATWG URL
 * reports an opaque "null" origin for custom schemes like app://, so build it by hand.
 */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : null
  } catch {
    return null
  }
}

export function isSameOrigin(url: string, origin: string): boolean {
  return originOf(url) === origin
}

/**
 * Network allow-list for every request the app's session makes. Phase 1 is fully
 * local: only the renderer's own origin, inline data: images, Chromium devtools,
 * and (in development) the Vite HMR socket are allowed.
 */
export function isAllowedRequestUrl(url: string, target: RendererTarget): boolean {
  if (isSameOrigin(url, target.origin)) return true

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'devtools:') return true

  if (target.mode === 'development' && parsed.protocol === 'ws:') {
    return parsed.host === new URL(target.origin).host
  }
  return false
}

/** Scheme only: never log full URLs, which may later carry client details. */
export function describeBlockedUrl(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return 'unparseable URL'
  }
}
