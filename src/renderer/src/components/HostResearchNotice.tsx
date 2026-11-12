import { useAppRuntime } from '../runtime/AppRuntime'

/**
 * Shown on Home and Clients when the host session cannot open research (#246): the profile has
 * accounts, and research belongs to the signed-in account. Informational; the host decides access.
 */
export function HostResearchNotice() {
  const runtime = useAppRuntime()
  if (runtime.mode !== 'live' || runtime.research !== 'none') return null
  return (
    <div className="alert alert-info" role="note" aria-labelledby="host-research-title">
      <p id="host-research-title" className="alert-title">
        Research opens with your own sign-in
      </p>
      <p>
        This computer’s host session manages the app (backups, network, accounts) but can’t open research once accounts exist.
        Sign in with your Google account to work on your research.
      </p>
    </div>
  )
}
