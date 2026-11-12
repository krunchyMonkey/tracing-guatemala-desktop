import type { AppData } from './database/app-data'
import { ClientOwnershipError } from './database/client-repository'
import {
  canReadCase,
  canReadClient,
  canWriteCase,
  canWriteClient,
  localScope,
  MISSING_ID,
  profileHasUsers,
  type ResearchScope
} from './database/research-access'
import type { TimerResult } from '../shared/case-time'
import type { BriefService, CaseService, JournalService, NotebookService, TaskService, TimeService, StudioService, ClientService, NoteService } from './ipc'

/**
 * Client, note, case and brief services over the live AppData, shared by the Electron main
 * process and the local web host (#110). They look up the repositories on
 * every call, because a restore replaces the connection and repositories.
 *
 * Every service is bound to a ResearchScope (#210) and is the research authorization boundary:
 *  - lists and aggregates are filtered in SQL by the scope;
 *  - an id-based call is checked synchronously immediately before the repository call. When the scope
 *    may not use the id, the repository is called with MISSING_ID instead, so the result is exactly what a
 *    missing record produces, for valid and invalid input alike, and never echoes the requested id;
 *  - writes need owner or editor access, reads need any access.
 * The check and the repository call run in one synchronous JavaScript turn on one node:sqlite connection,
 * so nothing in this process can change ownership, grants or user status between them.
 */
export interface DataServices {
  clients: ClientService
  notes: NoteService
  cases: CaseService
  briefs: BriefService
  journal: JournalService
  tasks: TaskService
  time: TimeService
  notebook: NotebookService
  studio: StudioService
}

export interface ScopedDataServices {
  /** Services for a scope the caller already resolved (a signed-in user, or none for calls without research content). */
  forScope(scope: ResearchScope): DataServices
  /** Services whose scope is resolved on every call from the profile: everything without users, nothing with users. */
  forLocalOperator(): DataServices
}

export function createDataServices(current: () => AppData): ScopedDataServices {
  return {
    forScope: (scope) => bindServices(current, () => scope),
    forLocalOperator: () => bindServices(current, () => localScope(current().db))
  }
}

/** What the timer returns when there is no timer for the caller. Identical to the repository's own answer. */
const NO_TIMER: TimerResult = { ok: false, reason: 'not-found' }

