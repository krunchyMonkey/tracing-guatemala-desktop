# Research authorization (#210)

**Status:** Source only. Every Live research call is now scoped to a person. Together with [#209 ownership](research-ownership.md) this is the enforcement half of the privacy epic (#208).

> **#209 + #210 together are still NOT a Live deployment.** #211 owns the cutover (freeze writes, verified snapshots, activate migration and guards together, reopen writes) and #212 owns the sharing UI and the owner acceptance of the privacy gate. Merging is not deploying. No real record is enabled by this change.

## Scope model

Every request that touches research content gets a **research scope**, resolved on the server for that request. Nothing the browser sends (an owner id, a role, a flag) can choose it.

```ts
type ResearchScope = { kind: 'all' } | { kind: 'user'; userId: string } | { kind: 'none' }
```

| Caller | Scope |
| --- | --- |
| Signed-in Google user (session re-read from SQLite on every request: active, same `auth_version`) | `user` with the session's internal `app_users.id` |
| Loopback host session, paired LAN/HTTPS device, Electron IPC, **profile has at least one `app_users` row** (pending, active or disabled) | `none`: no implicit admin or host read of research content |
| The same callers, **profile has no `app_users` row** (single-operator Electron, loopback, fictional pre-identity profiles, E2E) | `all`: behavior unchanged |
| Calls without research content (app info, backups, LAN/device admin, user admin, own account) | `none` is bound, so a research service reached by mistake returns nothing |

The scope of the host and devices is re-resolved on **every call**, so creating the first user takes effect on the next request.

The code: `src/main/database/research-access.ts` (scope, SQL fragments, access checks), `src/main/data-services.ts` (scope-bound services, the enforcement boundary), `src/server/auth/research-policy.ts` (the exhaustive call classification), `src/server/live-host.ts` (resolves the scope per request from `ctx.principal`). `authorizeCall` in `policy.ts` is unchanged: it still answers which role may use which call; this layer answers what the call may touch.

## Effective access rules

For a user `U` on client `C` and a case `K` of `C`:

- **Unclaimed** (`C` has no `client_ownership` row): no access for any user.
- **Client level:** `U` is the owner of `C`, or has a `client_grants` row for `C`. A person who only holds a `case_grants` row has **no client-level access**: `getClient`, `listNotes`, note writes, client updates/archive and `createCase` under the client are all denied.
- **Case level for `K`:** the owner of `C`, or a client grant on `C`, or a case grant on `K`. The highest permission among the sources wins.
- A grant is effective only while **both the grantee and the client owner are `active`** app users. A disabled owner voids every grant on their records and a disabled grantee loses theirs (their session also ends).
- **Read** = any access. **Write** (every mutation: create, update, archive/restore, state change, notes, brief, journal, tasks, time entries, notebook, timer) = owner or `editor`.
- The app-level `owner` role grants nothing here. Changing a role never creates or removes a grant. Only ownership rows and grants count.
- `all` is everything; `none` is nothing (lists are empty, ids behave as nonexistent, creates are refused).

One SQL definition serves both lists and id checks: `accessibleClientIds(userId, need)` and `accessibleCaseIds(userId, need)` are `SELECT` fragments. List queries filter with `id IN (<fragment>)`; an id check is `? IN (<fragment>)`. A unit test asserts that the fragments and the id checks agree for every kind of person.

## Where it is enforced

At the **shared data-services boundary**, not in the HTTP layer and not in the UI:

- **Lists and aggregates** are filtered in SQL with the scope: `ClientRepository.list` and `findDuplicates` (only readable clients can be reported as duplicates, so no cross-account existence leak), `CaseRepository.list` (including the `clientId` filter), `StudioSummaryRepository.summary` (every count, task, activity row and hour total). In the studio summary a case reached only through a case grant shows the label `Shared case` instead of the client's name, and does not count toward `activeClients`.
- **Id-based calls** check access synchronously immediately before the repository call. When the scope may not use the id, the repository is called with the reserved never-issued id `00000000-0000-0000-0000-000000000000` instead, so the answer is exactly what a missing record produces, for valid and invalid input alike, and never echoes the requested id. Viewers who try a write get the same "not found" answer.
- **Time of check, time of use.** `node:sqlite` is synchronous and the JavaScript turn does not yield between the check and the repository's own `BEGIN IMMEDIATE` transaction on the same connection, so nothing in the process can change ownership, grants or user status in between. A second process on the same database file could; the cutover (#211) therefore runs exactly one process per profile.
- **Nested records** were already scoped by their parent in every repository (note by client; journal entry, task, time entry, section, page, revision by case). A test addresses case K2's children through case K1 and a client's notes through another client; all are "not found" and nothing changes.
- **References between records** (a `reference` block in a notebook page holds a kind and an id) are never dereferenced by the server: the client resolves them from the per-case lists it is allowed to read. A reference to another person's record therefore reveals nothing and resolves to nothing.
- **Creating a client** is owned by the session's user only; a user can never create on behalf of someone else, and `none` refuses (host in a users profile: HTTP 409 `owner-required`, as in #209).

### The global timer (known limitation)

`case_active_timer` is one global row. Rules: `getActiveTimer` returns it only to a caller who can **read** its case. `pauseTimer`, `resumeTimer`, `heartbeatTimer`, `stopAndSaveTimer` and `discardTimer` act only for a caller who can **write** its case; otherwise they answer exactly like "no active timer". `startTimer(caseId)` needs write access to `caseId`; if a timer the caller cannot read already exists, the answer is `{ ok: false, reason: 'conflict', timer: null }` with no snapshot, case or client data. That is a one-bit "busy" signal across accounts. **One global timer remains a known limitation; per-user timers are a follow-up.**

## Fail closed

If the ownership tables are missing (schema older than 10, or an incomplete restore), `researchSchemaReady` is false and every research call is refused with HTTP **503** `research-unavailable` for users, the host and devices alike. There is no fallback to shared access. Calls without research content (`getAppInfo`, `getBackupStatus`, `getMyAccount`, backups) keep working. A test drops the ownership tables from a migrated profile and checks every research call.

The session's `research` field (`own`, `all` or `none`) is display only. Host and device sessions learn whether any app users exist (`all` vs `none`); this is acceptable because the host administers accounts and a device could infer it from the 409 `owner-required`. Google users always get `own` (or `none` if the schema is not ready); signed-out responses carry no field.

## The host and physical administration boundary

Be honest about what this does not protect:

- The person at the host computer can still make and restore **whole-database backups** (`createBackup`, `restoreBackup`) and can read the SQLite file and its backups directly on disk. Backup and restore are physically privileged, not research calls, and the app cannot hide a file from the person who owns the machine.
- A restore replaces **all** users and records and ends every session.
- The loopback host session, in a profile with users, can administer users and make backups but sees no research content through the API.
- The app-level `owner` role administers accounts; it does not read researchers' content and cannot download other people's data (backups remain host-only).

## Deny matrix

`RESEARCH_CLASS` in `src/server/auth/research-policy.ts` classifies **every** call name (`Record<CallName, ResearchClass>`, so an unclassified call is a compile error). `tests/unit/live-authorization.test.ts` has a matrix entry for every name in `CALL_NAMES` and fails if one is missing. For every research call, a caller who may not use record A's ids gets a response byte-identical (status and body) to the same call with fresh random ids, for valid and invalid input, and a manifest of every table is unchanged afterwards. This runs for another researcher, for an app-owner-role user, for the host (users profile) and for viewers' writes.

Classes: **list** = filtered in SQL; **client-read/write** and **case-read/write** need that level on the id; **timer-** classes follow the timer rules above. "Denied" means the answer of a missing record: lists are empty or `null`, mutations return `{ ok: false, reason: 'not-found' }`.

| Call | Class | Needs | Denied answer |
| --- | --- | --- | --- |
| `listClients` | scoped-list | rows the scope may read | fewer rows (empty) |
| `findDuplicateClients` | scoped-list | rows the scope may read | no candidates from other accounts |
| `listCases` (incl. `clientId` filter) | scoped-list | cases the scope may read | empty |
| `getStudioSummary` | scoped-list | cases/clients the scope may read | zero counts, empty lists |
| `createClient` | client-create | signed-in user (owner = self) | host/device in a users profile: 409 `owner-required` |
| `getClient`, `listNotes` | client-read | client read | `null`, `[]` |
| `updateClient`, `archiveClient`, `restoreClient`, `createNote`, `updateNote` | client-write | client write | `not-found` |
| `createCase` | client-write | write on the client | `not-found` |
| `getCase`, `listCaseEvents`, `getCaseBrief`, `listJournalEntries`, `getNotebook`, `getNotebookPage`, `listPageRevisions`, `getPageRevision`, `listCaseTasks`, `listTimeEntries` | case-read | case read | `null`, `[]` |
| `updateCase`, `setCaseState`, `archiveCase`, `unarchiveCase`, `saveCaseBrief`, `createJournalEntry`, `updateJournalEntry`, `createNotebookSection`, `renameNotebookSection`, `moveNotebookSection`, `archiveNotebookSection`, `unarchiveNotebookSection`, `createNotebookPage`, `renameNotebookPage`, `moveNotebookPage`, `archiveNotebookPage`, `unarchiveNotebookPage`, `saveNotebookPage`, `restorePageRevision`, `createCaseTask`, `updateCaseTask`, `completeCaseTask`, `reopenCaseTask`, `createTimeEntry`, `updateTimeEntry`, `deleteTimeEntry` | case-write | case write | `not-found` |
| `getActiveTimer` | timer-read | read of the timer's case | `null` |
| `startTimer` | timer-start | write on the case; a timer the caller cannot read answers `conflict` with `timer: null` | `not-found` / `conflict` (no snapshot) |
| `pauseTimer`, `resumeTimer`, `heartbeatTimer`, `stopAndSaveTimer`, `discardTimer` | timer-write | write on the timer's case | `not-found` (as "no active timer") |
| `getAppInfo`, `getMyAccount`, `revokeMySessions` | no-research | signed-in (own account only) | n/a |
| `createBackup`, `restoreBackup`, `getBackupStatus`, `getLanStatus`, `createPairingCode`, `listDevices`, `revokeDevice`, `revokeAllDevices`, `disableLan` | no-research | host session only (`host-only` for everyone else) | 403 `host-only` |
| `listUsers`, `listSignInRequests`, `createUser`, `approveSignInRequest`, `dismissSignInRequest`, `setUserRole`, `setUserStatus`, `revokeUserSessions` | no-research | host, or a remote app `owner` | 403 `forbidden` for a researcher |

## What changed for users

- Each person sees only the clients, cases and everything under them that they own or that were explicitly granted to them. The Phase 2.7 "shared workspace" is gone; see [the updated pilot record](../pilot/phase-2.7-identity-validation.md).
- A case-only grantee can open the shared case but has no access to its client record (the client screen shows nothing). Presenting such shared cases well is part of the sharing UI (#212).
- There is still **no way to grant access** from the app: grants exist only as trusted internal methods on `OwnershipRepository` (#209).

## Not covered here (follow-ups)

- #211: freeze writes, snapshots, the combined activation, rollback drill, single process per profile.
- #212: sharing UI, owner selection for host-created clients, claiming legacy data, researcher acceptance.
- Per-user timers (the global timer's "busy" bit).
- Last-write-wins on records without a version argument (accepted risk from #182) is unchanged.
