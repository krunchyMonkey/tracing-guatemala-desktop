import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { BackupChoice, BackupCreateResult, BackupRestoreResult } from '../shared/ipc'
import { BackupInvalidError, inspectBackup, type AppData } from './database/app-data'
import type { BackupService } from './ipc'

// Backup and restore behind native file dialogs (#11). File paths stay in the
// main process: the renderer sees only a one-time token and the file name.
// Only error names are logged, never paths or contents.

export const BACKUP_EXTENSION = 'tgbackup'

export interface BackupDialogs {
  /** Returns the chosen path, or null if cancelled. */
  chooseSaveTarget(defaultName: string): Promise<string | null>
  chooseBackupFile(): Promise<string | null>
}

export function defaultBackupName(now: Date): string {
  const day = now.toISOString().slice(0, 10)
  return `Tracing Guatemala backup ${day}.${BACKUP_EXTENSION}`
}

function logFailure(action: string, error: unknown): void {
  console.error(`Backup ${action} failed: ${error instanceof Error ? error.name : 'unknown error'}`)
}

export function createBackupService(
  data: () => AppData,
  dialogs: BackupDialogs,
  now: () => Date = () => new Date()
): BackupService {
  // Only the most recently chosen backup can be restored, and only once.
  let pending: { token: string; path: string } | null = null

  return {
    async create(): Promise<BackupCreateResult> {
      const target = await dialogs.chooseSaveTarget(defaultBackupName(now()))
      if (!target) return { ok: false, reason: 'cancelled' }
      try {
        const summary = data().createBackup(target)
        return { ok: true, fileName: basename(target), clients: summary.clients, notes: summary.notes }
      } catch (error) {
        logFailure('create', error)
        return { ok: false, reason: 'failed' }
      }
    },

    async chooseRestore(): Promise<BackupChoice> {
      pending = null
      const path = await dialogs.chooseBackupFile()
      if (!path) return { ok: false, reason: 'cancelled' }
      try {
        const summary = inspectBackup(path)
        const token = randomUUID()
        pending = { token, path }
        return {
          ok: true,
          token,
          fileName: basename(path),
          savedAt: statSync(path).mtime.toISOString(),
          clients: summary.clients,
          notes: summary.notes
        }
      } catch (error) {
        if (error instanceof BackupInvalidError) return { ok: false, reason: error.problem }
        logFailure('check', error)
        return { ok: false, reason: 'failed' }
      }
    },

    async restore(token: string): Promise<BackupRestoreResult> {
      if (!pending || pending.token !== token) return { ok: false, reason: 'expired' }
      const { path } = pending
      pending = null
      try {
        const summary = data().restoreBackup(path)
        return { ok: true, clients: summary.clients, notes: summary.notes }
      } catch (error) {
        if (error instanceof BackupInvalidError) return { ok: false, reason: error.problem }
        logFailure('restore', error)
        return { ok: false, reason: 'failed' }
      }
    }
  }
}
