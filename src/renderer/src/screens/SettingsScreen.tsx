import { useEffect, useState } from 'react'
import type { AppInfo, BackupChoice, BackupProblem, BackupStatus } from '../../../shared/ipc'
import { useClientStore } from '../clients/ClientStore'
import { Alert, ConfirmDialog, formatDateTime } from '../clients/components'
import { useAppRuntime, type BackupApi, type LanAdminApi, type LanDevice } from '../runtime/AppRuntime'
import { describeAge, daysSince, useBackupStatus } from '../runtime/useBackupStatus'

// Settings & Backup (#11). On the desktop, backups are made and restored by the
// main process through native file dialogs; in the Live web app (#110) the host
// keeps a copy and the browser downloads one, and a restore is uploaded. The Live
// app also shows when the last verified backup was made and explains that data
// is not encrypted (#117). This screen never sees file paths. The browser demo (#100) has no backups and says
// so instead of offering the controls.

type Ready = Extract<BackupChoice, { ok: true }>

const problemMessages: Record<BackupProblem | 'failed', string> = {
  'not-a-backup': 'That file isn’t a Tracing Guatemala backup. Choose a file made with “Create backup”.',
  damaged: 'That backup file is damaged and can’t be used. Try another backup.',
  'too-new': 'That backup was made by a newer version of Tracing Guatemala. Install that version to restore it.',
  failed: 'Something went wrong. Nothing was changed. Please try again.'
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function SettingsScreen() {
  const runtime = useAppRuntime()
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    runtime.data
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
  }, [runtime])

  return (
    <section aria-labelledby="settings-heading" className="settings">
      <h1 id="settings-heading">Settings &amp; Backup</h1>

      {runtime.mode === 'live' && runtime.remote ? (
        <RemoteSection signOut={runtime.signOut} />
      ) : runtime.backup ? (
        <>
          <section aria-labelledby="data-heading">
            <h2 id="data-heading">Your data</h2>
            <p>
              Your clients, notes and contact history are stored only on this computer, in your user account’s app
              data folder. Nothing is sent over the internet, and nothing is uploaded to the cloud.
            </p>
          </section>
          <BackupSection backup={runtime.backup} web={runtime.mode === 'live'} />
          {runtime.mode === 'live' && runtime.lan && <HomeNetworkDevices lan={runtime.lan} />}
          {runtime.mode === 'live' && <EncryptionNotice />}
        </>
      ) : (
        <>
          <section aria-labelledby="data-heading">
            <h2 id="data-heading">Demo data</h2>
            <p>
              This is a browser demo with <strong>fictional data only</strong>. Your changes are kept in this browser
              tab’s memory and are never saved to this device or sent anywhere. Refreshing the page or opening it again
              goes back to the sample clients.
            </p>
          </section>
          <section aria-labelledby="backup-heading" className="card">
            <h2 id="backup-heading">Backup</h2>
            <p>
              Backup and restore are only available in the desktop app, where your real data is stored. The demo has
              nothing to back up.
            </p>
          </section>
        </>
      )}

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
    </section>
  )
}

