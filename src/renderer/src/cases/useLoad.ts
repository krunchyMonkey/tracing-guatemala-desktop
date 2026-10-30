import { useCallback, useEffect, useRef, useState } from 'react'

export type LoadStatus = 'loading' | 'ready' | 'error'

/**
 * Runs `load` when `key` changes (or after retry). The previous data stays
 * available while a new load runs, and an older, slower response never replaces a
 * newer one.
 */
export function useLoad<T>(load: () => Promise<T>, key: string): { status: LoadStatus; data: T | undefined; retry(): void } {
  const [state, setState] = useState<{ status: LoadStatus; data: T | undefined }>({ status: 'loading', data: undefined })
  const [attempt, setAttempt] = useState(0)
  const loadRef = useRef(load)

  useEffect(() => {
    loadRef.current = load
  })

  useEffect(() => {
    let current = true
    loadRef.current().then(
      (data) => {
        if (current) setState({ status: 'ready', data })
      },
      () => {
        if (current) setState((s) => ({ status: 'error', data: s.data }))
      }
    )
    return () => {
      current = false
    }
  }, [key, attempt])

  const retry = useCallback(() => {
    setState((s) => ({ status: 'loading', data: s.data }))
    setAttempt((n) => n + 1)
  }, [])

  return { ...state, retry }
}
