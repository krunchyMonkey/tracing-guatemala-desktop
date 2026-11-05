// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import type { AccountApi, AppRuntime, UserAdminApi } from '../../src/renderer/src/runtime/AppRuntime'
import { GoogleSignIn, SIGN_IN_SESSION_ENDED_MESSAGE, takeSignInReason } from '../../src/renderer/src/web/GoogleSignIn'
import type { AppUser, SignInRequest, UserMutationResult } from '../../src/shared/users'
import { createFakeApi } from './fakeApi'
import { emptySummary } from './fixtures/studio'

// Google sign-in screen, account section and Users administration (#181).
// Fictional people only; the user directory is an in-memory fake.

const switcher = { kind: 'unavailable', reason: 'not-available' } as const

beforeEach(() => {
  vi.stubGlobal('tracingGuatemala', createFakeApi().api)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

function person(overrides: Partial<AppUser> & Pick<AppUser, 'id' | 'displayName'>): AppUser {
  return {
    role: 'researcher',
    status: 'active',
    contactEmail: null,
    identity: null,
    authVersion: 1,
    version: 1,
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-01T09:00:00.000Z',
    lastSignInAt: null,
    ...overrides
  }
}

const withIdentity = (email: string): AppUser['identity'] => ({ provider: 'google', email, emailAuthoritative: true, boundAt: '2026-11-01T09:00:00.000Z' })

const alex = person({ id: 'u-alex', displayName: 'Alex Fictional', role: 'owner', identity: withIdentity('alex@example.test'), lastSignInAt: '2026-11-02T10:00:00.000Z' })
const bea = person({ id: 'u-bea', displayName: 'Bea Fictional', identity: withIdentity('bea@example.test'), version: 3 })
const dana = person({ id: 'u-dana', displayName: 'Dana Fictional', status: 'pending', contactEmail: 'dana@example.test', version: 2 })

const request = (id: string, over: Partial<SignInRequest> = {}): SignInRequest => ({
  id,
  email: 'cara@example.test',
  emailAuthoritative: true,
  name: 'Cara Fictional',
  firstSeenAt: '2026-11-03T08:00:00.000Z',
  lastSeenAt: '2026-11-03T08:30:00.000Z',
  attempts: 2,
  ...over
})

function directory(initialUsers: AppUser[] = [alex, bea, dana], initialRequests: SignInRequest[] = [request('r-cara')]) {
  const ok = async (): Promise<UserMutationResult> => ({ ok: true, user: bea })
  return {
    listUsers: vi.fn(async () => initialUsers),
    listSignInRequests: vi.fn(async () => initialRequests),
    createUser: vi.fn(ok),
    approveSignInRequest: vi.fn(ok),
    dismissSignInRequest: vi.fn(async (): Promise<{ dismissed: boolean }> => ({ dismissed: true })),
    setUserRole: vi.fn(ok),
    setUserStatus: vi.fn(ok),
    revokeUserSessions: vi.fn(ok)
  }
}

function googleRuntime(role: 'owner' | 'researcher', users?: ReturnType<typeof directory>, account?: Partial<AccountApi>, signOut = vi.fn(async () => undefined)): AppRuntime {
  const mine = role === 'owner' ? alex : bea
  return {
    mode: 'live',
    data: createFakeApi().api,
    backup: null,
    backupStatus: null,
    cases: { getStudioSummary: async () => emptySummary() } as never,
    switcher,
    remote: true,
    signOut,
    account: { getMyAccount: async () => mine, revokeMySessions: async () => ({ ok: true }), ...account },
    person: { name: mine.displayName, role },
    ...(users ? { users: users as unknown as UserAdminApi } : {})
  }
}

function openSettings(runtime: AppRuntime) {
  window.location.hash = '#/settings'
  return render(<App runtime={runtime} />)
}

describe('sign-in screen', () => {
  it('is a plain same-origin link with the branded button and no form or script', () => {
    const { container } = render(<GoogleSignIn />)
    // A link, not a form: the page CSP keeps form-action 'none'.
    expect(container.querySelector('form')).toBeNull()
    const link = screen.getByRole('link', { name: 'Sign in with Google' })
    expect(link.getAttribute('href')).toBe('/api/v1/auth/google/start')
    expect(link.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['not-approved', /isn’t approved for Tracing Guatemala yet.*owner can approve it from Users/],
    ['disabled', /turned off/],
    ['unavailable', /isn’t available right now/],
    ['expired', /took too long/],
    ['cancelled', /cancelled/],
    ['busy', /Too many sign-in attempts/],
    ['failed', /did not work/]
  ])('explains %s without claiming a notification', (reason, message) => {
    const { container } = render(<GoogleSignIn reason={reason} />)
    expect(screen.getByRole('alert').textContent).toMatch(message)
    expect(container.textContent).not.toMatch(/notified|exists|no account|not found|registered/i)
  })

  it('ignores an unknown reason and shows the session-ended message', () => {
    const { rerender } = render(<GoogleSignIn reason="__proto__" />)
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(<GoogleSignIn sessionEnded />)
    expect(screen.getByText(SIGN_IN_SESSION_ENDED_MESSAGE)).toBeTruthy()
    expect(SIGN_IN_SESSION_ENDED_MESSAGE).toBe('Your session ended. Sign in again.')
  })

  it('reads the reason once and removes it from the address bar', () => {
    window.history.replaceState(null, '', '/?signin=not-approved&keep=1#/x')
    expect(takeSignInReason()).toBe('not-approved')
    expect(window.location.search).toBe('?keep=1')
    expect(window.location.hash).toBe('#/x')
    expect(takeSignInReason()).toBeNull()
  })

  it('shows a no-network state with the button disabled, and recovers', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<GoogleSignIn />)
    expect(screen.getByText('No network connection')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Sign in with Google' }) as HTMLButtonElement).disabled).toBe(true)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(screen.queryByText('No network connection')).toBeNull()
    expect(screen.getByRole('link', { name: 'Sign in with Google' })).toBeTruthy()
  })
})

describe('account section', () => {
  it('shows name, email and role, and signs out', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, hash: '#/settings', reload })
    const signOut = vi.fn(async () => undefined)
    render(<App runtime={googleRuntime('researcher', undefined, undefined, signOut)} />)
    expect((await screen.findByTestId('account-name')).textContent).toBe('Bea Fictional')
    expect(screen.getByTestId('account-email').textContent).toBe('bea@example.test')
    expect(screen.getByTestId('account-role').textContent).toBe('Researcher')
    expect(screen.getByTestId('signed-in-person').textContent).toContain('Bea Fictional (Researcher)')
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce())
    await waitFor(() => expect(reload).toHaveBeenCalledOnce())
  })

  it('asks before signing out on all devices', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, hash: '#/settings', reload })
    const revokeMySessions = vi.fn(async () => ({ ok: true }))
    render(<App runtime={googleRuntime('researcher', undefined, { revokeMySessions })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out on all devices' }))
    expect(revokeMySessions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(revokeMySessions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out on all devices' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }))
    await waitFor(() => expect(revokeMySessions).toHaveBeenCalledOnce())
    await waitFor(() => expect(reload).toHaveBeenCalledOnce())
  })

  it('shows researchers no Users section and no pairing text', async () => {
    openSettings(googleRuntime('researcher'))
    await screen.findByTestId('account-name')
    expect(screen.queryByRole('heading', { name: 'Users' })).toBeNull()
    expect(screen.queryByText(/pair/i)).toBeNull()
  })
})

