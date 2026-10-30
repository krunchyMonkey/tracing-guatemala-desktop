// Ids for new note blocks. crypto.randomUUID() exists only in secure contexts (HTTPS or
// localhost), and a device on the home network opens the app over plain HTTP, so the
// version 4 UUID is built from crypto.getRandomValues(), which works everywhere.
export function newBlockId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
