import { useCallback, useEffect, useRef, useState } from 'react'

export type LoadStatus = 'loading' | 'ready' | 'error'

/**
 * Runs `load` when `key` changes (or after retry). The previous data stays
 * available while a new load runs, and an older, slower response never replaces a
 * newer one.
 */
export function useLoad<T>(load: () => Promise<T>, key: string): { status: LoadStatus; data: T | undefined; error: unknown; retry(): void } {
  const [state, setState] = useState<{ status: LoadStatus; data: T | undefined; error: unknown }>({
    status: 'loading',
    data: undefined,
    error: undefined
  })
  const [attempt, setAttempt] = useState(0)
  const loadRef = useRef(load)

  useEffect(() => {
    loadRef.current = load
  })

  useEffect(() => {
    let current = true
    loadRef.current().then(
      (data) => {
        if (current) setState({ status: 'ready', data, error: undefined })
      },
      (error: unknown) => {
        if (current) setState((s) => ({ status: 'error', data: s.data, error }))
      }
    )
    return () => {
      current = false
    }
  }, [key, attempt])

  const retry = useCallback(() => {
    setState((s) => ({ status: 'loading', data: s.data, error: undefined }))
    setAttempt((n) => n + 1)
  }, [])

  return { ...state, retry }
}
