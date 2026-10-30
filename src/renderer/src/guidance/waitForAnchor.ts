// Bounded wait for a guide anchor to appear after a route change or a slow render
// (#102). Event driven (MutationObserver) with a hard timeout; no fixed sleeps.

const SAFE_ID = /^[a-z0-9-]+$/

export function findAnchor(anchorId: string, root: ParentNode = document): Element | null {
  if (!SAFE_ID.test(anchorId)) return null
  return root.querySelector(`[data-guide-id="${anchorId}"]`)
}

export interface WaitOptions {
  timeoutMs?: number
  signal?: AbortSignal
  root?: Document
}

/** Resolves with the anchor element, or null when it never appears, the wait times out or `signal` aborts. */
export function waitForAnchor(anchorId: string, { timeoutMs = 5000, signal, root = document }: WaitOptions = {}): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = findAnchor(anchorId, root)
    if (existing || signal?.aborted) {
      resolve(existing)
      return
    }
    const finish = (value: Element | null) => {
      observer.disconnect()
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish(null)
    const observer = new MutationObserver(() => {
      const found = findAnchor(anchorId, root)
      if (found) finish(found)
    })
    const timer = setTimeout(() => finish(findAnchor(anchorId, root)), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    observer.observe(root.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-guide-id'] })
  })
}
