// Syntax rules for the host name the LAN demo is reached by (#137). Shared by the
// server (which validates `--lan-demo-name`) and the page (which validates the
// address the host reports), so both sides agree on what a usable name is.

/** True for a lower-case DNS host name: dot-separated labels of [a-z0-9-], at least one dot, never an IP literal or localhost. */
export function isDemoHostname(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false
  if (value !== value.toLowerCase()) return false
  const labels = value.split('.')
  if (labels.length < 2) return false
  for (const label of labels) {
    if (!/^[a-z0-9-]{1,63}$/.test(label) || label.startsWith('-') || label.endsWith('-')) return false
  }
  // IPv4 literals (also the odd numeric and 0x forms browsers accept) end in a number.
  const last = labels[labels.length - 1]!
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return false
  if (value === 'localhost' || value.endsWith('.localhost')) return false
  return true
}
