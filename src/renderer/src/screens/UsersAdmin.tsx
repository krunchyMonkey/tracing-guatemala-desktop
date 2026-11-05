import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { checkEmail, checkUserName, USER_NAME_MAX, type AppUser, type SignInRequest, type UserFailure, type UserMutationResult, type UserRole } from '../../../shared/users'
import { Alert, ConfirmDialog, formatDateTime } from '../clients/components'
import { ROLE_LABELS } from '../components/HttpRiskBanner'
import type { UserAdminApi } from '../runtime/AppRuntime'

// Settings → Users (#181): a small owner-managed directory. Who may sign in is
// decided by the owner here; the host enforces it on every call, so hiding this
// section from researchers is only a courtesy. No email is ever sent: a person
// becomes active once their sign-in request is approved or linked.

const FAILURES: Record<UserFailure, string> = {
  'last-owner': 'You can’t remove the last active owner. Make someone else an owner first.',
  stale: 'This person was changed somewhere else. The list was reloaded — check it and try again.',
  'identity-in-use': 'That Google account is already used by another person.',
  'already-bound': 'That person already has a Google account linked.',
  full: 'The directory is full. Remove or disable someone first.',
  'not-found': 'That person or request no longer exists. The list was reloaded.',
  'request-not-found': 'That sign-in request no longer exists. The list was reloaded.',
  invalid: 'That change isn’t allowed. Nothing was changed.'
}

const STATUS_LABELS = { pending: 'Waiting for sign-in', active: 'Active', disabled: 'Turned off' } as const

type Pending =
  | { kind: 'approve'; request: SignInRequest }
  | { kind: 'link'; request: SignInRequest }
  | { kind: 'role'; user: AppUser; role: UserRole }
  | { kind: 'disable'; user: AppUser }
  | { kind: 'revoke'; user: AppUser }

