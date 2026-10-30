import { useCallback, useEffect, useState } from 'react'
import type { BackupStatus } from '../../../shared/ipc'
import { useAppRuntime } from './AppRuntime'

// Backup status for the Live app (#117): when the last verified backup was made.
// Desktop and demo have none, so these helpers report nothing there.

/** A backup older than this many calendar days, or none at all, triggers the reminder. */
export const BACKUP_REMINDER_DAYS = 7

const startOfLocalDay = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())

/** Whole calendar days (local time) from `iso` to `now`; never negative. */
export function daysSince(iso: string, now: Date = new Date()): number {
  return Math.max(0, Math.round((startOfLocalDay(now) - startOfLocalDay(new Date(iso))) / 86_400_000))
}

export function describeAge(days: number): string {
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

export function backupIsDue(status: BackupStatus, now: Date = new Date()): boolean {
  return status.lastBackupAt === null || daysSince(status.lastBackupAt, now) > BACKUP_REMINDER_DAYS
}

export interface BackupStatusState {
  /** Null while loading, when the status can't be read, and on runtimes without one. */
  status: BackupStatus | null
  /** The status could not be read (so nothing should claim a backup exists or is missing). */
  failed: boolean
  /** Whether this runtime keeps a backup status at all. */
  supported: boolean
  refresh(): void
}

export function useBackupStatus(): BackupStatusState {
  const runtime = useAppRuntime()
  // Only the Live host keeps a backup status, whatever else a runtime carries.
  const backupStatus = runtime.mode === 'live' ? (runtime.backupStatus ?? null) : null
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!backupStatus) return
    let cancelled = false
    backupStatus()
      .then((next) => {
        if (cancelled) return
        setStatus(next)
        setFailed(false)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [backupStatus, version])

  const refresh = useCallback(() => setVersion((v) => v + 1), [])
  return { status, failed, supported: Boolean(backupStatus), refresh }
}
