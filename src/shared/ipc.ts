// Contract shared by main, preload, and renderer. Keep this file free of runtime
// dependencies: the sandboxed preload bundles everything it imports.

import type { Client, ClientInput, ClientIssue, DirectoryQuery } from './client-model'

export const IpcChannel = {
  getAppInfo: 'app:get-info',
  listClients: 'clients:list',
  getClient: 'clients:get',
  createClient: 'clients:create',
  updateClient: 'clients:update',
  archiveClient: 'clients:archive',
  restoreClient: 'clients:restore'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface AppInfo {
  name: string
  version: string
  platform: string
}

/**
 * Expected outcomes of a client change. Validation failures carry only field
 * names and rule codes, never the submitted values.
 */
export type ClientMutationResult =
  | { ok: true; client: Client }
  | { ok: false; reason: 'invalid'; issues: ClientIssue[] }
  | { ok: false; reason: 'not-found' }
  /** Edit or archive of an archived client, or restore of an active one. */
  | { ok: false; reason: 'wrong-status' }

/** The only surface the renderer has into the main process (window.tracingGuatemala). */
export interface TracingGuatemalaApi {
  getAppInfo(): Promise<AppInfo>
  listClients(query: DirectoryQuery): Promise<Client[]>
  getClient(id: string): Promise<Client | null>
  createClient(input: ClientInput): Promise<ClientMutationResult>
  updateClient(id: string, input: ClientInput): Promise<ClientMutationResult>
  archiveClient(id: string): Promise<ClientMutationResult>
  restoreClient(id: string): Promise<ClientMutationResult>
}
