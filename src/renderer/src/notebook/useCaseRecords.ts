import { useCallback, useEffect, useRef, useState } from 'react'
import type { JournalEntry } from '../../../shared/case-journal'
import type { CaseTask } from '../../../shared/case-tasks'
import type { TimeEntry } from '../../../shared/case-time'
import type { RecordKind, RecordRef } from '../../../shared/note-content'
import { formatDate } from '../clients/components'
import { formatDueDate } from '../cases/model'
import { useCaseApi } from '../cases/useCaseApi'

// The journal entries, tasks and research-hours entries of one case, for the notebook's
// workflow bridge (#149): the labels of reference blocks and the "Link record" list.
// A reference is a link; the record itself stays in its own screen. Labels are plain
// text (the records' own words), shown as text only.

export type CaseRecord = { kind: 'journal'; record: JournalEntry } | { kind: 'task'; record: CaseTask } | { kind: 'time'; record: TimeEntry }

export const NOT_AVAILABLE_LABEL = 'Linked record not available'

const FALLBACK_LABELS: Record<RecordKind, string> = { journal: 'Journal entry', task: 'Task', time: 'Research hours entry' }
const SHORT = 60

const clip = (text: string): string => (text.length > SHORT ? `${text.slice(0, SHORT)}…` : text)
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** "1 h 30 m", "2 h", "45 m". */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return [h > 0 ? `${h} h` : '', m > 0 || h === 0 ? `${m} m` : ''].filter(Boolean).join(' ')
}

export function labelOf(entry: CaseRecord): string {
  switch (entry.kind) {
    case 'task':
      return `Task · ${clip(oneLine(entry.record.title))} (${entry.record.status})`
    case 'journal': {
      const what = entry.record.activity ? oneLine(entry.record.activity) : clip(oneLine(entry.record.body))
      return `Journal · ${formatDate(entry.record.occurredAt)}${what ? ` · ${what}` : ''}`
    }
    case 'time':
      return `Hours · ${durationText(entry.record.durationMinutes)} on ${formatDueDate(entry.record.workDate)}`
  }
}

export interface CaseRecords {
  status: 'loading' | 'ready' | 'error'
  /** Journal entries, tasks and hours, newest-first within each kind. */
  all: CaseRecord[]
  /** The label of a reference block. Safe to call from an editor at any time. */
  describe(ref: RecordRef): string
  /** Loads the lists again. */
  reload(): Promise<void>
  /** Makes a record just created here known at once (before any reload). */
  add(entry: CaseRecord): void
}

export function useCaseRecords(caseId: string): CaseRecords {
  const api = useCaseApi()
  const records = useRef<{ status: CaseRecords['status']; all: CaseRecord[]; byKey: Map<string, CaseRecord> }>({ status: 'loading', all: [], byKey: new Map() })
  const [, bump] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const apply = useCallback((status: CaseRecords['status'], all: CaseRecord[]) => {
    records.current = { status, all, byKey: new Map(all.map((e) => [`${e.kind}:${e.record.id}`, e])) }
    if (alive.current) bump((n) => n + 1)
  }, [])

  const reload = useCallback(async () => {
    try {
      const [journal, tasks, hours] = await Promise.all([api.listJournalEntries(caseId), api.listCaseTasks(caseId), api.listTimeEntries(caseId)])
      apply('ready', [
        ...journal.map((record): CaseRecord => ({ kind: 'journal', record })),
        ...tasks.map((record): CaseRecord => ({ kind: 'task', record })),
        ...hours.map((record): CaseRecord => ({ kind: 'time', record }))
      ])
    } catch {
      // Keep what is known; labels fall back to the plain kind names.
      apply(records.current.all.length > 0 ? 'ready' : 'error', records.current.all)
    }
  }, [api, caseId, apply])

  useEffect(() => {
    void reload()
  }, [reload])

  const describe = useCallback((ref: RecordRef): string => {
    const { status, byKey } = records.current
    const found = byKey.get(`${ref.kind}:${ref.id}`)
    if (found) return labelOf(found)
    return status === 'ready' ? NOT_AVAILABLE_LABEL : FALLBACK_LABELS[ref.kind]
  }, [])

  const add = useCallback(
    (entry: CaseRecord) => {
      const { status, all } = records.current
      apply(status, [entry, ...all.filter((e) => !(e.kind === entry.kind && e.record.id === entry.record.id))])
    },
    [apply]
  )

  return { status: records.current.status, all: records.current.all, describe, reload, add }
}