function bindServices(current: () => AppData, scopeOf: () => ResearchScope): DataServices {
  const readClient = (id: string): string => (canReadClient(current().db, scopeOf(), id) ? id : MISSING_ID)
  const writeClient = (id: string): string => (canWriteClient(current().db, scopeOf(), id) ? id : MISSING_ID)
  const readCase = (id: string): string => (canReadCase(current().db, scopeOf(), id) ? id : MISSING_ID)
  const writeCase = (id: string): string => (canWriteCase(current().db, scopeOf(), id) ? id : MISSING_ID)

  /**
   * The one pending timer is global (case_active_timer.id = 1). Pause, resume, heartbeat, stop and
   * discard act only when the caller may write the timer's case; otherwise they behave exactly like
   * "no active timer". Known limitation: a start while someone else's timer runs reveals one bit
   * ("busy") across accounts, and never the other timer's case, client or time. Per-user timers are a follow-up.
   */
  const timerWritable = (): boolean => {
    const timer = current().time.getActiveTimer()
    return timer !== null && canWriteCase(current().db, scopeOf(), timer.caseId)
  }

  return {
    clients: {
      list: (query) => current().clients.list(query, scopeOf()),
      get: (id) => current().clients.get(readClient(id)),
      create: (input, ownership) => {
        const scope = scopeOf()
        if (scope.kind === 'none') {
          // A profile with users has no implicit owner: the host or an app owner is never assigned silently.
          // Run the repository's own checks (invalid input is reported as before) with no owner, which it refuses.
          if (!profileHasUsers(current().db)) throw new ClientOwnershipError('owner-required')
          return current().clients.create(input, { kind: 'unowned' })
        }
        // A signed-in user creates only for itself, whatever the caller passed.
        if (scope.kind === 'user' && !(ownership.kind === 'user' && ownership.userId === scope.userId)) {
          throw new ClientOwnershipError('owner-required')
        }
        return current().clients.create(input, ownership)
      },
      update: (id, input) => current().clients.update(writeClient(id), input),
      archive: (id) => current().clients.archive(writeClient(id)),
      restore: (id) => current().clients.restore(writeClient(id)),
      findDuplicates: (input, excludeId) => current().clients.findDuplicates(input, excludeId, scopeOf())
    },
    notes: {
      list: (clientId) => current().notes.list(readClient(clientId)),
      create: (clientId, input) => current().notes.create(writeClient(clientId), input),
      update: (clientId, noteId, input) => current().notes.update(writeClient(clientId), noteId, input)
    },
    cases: {
      list: (query) => current().cases.list(query, scopeOf()),
      get: (id) => current().cases.get(readCase(id)),
      listEvents: (caseId) => current().cases.listEvents(readCase(caseId)),
      // Creating a case needs write access to the client (a case-only grantee has no client-level access).
      create: (clientId, input) => current().cases.create(writeClient(clientId), input),
      update: (id, input) => current().cases.update(writeCase(id), input),
      setState: (id, to) => current().cases.setState(writeCase(id), to),
      archive: (id) => current().cases.archive(writeCase(id)),
      unarchive: (id) => current().cases.unarchive(writeCase(id))
    },
    briefs: {
      get: (caseId) => current().briefs.get(readCase(caseId)),
      save: (caseId, input) => current().briefs.save(writeCase(caseId), input)
    },
    journal: {
      list: (caseId) => current().journal.list(readCase(caseId)),
      create: (caseId, input) => current().journal.create(writeCase(caseId), input),
      update: (caseId, entryId, input) => current().journal.update(writeCase(caseId), entryId, input)
    },
    tasks: {
      list: (caseId) => current().tasks.list(readCase(caseId)),
      create: (caseId, input) => current().tasks.create(writeCase(caseId), input),
      update: (caseId, taskId, input) => current().tasks.update(writeCase(caseId), taskId, input),
      complete: (caseId, taskId) => current().tasks.complete(writeCase(caseId), taskId),
      reopen: (caseId, taskId) => current().tasks.reopen(writeCase(caseId), taskId)
    },
    time: {
      list: (caseId) => current().time.list(readCase(caseId)),
      create: (caseId, input) => current().time.create(writeCase(caseId), input),
      update: (caseId, entryId, input) => current().time.update(writeCase(caseId), entryId, input),
      delete: (caseId, entryId) => current().time.delete(writeCase(caseId), entryId),
      getActiveTimer: () => {
        const timer = current().time.getActiveTimer()
        return timer !== null && canReadCase(current().db, scopeOf(), timer.caseId) ? timer : null
      },
      start: (caseId) => {
        const target = writeCase(caseId)
        if (target !== MISSING_ID) {
          const existing = current().time.getActiveTimer()
          if (existing !== null && existing.caseId !== target && !canReadCase(current().db, scopeOf(), existing.caseId)) {
            // Someone else's timer is running: say only that the timer is busy, with no snapshot of it.
            return { ok: false, reason: 'conflict', timer: null }
          }
        }
        return current().time.start(target)
      },
      pause: (version) => (timerWritable() ? current().time.pause(version) : NO_TIMER),
      resume: (version) => (timerWritable() ? current().time.resume(version) : NO_TIMER),
      heartbeat: (version) => (timerWritable() ? current().time.heartbeat(version) : NO_TIMER),
      stopAndSave: (version, options) => (timerWritable() ? current().time.stopAndSave(version, options) : NO_TIMER),
      discard: (version) => (timerWritable() ? current().time.discard(version) : NO_TIMER)
    },
    notebook: {
      getOutline: (caseId) => current().notebook.getOutline(readCase(caseId)),
      getPage: (caseId, pageId) => current().notebook.getPage(readCase(caseId), pageId),
      listRevisions: (caseId, pageId) => current().notebook.listRevisions(readCase(caseId), pageId),
      getRevision: (caseId, pageId, revisionId) => current().notebook.getRevision(readCase(caseId), pageId, revisionId),
      createSection: (caseId, input) => current().notebook.createSection(writeCase(caseId), input),
      renameSection: (caseId, sectionId, input) => current().notebook.renameSection(writeCase(caseId), sectionId, input),
      moveSection: (caseId, sectionId, toIndex) => current().notebook.moveSection(writeCase(caseId), sectionId, toIndex),
      archiveSection: (caseId, sectionId) => current().notebook.archiveSection(writeCase(caseId), sectionId),
      unarchiveSection: (caseId, sectionId) => current().notebook.unarchiveSection(writeCase(caseId), sectionId),
      createPage: (caseId, sectionId, input) => current().notebook.createPage(writeCase(caseId), sectionId, input),
      renamePage: (caseId, pageId, input) => current().notebook.renamePage(writeCase(caseId), pageId, input),
      movePage: (caseId, pageId, move) => current().notebook.movePage(writeCase(caseId), pageId, move),
      archivePage: (caseId, pageId) => current().notebook.archivePage(writeCase(caseId), pageId),
      unarchivePage: (caseId, pageId) => current().notebook.unarchivePage(writeCase(caseId), pageId),
      savePage: (caseId, pageId, save) => current().notebook.savePage(writeCase(caseId), pageId, save),
      restoreRevision: (caseId, pageId, revisionId, baseVersion) =>
        current().notebook.restoreRevision(writeCase(caseId), pageId, revisionId, baseVersion)
    },
    studio: {
      summary: () => current().studio.summary(scopeOf())
    }
  }
}
