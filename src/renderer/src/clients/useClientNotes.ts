import { useCallback, useEffect, useState } from 'react'
import type { NoteMutationResult } from '../../../shared/ipc'
import { useAppRuntime } from '../runtime/AppRuntime'
import { compareNotes, type ClientNote, type NoteInput } from './model'

// Saved notes and contact entries for one client (#9), read and written
// through the main process (or the browser demo's memory, #100).

/** A main-process outcome, or `failed` when the call itself did not complete. */
export type NoteSaveResult = NoteMutationResult | { ok: false; reason: 'failed' }

export interface ClientNotes {
  state: 'loading' | 'ready' | 'error'
  notes: ClientNote[]
  retry(): void
  create(input: NoteInput): Promise<NoteSaveResult>
  update(noteId: string, input: NoteInput): Promise<NoteSaveResult>
}

/**
 * `version` should change whenever the main process may have added entries on
 * its own (archive and restore add system entries), so the list is re-read.
 */
export function useClientNotes(clientId: string, version: string): ClientNotes {
  const { data } = useAppRuntime()
  const [state, setState] = useState<ClientNotes['state']>('loading')
  const [notes, setNotes] = useState<ClientNote[]>([])
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    data.listNotes(clientId).then(
      (list) => {
        if (!current) return
        setNotes(list)
        setState('ready')
      },
      () => {
        if (current) setState('error')
      }
    )
    return () => {
      current = false
    }
  }, [data, clientId, version, attempt])

  const save = useCallback(async (call: () => Promise<NoteMutationResult>): Promise<NoteSaveResult> => {
    let result: NoteMutationResult
    try {
      result = await call()
    } catch {
      return { ok: false, reason: 'failed' }
    }
    if (result.ok) {
      const saved = result.note
      setNotes((list) => [...list.filter((n) => n.id !== saved.id), saved].sort(compareNotes))
    }
    return result
  }, [])

  return {
    state,
    notes,
    retry: useCallback(() => {
      setState('loading')
      setAttempt((n) => n + 1)
    }, []),
    create: useCallback(
      (input: NoteInput) => save(() => data.createNote(clientId, input)),
      [data, clientId, save]
    ),
    update: useCallback(
      (noteId: string, input: NoteInput) => save(() => data.updateNote(clientId, noteId, input)),
      [data, clientId, save]
    )
  }
}
