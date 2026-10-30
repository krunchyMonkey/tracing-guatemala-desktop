import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ACTIVITY_TYPES,
  formatClock,
  formatMinutes,
  HEARTBEAT_INTERVAL_MS,
  roundToMinutes,
  TIME_MAX_MINUTES,
  TIME_NOTE_MAX,
  TIMER_MIN_SECONDS,
  type ActivityType,
  type StopOptions,
  type TimerResult,
  type TimerSnapshot
} from '../../../shared/case-time'
import { ConfirmDialog } from '../clients/components'
import { useAppRuntime } from '../runtime/AppRuntime'
import { activityLabels } from './hoursText'

// The one research timer (#109). The host is the source of truth: it keeps the
// timer in its database, so closing or refreshing this page never loses it. This
// provider mirrors it. While running, the page shows seconds counted with
// performance.now() between server syncs (the monotonic clock, immune to wall
// clock changes) and sends a heartbeat every 30 seconds. If the page was away
// (closed, asleep, clock changed) the host flags the timer for review; nothing is
// ever saved or counted without the person confirming the minutes.

interface Synced {
  timer: TimerSnapshot | null
  /** performance.now() when `timer` arrived. */
  syncedAt: number
  loaded: boolean
}

export interface TimerApi {
  loaded: boolean
  timer: TimerSnapshot | null
  syncedAt: number
  caseTitle: string | null
  busy: boolean
  /** A short problem or explanation about the timer (a stale click, a lost connection). */
  notice: string | null
  dismissNotice(): void
  /** Bumps whenever the timer saved an entry, so entry lists reload. */
  entriesVersion: number
  requestStart(caseId: string, caseTitle: string): void
  pause(): void
  resume(): void
  requestStop(): void
  reopenReview(): void
}

const TimerContext = createContext<TimerApi | null>(null)

export function useTimer(): TimerApi {
  const value = useContext(TimerContext)
  if (!value) throw new Error('useTimer needs a TimerProvider')
  return value
}

const messages = {
  failed: 'Couldn’t reach the timer. Nothing was changed; please try again.',
  conflict: 'The timer was changed somewhere else (another tab or window). It has been refreshed; check it and try again.',
  gone: 'There is no timer running any more.',
  blocked: 'This case or its client is archived, so the time can’t be saved. You can discard the timer instead.'
}

type Dialog =
  | null
  | { kind: 'stop' }
  | { kind: 'switch'; toCaseId: string; toTitle: string; problem: 'too-short' | 'blocked' | null }

