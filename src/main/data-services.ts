import type { AppData } from './database/app-data'
import type { ClientService, NoteService } from './ipc'

/**
 * Client and note services over the live AppData, shared by the Electron main
 * process and the local web host (#110). They look up the repositories on
 * every call, because a restore replaces the connection and repositories.
 */
export function createDataServices(current: () => AppData): { clients: ClientService; notes: NoteService } {
  return {
    clients: {
      list: (query) => current().clients.list(query),
      get: (id) => current().clients.get(id),
      create: (input) => current().clients.create(input),
      update: (id, input) => current().clients.update(id, input),
      archive: (id) => current().clients.archive(id),
      restore: (id) => current().clients.restore(id),
      findDuplicates: (input, excludeId) => current().clients.findDuplicates(input, excludeId)
    },
    notes: {
      list: (clientId) => current().notes.list(clientId),
      create: (clientId, input) => current().notes.create(clientId, input),
      update: (clientId, noteId, input) => current().notes.update(clientId, noteId, input)
    }
  }
}
