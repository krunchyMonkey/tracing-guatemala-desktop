// Whether this page was loaded over HTTPS (#167). Decided only from the page's own
// scheme, never from anything the server or the URL query says. Without a window
// we assume the unencrypted case, so the stronger warning is the default.
export function isEncryptedTransport(): boolean {
  return typeof window !== 'undefined' && window.location?.protocol === 'https:'
}
