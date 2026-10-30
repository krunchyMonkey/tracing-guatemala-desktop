import type { AppData } from './database/app-data'
import type { BriefService, CaseService, JournalService, ClientService, NoteService } from './ipc'

/**
 * Client, note, case and brief services over the live AppData, shared by the Electron main
 * process and the local web host (#110). They look up the repositories on
 * every call, because a restore replaces the connection and repositories.
 */
export function createDataServices(current: () => AppData): { clients: ClientService; notes: NoteService; cases: CaseService; briefs: BriefService; journal: JournalService } {
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
    },
    cases: {
      list: (query) => current().cases.list(query),
      get: (id) => current().cases.get(id),
      listEvents: (caseId) => current().cases.listEvents(caseId),
      create: (clientId, input) => current().cases.create(clientId, input),
      update: (id, input) => current().cases.update(id, input),
      setState: (id, to) => current().cases.setState(id, to),
      archive: (id) => current().cases.archive(id),
      unarchive: (id) => current().cases.unarchive(id)
    },
    briefs: {
      get: (caseId) => current().briefs.get(caseId),
      save: (caseId, input) => current().briefs.save(caseId, input)
    },
    journal: {
      list: (caseId) => current().journal.list(caseId),
      create: (caseId, input) => current().journal.create(caseId, input),
      update: (caseId, entryId, input) => current().journal.update(caseId, entryId, input)
    }
  }
}
