import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { BACKUP_EXTENSION } from '../main/backup'
import { BackupInvalidError, inspectBackup, type AppData } from '../main/database/app-data'
import type { BackupChoice, BackupCreateResult, BackupRestoreResult, BackupStatus } from '../shared/ipc'
import { ensurePrivateDir } from './data-dir'

// Backup and restore for the Live web host (#110), using the same verified
// AppData backup and restore as the desktop app (#11), so backup files work in
// both. Instead of native dialogs: backups are written to <data>/backups and
// downloaded by the browser; a backup to restore is uploaded to <data>/uploads
// and checked before anything changes. The browser only ever sees file names.
//
// #117: after a backup is made and verified, <data>/backup-status.json records
// when, so the app can remind the researcher. It lives beside (not inside) the
// database folder, so a restore never replaces it: it describes backups made,
// not the data currently loaded. It is written only on success.

export const MAX_UPLOAD_BYTES = 512 * 1024 ** 2

export const BACKUP_STATUS_FILE = 'backup-status.json'

/** Only names this host generates can be downloaded. */
const BACKUP_FILE_NAME = /^Tracing Guatemala backup \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}(?: \d{1,3})?\.tgbackup$/

const pad = (n: number) => String(n).padStart(2, '0')

/** Named by local date and time, so the name matches the researcher's clock. */
export function backupFileName(now: Date, suffix = 0): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const stamp = `${date} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  return `Tracing Guatemala backup ${stamp}${suffix ? ` ${suffix}` : ''}.${BACKUP_EXTENSION}`
}

export function isBackupFileName(name: string): boolean {
  return BACKUP_FILE_NAME.test(name)
}

/** Shown back to the user, so keep only a plain, short name; never a path. */
function displayName(raw: string | null): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? ''
  const printable = [...base].filter((ch) => ch.charCodeAt(0) >= 0x20 && ch !== '\u007f').join('')
  const clean = printable.trim().slice(0, 120)
  return clean || 'Uploaded backup'
}

/** Anything else in the status file is treated as unknown. */
const statusFileSchema = z.object({
  lastBackupAt: z.iso.datetime(),
  fileName: z.string().refine(isBackupFileName),
  clients: z.number().int().nonnegative(),
  notes: z.number().int().nonnegative()
})

function logFailure(action: string, error: unknown): void {
  console.error(`Backup ${action} failed: ${error instanceof Error ? error.name : 'unknown error'}`)
}

export class UploadTooLargeError extends Error {
  constructor() {
    super('Upload exceeds the size limit')
    this.name = 'UploadTooLargeError'
  }
}

export interface WebBackupService {
  create(): BackupCreateResult
  /** When the last verified backup was made and how many are in the backups folder. Never paths. */
  status(): BackupStatus
  /** Path of a backup this host made, or null. */
  downloadPath(fileName: string): string | null
  /** Stores and checks an uploaded backup without changing any data. */
  acceptUpload(body: Readable, fileName: string | null, lastModified: Date | null): Promise<BackupChoice>
  restore(token: string): BackupRestoreResult
}

export function createWebBackupService(dataDir: string, data: () => AppData, now: () => Date = () => new Date()): WebBackupService {
  const backupsDir = join(dataDir, 'backups')
  const uploadsDir = join(dataDir, 'uploads')
  const statusFile = join(dataDir, BACKUP_STATUS_FILE)

  /** Atomic: a crash leaves the previous status, never half a file. */
  const recordBackup = (at: Date, fileName: string, clients: number, notes: number) => {
    const temp = join(dataDir, `.${BACKUP_STATUS_FILE}.${randomUUID()}.tmp`)
    try {
      writeFileSync(temp, JSON.stringify({ lastBackupAt: at.toISOString(), fileName, clients, notes }))
      renameSync(temp, statusFile)
    } catch (error) {
      rmSync(temp, { force: true })
      // The backup itself is good; only the reminder can't be updated.
      logFailure('status', error)
    }
  }

  // Leftover uploads from an earlier run can never be restored: their tokens are gone.
  rmSync(uploadsDir, { recursive: true, force: true })

  // Like the desktop: only the most recently checked upload can be restored, and only once.
  let pending: { token: string; path: string } | null = null
  const discardPending = () => {
    if (pending) rmSync(pending.path, { force: true })
    pending = null
  }

  return {
    create() {
      try {
        ensurePrivateDir(backupsDir)
        const taken = new Set(readdirSync(backupsDir))
        const at = now()
        let suffix = 0
        while (taken.has(backupFileName(at, suffix))) suffix++
        const fileName = backupFileName(at, suffix)
        const summary = data().createBackup(join(backupsDir, fileName))
        recordBackup(at, fileName, summary.clients, summary.notes)
        return { ok: true, fileName, clients: summary.clients, notes: summary.notes }
      } catch (error) {
        logFailure('create', error)
        return { ok: false, reason: 'failed' }
      }
    },

    status() {
      let count = 0
      try {
        count = readdirSync(backupsDir).filter(isBackupFileName).length
      } catch {
        // No backups folder yet.
      }
      try {
        const recorded = statusFileSchema.safeParse(JSON.parse(readFileSync(statusFile, 'utf8')))
        if (recorded.success) return { lastBackupAt: recorded.data.lastBackupAt, fileName: recorded.data.fileName, backupCount: count }
      } catch {
        // Missing or unreadable: unknown, not an error.
      }
      return { lastBackupAt: null, fileName: null, backupCount: count }
    },

    downloadPath(fileName) {
      if (!isBackupFileName(fileName)) return null
      const path = join(backupsDir, fileName)
      return existsSync(path) ? path : null
    },

    async acceptUpload(body, fileName, lastModified) {
      discardPending()
      ensurePrivateDir(uploadsDir)
      const path = join(uploadsDir, `${randomUUID()}.${BACKUP_EXTENSION}`)
      try {
        // The host rejects oversized uploads by Content-Length first; this backstop
        // covers a body that is longer than announced.
        let received = 0
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            received += chunk.length
            done(received > MAX_UPLOAD_BYTES ? new UploadTooLargeError() : null, chunk)
          }
        })
        await pipeline(body, limit, createWriteStream(path, { flags: 'wx' }))
        const summary = inspectBackup(path)
        const token = randomUUID()
        pending = { token, path }
        return {
          ok: true,
          token,
          fileName: displayName(fileName),
          savedAt: (lastModified ?? now()).toISOString(),
          clients: summary.clients,
          notes: summary.notes
        }
      } catch (error) {
        rmSync(path, { force: true })
        if (error instanceof UploadTooLargeError) throw error
        if (error instanceof BackupInvalidError) return { ok: false, reason: error.problem }
        logFailure('check', error)
        return { ok: false, reason: 'failed' }
      }
    },

    restore(token) {
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
      } finally {
        rmSync(path, { force: true })
      }
    }
  }
}