describe('Users administration', () => {
  async function owner(api = directory()) {
    openSettings(googleRuntime('owner', api))
    await screen.findByRole('heading', { name: 'Users' })
    await screen.findByTestId('user-u-bea')
    return api
  }
  const row = (id: string) => within(screen.getByTestId(id))
  const dialog = () => within(screen.getByRole('alertdialog'))

  it('lists people with email, role, status and last sign-in', async () => {
    await owner()
    expect(row('user-u-alex').getByText('alex@example.test')).toBeTruthy()
    expect(row('user-u-alex').getByText('Owner')).toBeTruthy()
    expect(row('user-u-bea').getByText('Never')).toBeTruthy()
    expect(row('user-u-dana').getByText('dana@example.test')).toBeTruthy()
    expect(row('user-u-dana').getByText('Waiting for sign-in')).toBeTruthy()
  })

  it('approves a request as a new user with the name prefilled', async () => {
    const api = await owner()
    const card = within(await screen.findByTestId('request-r-cara'))
    expect(card.getByText('Google-managed address')).toBeTruthy()
    fireEvent.click(card.getByRole('button', { name: /Approve cara@example.test as new user/ }))
    expect((dialog().getByLabelText('Name') as HTMLInputElement).value).toBe('Cara Fictional')
    fireEvent.click(dialog().getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api.approveSignInRequest).toHaveBeenCalledWith('r-cara', { displayName: 'Cara Fictional', role: 'researcher' }))
    expect(await screen.findByText(/Cara Fictional can now sign in as researcher/)).toBeTruthy()
    expect(api.listUsers.mock.calls.length).toBeGreaterThan(1)
  })

  it('warns when the address is not Google-managed', async () => {
    await owner(directory([alex, bea], [request('r-x', { emailAuthoritative: false })]))
    expect(await screen.findByText(/Google did not confirm this address belongs to a Google-managed domain — confirm with the person before approving/)).toBeTruthy()
    expect(screen.queryByText('Google-managed address')).toBeNull()
  })

  it('links a request to an existing person without an identity, with their version', async () => {
    const api = await owner()
    fireEvent.click(within(await screen.findByTestId('request-r-cara')).getByRole('button', { name: /Link cara@example.test/ }))
    expect(dialog().getAllByRole('option').map((o) => o.textContent)).toEqual(['Dana Fictional (Researcher)'])
    fireEvent.click(dialog().getByRole('button', { name: 'Link' }))
    await waitFor(() => expect(api.approveSignInRequest).toHaveBeenCalledWith('r-cara', { userId: 'u-dana' }, 2))
  })

  it('dismisses a request', async () => {
    const api = await owner()
    fireEvent.click(within(await screen.findByTestId('request-r-cara')).getByRole('button', { name: /Dismiss cara@example.test/ }))
    await waitFor(() => expect(api.dismissSignInRequest).toHaveBeenCalledWith('r-cara'))
  })

  it('adds a pending person and explains how they become active', async () => {
    const api = await owner()
    expect(screen.getByText(/become active once you link their sign-in request/)).toBeTruthy()
    const add = screen.getByRole('button', { name: 'Add person' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Eli Fictional' } })
    fireEvent.change(screen.getByLabelText('Contact email (optional)'), { target: { value: 'Eli@Example.test' } })
    fireEvent.click(add)
    await waitFor(() => expect(api.createUser).toHaveBeenCalledWith({ displayName: 'Eli Fictional', role: 'researcher', contactEmail: 'eli@example.test' }))
  })

  it('confirms a role change and passes the listed version', async () => {
    const api = await owner()
    fireEvent.click(row('user-u-bea').getByRole('button', { name: 'Make Bea Fictional an owner' }))
    expect(api.setUserRole).not.toHaveBeenCalled()
    fireEvent.click(dialog().getByRole('button', { name: 'Make owner' }))
    await waitFor(() => expect(api.setUserRole).toHaveBeenCalledWith('u-bea', 'owner', 3))
  })

  it('confirms before turning someone off, and revoking sessions', async () => {
    const api = await owner()
    fireEvent.click(row('user-u-bea').getByRole('button', { name: 'Turn off Bea Fictional' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }))
    expect(api.setUserStatus).not.toHaveBeenCalled()
    fireEvent.click(row('user-u-bea').getByRole('button', { name: 'Turn off Bea Fictional' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(api.setUserStatus).toHaveBeenCalledWith('u-bea', 'disabled', 3))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    fireEvent.click(row('user-u-bea').getByRole('button', { name: 'Sign out Bea Fictional everywhere' }))
    expect(api.revokeUserSessions).not.toHaveBeenCalled()
    fireEvent.click(dialog().getByRole('button', { name: 'Sign out everywhere' }))
    await waitFor(() => expect(api.revokeUserSessions).toHaveBeenCalledWith('u-bea'))
  })

  it('turns a disabled person back on', async () => {
    const api = await owner(directory([alex, { ...bea, status: 'disabled' }]))
    fireEvent.click(row('user-u-bea').getByRole('button', { name: 'Turn Bea Fictional back on' }))
    await waitFor(() => expect(api.setUserStatus).toHaveBeenCalledWith('u-bea', 'active', 3))
  })

  it('explains the last-owner refusal', async () => {
    const api = await owner()
    api.setUserRole.mockResolvedValueOnce({ ok: false, reason: 'last-owner' } as never)
    fireEvent.click(row('user-u-alex').getByRole('button', { name: 'Make Alex Fictional a researcher' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Make researcher' }))
    expect(await screen.findByText('You can’t remove the last active owner. Make someone else an owner first.')).toBeTruthy()
  })

  it('reloads the list and says so when a change is stale', async () => {
    const api = await owner()
    api.setUserStatus.mockResolvedValueOnce({ ok: false, reason: 'stale' } as never)
    const before = api.listUsers.mock.calls.length
    fireEvent.click(row('user-u-bea').getByRole('button', { name: 'Turn off Bea Fictional' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Turn off' }))
    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy()
    await waitFor(() => expect(api.listUsers.mock.calls.length).toBeGreaterThan(before))
  })

  it.each([
    ['identity-in-use', /already used by another person/],
    ['already-bound', /already has a Google account linked/],
    ['full', /directory is full/],
    ['not-found', /no longer exists/]
  ] as const)('explains %s', async (reason, message) => {
    const api = await owner()
    api.approveSignInRequest.mockResolvedValueOnce({ ok: false, reason } as never)
    fireEvent.click(within(await screen.findByTestId('request-r-cara')).getByRole('button', { name: /Approve cara@example.test/ }))
    fireEvent.click(dialog().getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText(message)).toBeTruthy()
  })
})

describe('where the Users section appears', () => {
  const host = (extra: Partial<Extract<AppRuntime, { mode: 'live' }>> = {}): AppRuntime => {
    const fake = createFakeApi()
    return {
      mode: 'live',
      data: fake.api,
      backup: fake.api,
      backupStatus: null,
      cases: { getStudioSummary: async () => emptySummary() } as never,
      switcher,
      users: directory() as unknown as UserAdminApi,
      ...extra
    }
  }

  it('is on the host session but never on a paired device', async () => {
    openSettings(host())
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeTruthy()
    cleanup()
    openSettings(host({ backup: null, remote: true, signOut: vi.fn(async () => undefined) }))
    await screen.findByText('Backups are managed on the researcher’s computer.')
    expect(screen.queryByRole('heading', { name: 'Users' })).toBeNull()
  })

  it('the host hides it while the HTTPS listener is off', async () => {
    const lan = { getLanStatus: vi.fn(async () => ({ enabled: false, origin: null })), listDevices: vi.fn(async () => []) }
    openSettings(host({ lan: lan as never }))
    await screen.findByTestId('app-version')
    await waitFor(() => expect(lan.getLanStatus).toHaveBeenCalled())
    expect(screen.queryByRole('heading', { name: 'Users' })).toBeNull()
  })

  it('demo renders no auth UI and no link into Live auth', async () => {
    const fake = createFakeApi()
    const { container } = openSettings({ mode: 'demo', data: fake.api, backup: null, cases: null, switcher })
    await screen.findByTestId('app-version')
    expect(screen.queryByRole('button', { name: /Sign in with Google/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /Sign in with Google/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /Users|Your account/ })).toBeNull()
    expect(container.innerHTML).not.toMatch(/auth\/google/)
  })
})
