// crypto.randomUUID() exists only in secure contexts (HTTPS or localhost), so the
// demo opened at http://<LAN-IP>:4173 doesn't have it. crypto.getRandomValues()
// works on plain HTTP too, so it builds the same RFC 9562 version 4 UUID.
// Math.random() is never used: it isn't a cryptographic source.

interface UuidSource {
  randomUUID?: () => string
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array
}

export function randomUuid(source: UuidSource | null = globalThis.crypto ?? null): string {
  if (!source) throw new Error('Web Crypto is unavailable, so the demo cannot create IDs.')
  if (typeof source.randomUUID === 'function') return source.randomUUID()

  const bytes = source.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
