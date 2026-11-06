import { expect } from 'vitest'
import type { AppData } from '../../../src/main/database/app-data'
import type { ClientInput } from '../../../src/shared/client-model'
import type { AppUser, UserRole } from '../../../src/shared/users'

// Shared fictional inputs and small builders for the ownership tests (#209).

export const clientInput = (displayName: string): ClientInput => ({
  displayName,
  source: 'direct',
  sourceDetail: null,
  fiverrUsername: null,
  email: null,
  otherContact: null,
  preferredContactChannel: 'unspecified'
})

export const caseInput = (title: string) => ({ title, goal: null, orderReference: null, dueDate: null })

export const UNOWNED = { kind: 'unowned' } as const

/** An approved, active user (bound to a fictional identity), created the way the owner approves a sign-in request. */
export function activeUser(data: AppData, subject: string, displayName: string, role: UserRole = 'researcher'): AppUser {
  const request = data.users.recordSignInRequest({
    provider: 'google',
    subject,
    email: `${subject}@example.test`,
    emailVerified: true,
    emailAuthoritative: false,
    name: displayName
  })
  if (!request.ok) throw new Error(`sign-in request refused: ${request.reason}`)
  const approved = data.users.approveSignInRequest(request.request.id, { displayName, role }, 'host')
  if (!approved.ok) throw new Error(`approval refused: ${approved.reason}`)
  return approved.user
}

export function disabledUser(data: AppData, subject: string, displayName: string): AppUser {
  const user = activeUser(data, subject, displayName)
  const result = data.users.setStatus(user.id, 'disabled', 'host', user.version)
  if (!result.ok) throw new Error(`disable refused: ${result.reason}`)
  return result.user
}

export function pendingUser(data: AppData, displayName: string): AppUser {
  const result = data.users.create({ displayName, role: 'researcher' }, 'host')
  if (!result.ok) throw new Error(`create refused: ${result.reason}`)
  return result.user
}

export function newClient(data: AppData, displayName: string, ownerId: string | null): string {
  const result = data.clients.create(
    clientInput(displayName),
    ownerId === null ? UNOWNED : { kind: 'user', userId: ownerId, actor: ownerId }
  )
  expect(result.ok, displayName).toBe(true)
  if (!result.ok) throw new Error('client not created')
  return result.client.id
}

export function newCase(data: AppData, clientId: string, title: string): string {
  const result = data.cases.create(clientId, caseInput(title))
  expect(result.ok, title).toBe(true)
  if (!result.ok) throw new Error('case not created')
  return result.case.id
}
