/**
 * Saves text as a Markdown file through the browser's download: a Blob, a temporary
 * `<a download>` and a revoked object URL. The text is never logged or stored, and no
 * network request is made (a blob download needs no connect-src).
 */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.rel = 'noopener'
    document.body.append(link)
    link.click()
    link.remove()
  } finally {
    // Give the browser a moment to start the download before the URL goes away.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
