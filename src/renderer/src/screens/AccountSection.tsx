import { useEffect, useState } from 'react'
import type { AppUser } from '../../../shared/users'
import { Alert, ConfirmDialog } from '../clients/components'
import { ROLE_LABELS } from '../components/HttpRiskBanner'
import type { AccountApi, SignedInPerson } from '../runtime/AppRuntime'

// The signed-in person's own account on an HTTPS Google session (#181): who they
// are, sign out here, and sign out everywhere. Owners and researchers both see it.

export function AccountSection({ account, person, signOut }: { account: AccountApi; person: SignedInPerson; signOut?: () => Promise<void> }) {
  const [user, setUser] = useState<AppUser | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    account
      .getMyAccount()
      .then((mine) => {
        if (!cancelled) setUser(mine)
      })
      .catch(() => {
        // The name and role from the session are shown instead.
      })
    return () => {
      cancelled = true
    }
  }, [account])

  const name = user?.displayName ?? person.name
  const role = user?.role ?? person.role
  const email = user ? (user.identity?.email ?? user.contactEmail) : null

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setFailed(false)
    try {
      await action()
      // The session cookie is gone: the next load lands on the sign-in page.
      window.location.reload()
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="account-heading" className="card" data-testid="account-section">
      <h2 id="account-heading">Your account</h2>
      <dl className="detail-list">
        <div>
          <dt>Name</dt>
          <dd data-testid="account-name">{name}</dd>
        </div>
        {email && (
          <div>
            <dt>Email</dt>
            <dd data-testid="account-email">{email}</dd>
          </div>
        )}
        <div>
          <dt>Role</dt>
          <dd>
            <span className={`badge role-badge role-${role}`} data-testid="account-role">
              {ROLE_LABELS[role]}
            </span>
          </dd>
        </div>
      </dl>
      <p className="muted">Backups and home-network settings are managed on the researcher’s computer.</p>
      {failed && (
        <Alert tone="error" title="Not signed out">
          You couldn’t be signed out. Please try again.
        </Alert>
      )}
      <div className="button-row">
        <button type="button" className="button button-secondary" disabled={busy || !signOut} onClick={() => void run(() => signOut!())}>
          Sign out
        </button>
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => setConfirmAll(true)}>
          Sign out on all devices
        </button>
      </div>
      {confirmAll && (
        <ConfirmDialog
          title="Sign out on all devices?"
          confirmLabel="Sign out everywhere"
          tone="caution"
          onCancel={() => setConfirmAll(false)}
          onConfirm={() => {
            setConfirmAll(false)
            void run(() => account.revokeMySessions())
          }}
        >
          <p>Every browser and device signed in as you will be signed out, including this one. You can sign in again with Google.</p>
        </ConfirmDialog>
      )}
    </section>
  )
}
