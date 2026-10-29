import { useEffect, useState } from 'react'
import type { AppInfo } from '../../../shared/ipc'

export function SettingsScreen() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

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

  return (
    <section aria-labelledby="settings-heading">
      <h1 id="settings-heading">Settings &amp; Backup</h1>

      <h2>Your data</h2>
      <p>All information is stored only on this computer. Nothing is sent over the internet.</p>

      <h2>Backup</h2>
      <p className="placeholder-note">Coming soon: back up and restore your data.</p>

      <h2>About</h2>
      {appInfo ? (
        <p data-testid="app-version">
          {appInfo.name} version {appInfo.version}
        </p>
      ) : (
        <p>{loadFailed ? 'Version information is unavailable.' : 'Loading version…'}</p>
      )}
    </section>
  )
}