/** A paired home-network device (#136): backups stay on the researcher's computer. */
function RemoteSection({ signOut }: { signOut?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function signOutThisDevice() {
    if (!signOut) return
    setBusy(true)
    setFailed(false)
    try {
      await signOut()
      window.location.reload()
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="remote-heading" className="card">
      <h2 id="remote-heading">This device</h2>
      <p>Backups are managed on the researcher’s computer.</p>
      <p className="muted">
        This device is paired over the home network, which is not encrypted: anything you open here can be read by someone else on that network.
      </p>
      {failed && (
        <Alert tone="error" title="Not signed out">
          This device couldn’t be signed out. Please try again.
        </Alert>
      )}
      <div className="button-row">
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => void signOutThisDevice()}>
          Sign out this device
        </button>
      </div>
    </section>
  )
}

/** Host only, and only while the home-network listener is on. The code is shown, never stored. */
function HomeNetworkDevices({ lan }: { lan: LanAdminApi }) {
  const [enabled, setEnabled] = useState(false)
  const [devices, setDevices] = useState<LanDevice[]>([])
  const [code, setCode] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    lan
      .getLanStatus()
      .then(async (status) => {
        if (cancelled || !status.enabled) return
        setEnabled(true)
        const list = await lan.listDevices()
        if (!cancelled) setDevices(list)
      })
      .catch(() => {
        // Without a status the section stays hidden.
      })
    return () => {
      cancelled = true
    }
  }, [lan])

  if (!enabled) return null

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setFailed(false)
    try {
      await action()
      setDevices(await lan.listDevices())
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="devices-heading" className="card">
      <h2 id="devices-heading">Home-network devices</h2>
      <p>
        Pairing controls who can sign in from the home network. It does <strong>not</strong> encrypt anything: the code, sessions and everything a
        paired device opens travel over unencrypted HTTP.
      </p>
      {failed && (
        <Alert tone="error" title="Not done">
          Something went wrong. Please try again.
        </Alert>
      )}
      <div className="button-row">
        <button
          type="button"
          className="button button-primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const made = await lan.createPairingCode()
              setCode(made.code)
            })
          }
        >
          Show pairing code
        </button>
      </div>
      {code && (
        <div role="status" aria-live="polite" data-testid="pairing-code">
          <p>
            Pairing code: <strong>{code}</strong>
          </p>
          <p className="muted">Expires in 5 minutes. It works once.</p>
        </div>
      )}

      <h3>Paired devices</h3>
      {devices.length === 0 ? (
        <p className="muted">No devices are paired.</p>
      ) : (
        <ul>
          {devices.map((device) => (
            <li key={device.id}>
              <strong>{device.name}</strong>, paired {formatDateTime(device.enrolledAt)}, last seen {formatDateTime(device.lastSeenAt)}{' '}
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                aria-label={`Revoke ${device.name}`}
                onClick={() => void run(async () => void (await lan.revokeDevice(device.id)))}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <button
          type="button"
          className="button button-secondary"
          disabled={busy || devices.length === 0}
          onClick={() => void run(async () => void (await lan.revokeAllDevices()))}
        >
          Sign out all devices
        </button>
      </div>
    </section>
  )
}

function BackupSection({ backup, web }: { backup: BackupApi; web: boolean }) {
  const { reload } = useClientStore()
  const backupStatus = useBackupStatus()
  const [busy, setBusy] = useState<'backup' | 'choose' | 'restore' | null>(null)
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [pendingRestore, setPendingRestore] = useState<Ready | null>(null)

  async function run<T>(kind: NonNullable<typeof busy>, call: () => Promise<T>): Promise<T | null> {
    setBusy(kind)
    setMessage(null)
    try {
      return await call()
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      setMessage({
        tone: 'error',
        text:
          code === 'restore-disabled-while-lan'
            ? 'Restoring a backup is turned off while the home-network listener is on, so real records can’t be imported into a profile other devices can reach. Restart without --lan-host to restore.'
            : problemMessages.failed
      })
      return null
    } finally {
      setBusy(null)
    }
  }

  async function createBackup() {
    const result = await run('backup', () => backup.createBackup())
    if (!result || (!result.ok && result.reason === 'cancelled')) return
    if (result.ok) backupStatus.refresh()
    setMessage(
      result.ok
        ? {
            tone: 'success',
            text: web
              ? `Backup “${result.fileName}” made, with ${plural(result.clients, 'client')} and ${plural(result.notes, 'note')}. A copy is kept in the app’s backups folder and your browser is downloading another. Keep it somewhere private.`
              : `Backup saved as “${result.fileName}”, with ${plural(result.clients, 'client')} and ${plural(result.notes, 'note')}. Keep it somewhere private.`
          }
        : { tone: 'error', text: 'The backup couldn’t be saved. Nothing was changed. Try another folder or drive.' }
    )
  }

  async function chooseBackup() {
    const choice = await run('choose', () => backup.chooseBackupToRestore())
    if (!choice) return
    if (choice.ok) setPendingRestore(choice)
    else if (choice.reason !== 'cancelled') setMessage({ tone: 'error', text: problemMessages[choice.reason] })
  }

  async function restore(choice: Ready) {
    setPendingRestore(null)
    const result = await run('restore', () => backup.restoreBackup(choice.token))
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
    <section aria-labelledby="backup-heading" className="card">
      <h2 id="backup-heading">Backup</h2>
      <p>
        A backup is one file with all your clients, notes and contact history. It is <strong>not encrypted</strong>:
        anyone who opens the file can read it. Save it somewhere private, such as your own external drive, and make a
        new one regularly.
      </p>
      {backupStatus.supported && <BackupStatusLine status={backupStatus.status} failed={backupStatus.failed} />}
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

/** Only backups this app verified are counted; nothing here guesses or claims more. */
function BackupStatusLine({ status, failed }: { status: BackupStatus | null; failed: boolean }) {
  if (!status) return <p className="muted">{failed ? 'Backup status is unavailable right now.' : 'Checking your last backup…'}</p>
  return (
    <div data-testid="backup-status">
      <p>
        {status.lastBackupAt ? (
          <>
            Last backup: <strong>{formatDateTime(status.lastBackupAt)}</strong> ({describeAge(daysSince(status.lastBackupAt))})
          </>
        ) : (
          <strong>No backup made yet</strong>
        )}
      </p>
      <p className="muted">{plural(status.backupCount, 'backup')} in the app’s backups folder.</p>
    </div>
  )
}

function EncryptionNotice() {
  return (
    <section aria-labelledby="encryption-heading" className="card">
      <h2 id="encryption-heading">Your data is not encrypted</h2>
      <p>
        The database, every backup, and the safety copies the app makes before an upgrade or a restore are plain files:
        anyone who can open them can read your clients’ information.
      </p>
      <ul>
        <li>
          Keep this computer’s disk encrypted: BitLocker on Windows, FileVault on macOS. Use a strong sign-in password.
        </li>
        <li>Keep a copy of your backups off this computer, on an encrypted drive that only you use.</li>
        <li>Never email backups or put them in a shared or public folder.</li>
        <li>
          Nothing is ever deleted automatically. When you have newer backups, remove old ones yourself. A good habit:
          keep the last 5, plus one from each month.
        </li>
      </ul>
    </section>
  )
}