export function UsersAdmin({ users }: { users: UserAdminApi }) {
  const [list, setList] = useState<AppUser[] | null>(null)
  const [requests, setRequests] = useState<SignInRequest[]>([])
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  const load = useCallback(async () => {
    try {
      const [people, asks] = await Promise.all([users.listUsers(), users.listSignInRequests()])
      setList(people)
      setRequests(asks)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [users])

  useEffect(() => {
    let cancelled = false
    void Promise.all([users.listUsers(), users.listSignInRequests()])
      .then(([people, asks]) => {
        if (cancelled) return
        setList(people)
        setRequests(asks)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [users])

  /** Runs one change: reports the reason in words, reloads on success and whenever the list may be out of date. */
  async function act(success: string, call: () => Promise<UserMutationResult | { dismissed: boolean }>) {
    setBusy(true)
    setNotice(null)
    setPending(null)
    try {
      const result = await call()
      if ('dismissed' in result) {
        setNotice({ tone: 'success', text: success })
      } else if (result.ok) {
        setNotice({ tone: 'success', text: success })
      } else {
        setNotice({ tone: 'error', text: FAILURES[result.reason] ?? FAILURES.invalid })
      }
      await load()
    } catch {
      setNotice({ tone: 'error', text: 'Something went wrong. Nothing was changed. Please try again.' })
      await load()
    } finally {
      setBusy(false)
    }
  }

  const linkable = (list ?? []).filter((user) => user.identity === null && user.status !== 'disabled')

  return (
    <section aria-labelledby="users-heading" className="card users-admin" data-testid="users-admin">
      <h2 id="users-heading">Users</h2>
      <p>
        Only people you approve can sign in. When someone signs in with Google and isn’t approved yet, their request appears below for you to
        approve.
      </p>
      <div role="status" aria-live="polite">
        {notice?.tone === 'success' && <p className="flash">{notice.text}</p>}
      </div>
      {notice?.tone === 'error' && (
        <Alert tone="error" title="Not done">
          {notice.text}
        </Alert>
      )}
      {loadFailed && (
        <Alert tone="error" title="Users unavailable">
          The list of people couldn’t be loaded.{' '}
          <button type="button" className="link-button" onClick={() => void load()}>
            Try again
          </button>
        </Alert>
      )}

      <h3>People</h3>
      {list === null ? (
        <p className="muted">{loadFailed ? '' : 'Loading people…'}</p>
      ) : list.length === 0 ? (
        <p className="muted">Nobody has been added yet.</p>
      ) : (
        <table className="client-table users-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Last sign-in</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.map((user) => {
              const email = user.identity?.email ?? user.contactEmail
              return (
                <tr key={user.id} data-testid={`user-${user.id}`}>
                  <th scope="row">{user.displayName}</th>
                  <td data-label="Email">{email ?? '—'}</td>
                  <td data-label="Role">
                    <span className={`badge role-badge role-${user.role}`}>{ROLE_LABELS[user.role]}</span>
                  </td>
                  <td data-label="Status">{STATUS_LABELS[user.status]}</td>
                  <td data-label="Last sign-in">{user.lastSignInAt ? formatDateTime(user.lastSignInAt) : 'Never'}</td>
                  <td className="user-actions">
                    <div className="button-row">
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy}
                        aria-label={`Make ${user.displayName} ${user.role === 'owner' ? 'a researcher' : 'an owner'}`}
                        onClick={() => setPending({ kind: 'role', user, role: user.role === 'owner' ? 'researcher' : 'owner' })}
                      >
                        {user.role === 'owner' ? 'Make researcher' : 'Make owner'}
                      </button>
                      {user.status === 'disabled' ? (
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={busy}
                          aria-label={`Turn ${user.displayName} back on`}
                          onClick={() => void act(`${user.displayName} can sign in again.`, () => users.setUserStatus(user.id, 'active', user.version))}
                        >
                          Turn back on
                        </button>
                      ) : user.status === 'active' ? (
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={busy}
                          aria-label={`Turn off ${user.displayName}`}
                          onClick={() => setPending({ kind: 'disable', user })}
                        >
                          Turn off
                        </button>
                      ) : null}
                      {user.status !== 'pending' && (
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={busy}
                          aria-label={`Sign out ${user.displayName} everywhere`}
                          onClick={() => setPending({ kind: 'revoke', user })}
                        >
                          Sign out everywhere
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <h3>Sign-in requests</h3>
      {requests.length === 0 ? (
        <p className="muted">No one is waiting for approval.</p>
      ) : (
        <ul className="request-list">
          {requests.map((request) => (
            <li key={request.id} className="request-card" data-testid={`request-${request.id}`}>
              <p>
                <strong>{request.email ?? 'No email address'}</strong>
                {request.name ? <> — {request.name}</> : null}
              </p>
              {request.emailAuthoritative ? (
                <p>
                  <span className="badge badge-active">Google-managed address</span>
                </p>
              ) : (
                <p className="request-caution">
                  Google did not confirm this address belongs to a Google-managed domain — confirm with the person before approving.
                </p>
              )}
              <p className="muted">
                {request.attempts} {request.attempts === 1 ? 'attempt' : 'attempts'} · last seen {formatDateTime(request.lastSeenAt)}
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy}
                  aria-label={`Approve ${request.email ?? request.name ?? 'request'} as new user`}
                  onClick={() => setPending({ kind: 'approve', request })}
                >
                  Approve as new user
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy || linkable.length === 0}
                  aria-label={`Link ${request.email ?? request.name ?? 'request'} to an existing person`}
                  onClick={() => setPending({ kind: 'link', request })}
                >
                  Link to existing person
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  aria-label={`Dismiss ${request.email ?? request.name ?? 'request'}`}
                  onClick={() => void act('Request dismissed.', () => users.dismissSignInRequest(request.id))}
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AddPerson
        busy={busy}
        onAdd={(input) =>
          act(`${input.displayName} was added. They become active once you link their sign-in request.`, () => users.createUser(input))
        }
      />

      {pending?.kind === 'approve' && (
        <ApproveDialog
          request={pending.request}
          onCancel={() => setPending(null)}
          onConfirm={(displayName, role) =>
            void act(`${displayName} can now sign in as ${ROLE_LABELS[role].toLowerCase()}.`, () =>
              users.approveSignInRequest(pending.request.id, { displayName, role })
            )
          }
        />
      )}
      {pending?.kind === 'link' && (
        <LinkDialog
          request={pending.request}
          candidates={linkable}
          onCancel={() => setPending(null)}
          onConfirm={(person) =>
            void act(`${person.displayName} can now sign in with ${pending.request.email ?? 'that account'}.`, () =>
              users.approveSignInRequest(pending.request.id, { userId: person.id }, person.version)
            )
          }
        />
      )}
      {pending?.kind === 'role' && (
        <ConfirmDialog
          title={`Make ${pending.user.displayName} ${pending.role === 'owner' ? 'an owner' : 'a researcher'}?`}
          confirmLabel={pending.role === 'owner' ? 'Make owner' : 'Make researcher'}
          tone="caution"
          onCancel={() => setPending(null)}
          onConfirm={() =>
            void act(`${pending.user.displayName} is now ${pending.role === 'owner' ? 'an owner' : 'a researcher'}.`, () =>
              users.setUserRole(pending.user.id, pending.role, pending.user.version)
            )
          }
        >
          <p>
            {pending.role === 'owner'
              ? 'Owners can manage who may sign in. '
              : 'Researchers can no longer see or change who may sign in. '}
            Their current sessions end and they sign in again.
          </p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'disable' && (
        <ConfirmDialog
          title={`Turn off ${pending.user.displayName}?`}
          confirmLabel="Turn off"
          tone="caution"
          onCancel={() => setPending(null)}
          onConfirm={() =>
            void act(`${pending.user.displayName} was turned off.`, () => users.setUserStatus(pending.user.id, 'disabled', pending.user.version))
          }
        >
          <p>They are signed out right away and can’t sign in until you turn them back on. Their work is not deleted.</p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'revoke' && (
        <ConfirmDialog
          title={`Sign out ${pending.user.displayName} everywhere?`}
          confirmLabel="Sign out everywhere"
          tone="caution"
          onCancel={() => setPending(null)}
          onConfirm={() => void act(`${pending.user.displayName} was signed out everywhere.`, () => users.revokeUserSessions(pending.user.id))}
        >
          <p>Every browser and device they are signed in on ends its session. They can sign in again with Google.</p>
        </ConfirmDialog>
      )}
    </section>
  )
}

function RoleSelect({ id, value, onChange }: { id: string; value: UserRole; onChange: (role: UserRole) => void }) {
  return (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value === 'owner' ? 'owner' : 'researcher')}>
      <option value="researcher">Researcher</option>
      <option value="owner">Owner</option>
    </select>
  )
}

function ApproveDialog({
  request,
  onConfirm,
  onCancel
}: {
  request: SignInRequest
  onConfirm: (displayName: string, role: UserRole) => void
  onCancel: () => void
}) {
  const nameId = useId()
  const roleId = useId()
  const [name, setName] = useState(request.name ?? '')
  const [role, setRole] = useState<UserRole>('researcher')
  const checked = checkUserName(name)
  return (
    <ConfirmDialog
      title="Approve as new user"
      confirmLabel="Approve"
      confirmDisabled={checked === null}
      onCancel={onCancel}
      onConfirm={() => checked && onConfirm(checked, role)}
    >
      <p>
        {request.email ?? 'This Google account'} will be able to sign in with Google.
        {!request.emailAuthoritative && ' Google did not confirm this address belongs to a Google-managed domain — confirm with the person first.'}
      </p>
      <div className="field">
        <label htmlFor={nameId}>Name</label>
        <input id={nameId} type="text" value={name} maxLength={USER_NAME_MAX} autoComplete="off" onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={roleId}>Role</label>
        <RoleSelect id={roleId} value={role} onChange={setRole} />
      </div>
    </ConfirmDialog>
  )
}

function LinkDialog({
  request,
  candidates,
  onConfirm,
  onCancel
}: {
  request: SignInRequest
  candidates: AppUser[]
  onConfirm: (person: AppUser) => void
  onCancel: () => void
}) {
  const id = useId()
  const [chosen, setChosen] = useState(candidates[0]?.id ?? '')
  const person = candidates.find((candidate) => candidate.id === chosen)
  return (
    <ConfirmDialog
      title="Link to an existing person"
      confirmLabel="Link"
      confirmDisabled={!person}
      onCancel={onCancel}
      onConfirm={() => person && onConfirm(person)}
    >
      <p>
        Choose the person {request.email ?? 'this Google account'} belongs to. Only people without a Google account linked yet are listed.
        {!request.emailAuthoritative && ' Google did not confirm this address belongs to a Google-managed domain — confirm with the person first.'}
      </p>
      <div className="field">
        <label htmlFor={id}>Person</label>
        <select id={id} value={chosen} onChange={(event) => setChosen(event.target.value)}>
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.displayName} ({ROLE_LABELS[candidate.role]})
            </option>
          ))}
        </select>
      </div>
    </ConfirmDialog>
  )
}

function AddPerson({ busy, onAdd }: { busy: boolean; onAdd: (input: { displayName: string; role: UserRole; contactEmail?: string }) => Promise<void> }) {
  const nameId = useId()
  const roleId = useId()
  const emailId = useId()
  const [name, setName] = useState('')
  const [role, setRole] = useState<UserRole>('researcher')
  const [email, setEmail] = useState('')
  const checkedName = checkUserName(name)
  const checkedEmail = email.trim() === '' ? undefined : checkEmail(email)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (checkedName === null || checkedEmail === null) return
    await onAdd({ displayName: checkedName, role, ...(checkedEmail ? { contactEmail: checkedEmail } : {}) })
    setName('')
    setEmail('')
  }

  return (
    <form onSubmit={(event) => void submit(event)} aria-labelledby="add-person-heading" className="add-person">
      <h3 id="add-person-heading">Add person</h3>
      <p className="muted">
        This only prepares a place for them. They become active once you link their sign-in request above, after they try to sign in with
        Google. Nothing is emailed to them.
      </p>
      <div className="field">
        <label htmlFor={nameId}>Name</label>
        <input id={nameId} type="text" value={name} maxLength={USER_NAME_MAX} autoComplete="off" onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={roleId}>Role</label>
        <RoleSelect id={roleId} value={role} onChange={setRole} />
      </div>
      <div className="field">
        <label htmlFor={emailId}>Contact email (optional)</label>
        <input id={emailId} type="email" value={email} autoComplete="off" onChange={(event) => setEmail(event.target.value)} />
        {checkedEmail === null && <span className="muted">That doesn’t look like an email address.</span>}
      </div>
      <div className="button-row">
        <button type="submit" className="button button-primary" disabled={busy || checkedName === null || checkedEmail === null}>
          Add person
        </button>
      </div>
    </form>
  )
}
