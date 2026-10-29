import { useEffect, useState } from 'react'
import type { AppInfo, BackupChoice, BackupProblem } from '../../../shared/ipc'
import { useClientStore } from '../clients/ClientStore'
import { Alert, ConfirmDialog, formatDateTime } from '../clients/components'

// Settings & Backup (#11). Backups are made and restored by the main process
// through native file dialogs; this screen never sees file paths.

type Ready = Extract<BackupChoice, { ok: true }>

const problemMessages: Record<BackupProblem | 'failed', string> = {
  'not-a-backup': 'That file isn’t a Tracing Guatemala backup. Choose a file made with “Create backup”.',
  damaged: 'That backup file is damaged and can’t be used. Try another backup.',
  'too-new': 'That backup was made by a newer version of Tracing Guatemala. Install that version to restore it.',
  failed: 'Something went wrong. Nothing was changed. Please try again.'
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function SettingsScreen() {
  const { reload } = useClientStore()
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<'backup' | 'choose' | 'restore' | null>(null)
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [pendingRestore, setPendingRestore] = useState<Ready | null>(null)

  useEffect(() => {
    let cancelled = false
    window.tracingGuatemala
      .getAppInfo()
      .then((info) => {
        if (!cancelled) setAppInfo(info)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function run<T>(kind: NonNullable<typeof busy>, call: () => Promise<T>): Promise<T | null> {
    setBusy(kind)
    setMessage(null)
    try {
      return await call()
    } catch {
      setMessage({ tone: 'error', text: problemMessages.failed })
      return null
    } finally {
      setBusy(null)
    }
  }

  async function createBackup() {
    const result = await run('backup', () => window.tracingGuatemala.createBackup())
    if (!result || (!result.ok && result.reason === 'cancelled')) return
    setMessage(
      result.ok
        ? {
            tone: 'success',
            text: `Backup saved as “${result.fileName}”, with ${plural(result.clients, 'client')} and ${plural(result.notes, 'note')}. Keep it somewhere private.`
          }
        : { tone: 'error', text: 'The backup couldn’t be saved. Nothing was changed. Try another folder or drive.' }
    )
  }

  async function chooseBackup() {
    const choice = await run('choose', () => window.tracingGuatemala.chooseBackupToRestore())
    if (!choice) return
    if (choice.ok) setPendingRestore(choice)
    else if (choice.reason !== 'cancelled') setMessage({ tone: 'error', text: problemMessages[choice.reason] })
  }

  async function restore(choice: Ready) {
    setPendingRestore(null)
    const result = await run('restore', () => window.tracingGuatemala.restoreBackup(choice.token))
    if (!result) return
    if (result.ok) {
      reload()
      setMessage({
        tone: 'success',
        text: `Backup restored: ${plural(result.clients, 'client')} and ${plural(result.notes, 'note')}. Your previous data was kept as a safety copy.`
      })
    } else if (result.reason === 'expired') {
      setMessage({ tone: 'error', text: 'Please choose the backup again. Nothing was changed.' })
    } else {
      setMessage({
        tone: 'error',
        text:
          result.reason === 'failed'
            ? 'The backup couldn’t be restored, so your previous data was kept unchanged.'
            : problemMessages[result.reason]
      })
    }
  }

  return (
    <section aria-labelledby="settings-heading" className="settings">
      <h1 id="settings-heading">Settings &amp; Backup</h1>

      <section aria-labelledby="data-heading">
        <h2 id="data-heading">Your data</h2>
        <p>
          Your clients, notes and contact history are stored only on this computer, in your user account’s app data
          folder. Nothing is sent over the internet, and nothing is uploaded to the cloud.
        </p>
      </section>

      <section aria-labelledby="backup-heading" className="card">
        <h2 id="backup-heading">Backup</h2>
        <p>
          A backup is one file with all your clients, notes and contact history. It is <strong>not encrypted</strong>:
          anyone who opens the file can read it. Save it somewhere private, such as your own external drive, and make a
          new one regularly.
        </p>
        <div role="status" aria-live="polite">
          {message?.tone === 'success' && <p className="flash">{message.text}</p>}
        </div>
        {message?.tone === 'error' && (
          <Alert tone="error" title="Not done">
            {message.text}
          </Alert>
        )}
        <div className="button-row">
          <button
            type="button"
            className="button button-primary"
            disabled={busy !== null}
            aria-busy={busy === 'backup'}
            onClick={() => void createBackup()}
          >
            {busy === 'backup' ? 'Saving backup…' : 'Create backup…'}
          </button>
        </div>

        <h3>Restore</h3>
        <p>
          Restoring replaces everything in the app with the contents of a backup. Before anything is replaced, your
          current data is kept as a safety copy on this computer.
        </p>
        <div className="button-row">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy !== null}
            aria-busy={busy === 'choose' || busy === 'restore'}
            onClick={() => void chooseBackup()}
          >
            {busy === 'restore' ? 'Restoring…' : 'Restore from backup…'}
          </button>
        </div>
      </section>

      <section aria-labelledby="about-heading">
        <h2 id="about-heading">About</h2>
        {appInfo ? (
          <p data-testid="app-version">
            {appInfo.name} version {appInfo.version}
          </p>
        ) : (
          <p>{loadFailed ? 'Version information is unavailable.' : 'Loading version…'}</p>
        )}
      </section>

      {pendingRestore && (
        <ConfirmDialog
          title="Replace all data with this backup?"
          confirmLabel="Replace with backup"
          tone="caution"
          onCancel={() => setPendingRestore(null)}
          onConfirm={() => void restore(pendingRestore)}
        >
          <p>
            “{pendingRestore.fileName}”, saved {formatDateTime(pendingRestore.savedAt)}, contains{' '}
            {plural(pendingRestore.clients, 'client')} and {plural(pendingRestore.notes, 'note')}.
          </p>
          <p>
            <strong>Everything currently in the app will be replaced.</strong> Your current data is kept as a safety
            copy first.
          </p>
        </ConfirmDialog>
      )}
    </section>
  )
}
