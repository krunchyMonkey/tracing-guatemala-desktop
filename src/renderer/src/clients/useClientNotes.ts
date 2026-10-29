import { useCallback, useEffect, useState } from 'react'
import type { NoteMutationResult } from '../../../shared/ipc'
import { compareNotes, type ClientNote, type NoteInput } from './model'

// Saved notes and contact entries for one client (#9), read and written
// through the main process.

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
  const [state, setState] = useState<ClientNotes['state']>('loading')
  const [notes, setNotes] = useState<ClientNote[]>([])
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    window.tracingGuatemala.listNotes(clientId).then(
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
  }, [clientId, version, attempt])

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
      (input: NoteInput) => save(() => window.tracingGuatemala.createNote(clientId, input)),
      [clientId, save]
    ),
    update: useCallback(
      (noteId: string, input: NoteInput) => save(() => window.tracingGuatemala.updateNote(clientId, noteId, input)),
      [clientId, save]
    )
  }
}