export function TimerProvider({ children }: { children: ReactNode }) {
  const { cases } = useAppRuntime()
  const [synced, setSynced] = useState<Synced>({ timer: null, syncedAt: 0, loaded: cases === null })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [entriesVersion, setEntriesVersion] = useState(0)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [titles, setTitles] = useState<Record<string, string>>({})
  const busyRef = useRef(false)
  const versionRef = useRef<number | null>(null)
  const reviewShownFor = useRef<number | null>(null)
  const timer = synced.timer
  // Layout effect: the version must be current before any interval tick or click can read it.
  useLayoutEffect(() => {
    versionRef.current = timer?.version ?? null
  })

  const apply = useCallback((next: TimerSnapshot | null) => setSynced({ timer: next, syncedAt: performance.now(), loaded: true }), [])

  const refresh = useCallback(async () => {
    if (!cases) return
    try {
      apply(await cases.getActiveTimer())
    } catch {
      setSynced((s) => ({ ...s, loaded: true }))
    }
  }, [cases, apply])

  // Load on start, and again whenever the page comes back (a tab can sleep for hours).
  useEffect(() => {
    void refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [refresh])

  // The case title shown with the timer.
  const timerCaseId = timer?.caseId ?? null
  useEffect(() => {
    if (!cases || timerCaseId === null) return
    let current = true
    cases.getCase(timerCaseId).then(
      (found) => {
        if (current && found) setTitles((t) => ({ ...t, [timerCaseId]: found.title }))
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [cases, timerCaseId])

  // Heartbeat: only while the page is counting and the host still vouches for it.
  const heartbeating = timer?.state === 'running' && !timer.needsReview
  useEffect(() => {
    if (!cases || !heartbeating) return
    const id = window.setInterval(() => {
      const version = versionRef.current
      if (version === null || busyRef.current) return
      cases.heartbeatTimer(version).then(
        (result) => {
          if (result.ok) apply(result.timer)
          else if (result.reason === 'conflict') apply(result.timer)
          else if (result.reason === 'not-found') apply(null)
        },
        () => undefined
      )
    }, HEARTBEAT_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [cases, heartbeating, apply])

  // A timer that needs review opens the review once per version; "Decide later" leaves a button on the pill.
  const needsReview = timer?.needsReview === true
  const version = timer?.version ?? null
  useEffect(() => {
    if (needsReview && version !== null && reviewShownFor.current !== version) {
      reviewShownFor.current = version
      setDialog((d) => d ?? { kind: 'stop' })
    }
  }, [needsReview, version])

  /** Absorbs any timer reply into the page; returns the reply (null when the call itself failed). */
  const run = useCallback(
    async (call: () => Promise<TimerResult>, announce?: (result: TimerResult) => string | null): Promise<TimerResult | null> => {
      if (!cases || busyRef.current) return null
      busyRef.current = true
      setBusy(true)
      setNotice(null)
      let result: TimerResult
      try {
        result = await call()
      } catch {
        setNotice(messages.failed)
        return null
      } finally {
        busyRef.current = false
        setBusy(false)
      }
      if (result.ok) {
        apply(result.timer)
        if (result.entry) setEntriesVersion((n) => n + 1)
        const text = announce?.(result)
        if (text) setAnnouncement(text)
      } else if (result.reason === 'conflict') {
        apply(result.timer)
        setNotice(messages.conflict)
      } else if (result.reason === 'needs-review' || result.reason === 'other-case-timer') {
        apply(result.timer)
      } else if (result.reason === 'not-found') {
        apply(null)
        setNotice(messages.gone)
      }
      return result
    },
    [cases, apply]
  )

  const titleOf = (caseId: string) => titles[caseId] ?? 'this case'
  const caseTitle = timer ? (titles[timer.caseId] ?? null) : null

  const api: TimerApi = useMemo(
    () => ({
      loaded: synced.loaded,
      timer,
      syncedAt: synced.syncedAt,
      caseTitle,
      busy,
      notice,
      dismissNotice: () => setNotice(null),
      entriesVersion,
      requestStart(caseId, title) {
        setTitles((t) => ({ ...t, [caseId]: title }))
        void run(
          () => cases!.startTimer(caseId),
          () => `Timer started on ${title}.`
        ).then((result) => {
          if (result && !result.ok && result.reason === 'other-case-timer') {
            setDialog({ kind: 'switch', toCaseId: caseId, toTitle: title, problem: null })
          } else if (result && !result.ok && result.reason === 'wrong-status') {
            setNotice('This case or its client is archived, so a timer can’t be started on it.')
          }
        })
      },
      pause() {
        if (versionRef.current === null) return
        void run(() => cases!.pauseTimer(versionRef.current!), () => 'Timer paused.')
      },
      resume() {
        if (versionRef.current === null) return
        void run(() => cases!.resumeTimer(versionRef.current!), () => 'Timer resumed.')
      },
      requestStop: () => setDialog({ kind: 'stop' }),
      reopenReview: () => setDialog({ kind: 'stop' })
    }),
    [synced.loaded, synced.syncedAt, timer, caseTitle, busy, notice, entriesVersion, run, cases]
  )

  async function save(options: StopOptions): Promise<TimerResult | null> {
    if (!timer) return null
    const title = titleOf(timer.caseId)
    const result = await run(
      () => cases!.stopAndSaveTimer(timer.version, options),
      (r) => (r.ok && r.entry ? `Saved ${formatMinutes(r.entry.durationMinutes)} hours to ${title}.` : null)
    )
    if (result?.ok) setDialog(null)
    else if (result && !result.ok && result.reason === 'conflict') setDialog(null)
    return result
  }

  async function discard(): Promise<void> {
    if (!timer) return
    const result = await run(
      () => cases!.discardTimer(timer.version),
      () => 'Timer discarded.'
    )
    if (result) setDialog(null)
  }

  async function switchHere(target: Extract<Dialog, { kind: 'switch' }>, how: 'save' | 'discard'): Promise<void> {
    if (!timer) return
    const stopped =
      how === 'save'
        ? await run(() => cases!.stopAndSaveTimer(timer.version, { activityType: null, note: null, durationMinutesOverride: null }))
        : await run(() => cases!.discardTimer(timer.version))
    if (!stopped) return
    if (!stopped.ok) {
      if (stopped.reason === 'too-short' || stopped.reason === 'wrong-status') {
        setDialog({ ...target, problem: stopped.reason === 'too-short' ? 'too-short' : 'blocked' })
      } else if (stopped.reason === 'needs-review') {
        setDialog({ kind: 'stop' })
      } else {
        setDialog(null)
      }
      return
    }
    setDialog(null)
    const started = await run(
      () => cases!.startTimer(target.toCaseId),
      () => `Timer started on ${target.toTitle}.`
    )
    if (started && !started.ok && started.reason === 'wrong-status') {
      setNotice('This case or its client is archived, so a timer can’t be started on it.')
    }
  }

  return (
    <TimerContext.Provider value={api}>
      {children}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {dialog?.kind === 'stop' && timer && (
        <StopDialog
          key={timer.version}
          timer={timer}
          syncedAt={synced.syncedAt}
          title={titleOf(timer.caseId)}
          busy={busy}
          onCancel={() => setDialog(null)}
          onSave={save}
          onDiscard={discard}
        />
      )}
      {dialog?.kind === 'switch' && timer && (
        <SwitchDialog
          from={titleOf(timer.caseId)}
          target={dialog}
          busy={busy}
          onCancel={() => setDialog(null)}
          onSave={() => switchHere(dialog, 'save')}
          onDiscard={() => switchHere(dialog, 'discard')}
        />
      )}
    </TimerContext.Provider>
  )
}

/** Seconds on the clock now: what the host counted when it last answered, plus monotonic time since. */
export function currentSeconds(timer: TimerSnapshot, syncedAt: number): number {
  const counting = timer.state === 'running' && !timer.needsReview
  return timer.elapsedSeconds + (counting ? Math.max(0, Math.floor((performance.now() - syncedAt) / 1000)) : 0)
}

/** h:mm:ss, ticking once a second only while counting. The tick is not announced to screen readers. */
export function ElapsedClock({ timer, syncedAt }: { timer: TimerSnapshot; syncedAt: number }) {
  const [, tick] = useState(0)
  const counting = timer.state === 'running' && !timer.needsReview
  useEffect(() => {
    if (!counting) return
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [counting])
  return (
    <span className="timer-clock" role="timer" aria-live="off">
      {formatClock(currentSeconds(timer, syncedAt))}
    </span>
  )
}

interface StopDialogProps {
  timer: TimerSnapshot
  syncedAt: number
  title: string
  busy: boolean
  onCancel(): void
  onSave(options: StopOptions): Promise<TimerResult | null>
  onDiscard(): Promise<void>
}

function StopDialog({ timer, syncedAt, title, busy, onCancel, onSave, onDiscard }: StopDialogProps) {
  const id = useId()
  const review = timer.needsReview
  // Frozen when the dialog opens, so the figure does not move under the person's hands.
  const [seconds] = useState(() => currentSeconds(timer, syncedAt))
  const tooShort = seconds < TIMER_MIN_SECONDS
  const [minutes, setMinutes] = useState(() => String(Math.max(1, roundToMinutes(seconds))))
  const [activity, setActivity] = useState<ActivityType | ''>('')
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const parsed = /^\d{1,4}$/.test(minutes.trim()) ? Number(minutes.trim()) : NaN
  const minutesError = Number.isNaN(parsed)
    ? 'Enter whole minutes.'
    : parsed < 1
      ? 'Enter at least 1 minute.'
      : parsed > TIME_MAX_MINUTES
        ? `Enter at most ${TIME_MAX_MINUTES} minutes (12 hours).`
        : null
  const noteError = note.trim().length > TIME_NOTE_MAX ? `Keep the note under ${TIME_NOTE_MAX} characters.` : null
  const blocked = tooShort || minutesError !== null || noteError !== null

  async function confirm() {
    setProblem(null)
    const result = await onSave({
      activityType: activity === '' ? null : activity,
      note: note.trim() === '' ? null : note,
      durationMinutesOverride: review || parsed !== Math.max(1, roundToMinutes(seconds)) ? parsed : null
    })
    if (result && !result.ok) {
      setProblem(
        result.reason === 'too-short'
          ? 'Under 30 seconds can’t be saved. Discard it instead.'
          : result.reason === 'wrong-status'
            ? messages.blocked
            : result.reason === 'invalid'
              ? 'Check the minutes, activity and note, then try again.'
              : result.reason === 'needs-review'
                ? 'This timer needs review first; check the minutes.'
                : result.reason === 'conflict'
                  ? messages.conflict
                  : messages.gone
      )
    } else if (!result) {
      setProblem(messages.failed)
    }
  }

  if (confirmDiscard) {
    return (
      <ConfirmDialog
        title="Discard this timer?"
        confirmLabel="Discard timer"
        tone="caution"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => void onDiscard()}
      >
        <p>
          The time counted on {title} will be thrown away and nothing will be saved. This can’t be undone.
        </p>
      </ConfirmDialog>
    )
  }

  return (
    <ConfirmDialog
      title={review ? 'Review the time before saving' : 'Save this time?'}
      confirmLabel={busy ? 'Saving…' : 'Save time'}
      confirmDisabled={blocked || busy}
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    >
      {review ? (
        <p>
          The timer on <strong>{title}</strong> was interrupted (the page was closed, the computer slept, or the clock
          changed). Only the time seen before then is suggested: {formatClock(timer.suggestedSeconds ?? 0)}. Nothing has
          been saved. Change the minutes if you remember better, or discard it.
        </p>
      ) : tooShort ? (
        <p>
          Only {Math.floor(seconds)} seconds were counted on <strong>{title}</strong>. Anything under 30 seconds can’t be
          saved; discard it instead.
        </p>
      ) : (
        <p>
          Counted on <strong>{title}</strong>: {formatClock(seconds)}, rounded to the nearest minute.
        </p>
      )}
      {!tooShort && (
        <div className="timer-stop-fields">
          <div className="field">
            <label htmlFor={`${id}-minutes`}>Minutes to save</label>
            <input
              id={`${id}-minutes`}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={minutes}
              aria-invalid={minutesError !== null}
              aria-describedby={minutesError ? `${id}-minutes-error` : undefined}
              onChange={(e) => setMinutes(e.target.value)}
            />
            {minutesError && (
              <p id={`${id}-minutes-error`} className="field-issues issue-error" role="alert">
                {minutesError}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor={`${id}-activity`}>Activity (optional)</label>
            <select id={`${id}-activity`} value={activity} onChange={(e) => setActivity(e.target.value as ActivityType | '')}>
              <option value="">Not specified</option>
              {ACTIVITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {activityLabels[type]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-note`}>Note (optional)</label>
            <textarea id={`${id}-note`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            {noteError && (
              <p className="field-issues issue-error" role="alert">
                {noteError}
              </p>
            )}
          </div>
        </div>
      )}
      {problem && (
        <p className="field-issues issue-error" role="alert">
          {problem}
        </p>
      )}
      <p>
        <button type="button" className="button button-small button-ghost" onClick={() => setConfirmDiscard(true)}>
          Discard this timer instead
        </button>
      </p>
    </ConfirmDialog>
  )
}

interface SwitchDialogProps {
  from: string
  target: Extract<Dialog, { kind: 'switch' }>
  busy: boolean
  onCancel(): void
  onSave(): Promise<void>
  onDiscard(): Promise<void>
}

function SwitchDialog({ from, target, busy, onCancel, onSave, onDiscard }: SwitchDialogProps) {
  if (target.problem) {
    return (
      <ConfirmDialog title="The other timer can’t be saved" confirmLabel="Discard it and start here" tone="caution" confirmDisabled={busy} onCancel={onCancel} onConfirm={() => void onDiscard()}>
        <p>
          {target.problem === 'too-short'
            ? `The timer on ${from} has under 30 seconds, which can’t be saved.`
            : `The timer on ${from} can’t be saved because its case or client is archived.`}{' '}
          Discard it and start a timer on <strong>{target.toTitle}</strong>?
        </p>
      </ConfirmDialog>
    )
  }
  return (
    <ConfirmDialog title="Switch the timer?" confirmLabel="Stop, save and start here" confirmDisabled={busy} onCancel={onCancel} onConfirm={() => void onSave()}>
      <p>
        Stop and save the timer on <strong>{from}</strong>, then start here (<strong>{target.toTitle}</strong>)?
      </p>
    </ConfirmDialog>
  )
}
