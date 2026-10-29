# Client storage readiness (#5) — preparation notes

**Status:** Planning only. **#5 must not start** until the researcher explicitly approves the [client data model](../client-data-model.md) (#2). This note records what is still blocking, how the model fits the existing architecture, and the proposed order of work.

## 1. Remaining decisions that block the schema

From the [#2 approval checklist](../client-data-model.md#researcher-approval-checklist), these answers change tables or columns. The others only change UI and can be settled during #6–#8.

| Checklist item | Why it affects the schema |
| --- | --- |
| Q1 required fields | `NOT NULL` constraints on `display_name` and `source`. |
| Q3 contact details | Which contact columns exist (for example a `phone` column vs. the free-text `other_contact`). |
| Q4 prospect / inactive status | Whether `status` has two values or more (`CHECK` constraint plus migration). |
| Q8 orders in notes | Whether Phase 1 needs any engagement table, or notes are enough. |
| Q9 permanent deletion | Whether `ON DELETE RESTRICT` everywhere still holds, or an erasure path is needed. |

Engineering decisions to make inside #5 (not the researcher's):

- SQLite driver (§3).
- Database file location: proposed `app.getPath('userData')/data/tracing-guatemala.sqlite`, never the project or install directory.
- Migration runner: proposed forward-only, numbered SQL files run inside a transaction, tracked with `PRAGMA user_version`, plus a copy of the database file taken before the first pending migration.

## 2. Fit with the secure IPC architecture

The model needs no change to the security model. All database access stays in the main process. The renderer keeps calling named functions on `window.tracingGuatemala`.

Proposed channels, each with a zod contract in `src/main/ipc.ts` and wrapped by `createValidatedHandler`:

| Channel | Args | Result |
| --- | --- | --- |
| `clients:list` | `{ status, sources, query, sort }` | `ClientSummary[]` |
| `clients:get` | `id` (UUID) | `Client` with recent notes, or not-found |
| `clients:create` | `ClientInput` | `Client`, or field errors, or duplicate candidates |
| `clients:update` | `id`, `ClientInput` | same as create |
| `clients:archive` / `clients:restore` | `id` | `Client` |
| `clients:find-duplicates` | `ClientInput` | `DuplicateCandidate[]` |

Points to settle when implementing:

- **Expected failures as results, not exceptions.** `createValidatedHandler` throws `IpcRejectedError` for untrusted senders and malformed arguments. That should stay as is. Field validation failures and duplicate pauses are normal outcomes the UI must show inline, so they should come back as a typed result (`{ ok: false, errors: [{ field, code }] }`) that never echoes values.
- **System fields stay server-side.** The renderer never sends `id`, `status` or timestamps on create or update. The main process generates UUIDs with `crypto.randomUUID()`.
- **Shared types, no shared runtime.** `Client`, `ClientInput` and the result types go in `src/shared/` as types only, which keeps the preload bundle free of dependencies. Zod schemas stay in the main process.
- **Lint boundary.** The existing ESLint rule already forbids `*sqlite*` imports from the renderer.
- **Tests.** Extend `tests/unit/ipc.test.ts` for each contract and the API-surface assertion in the e2e smoke test.

## 3. Packaging concerns for a native SQLite dependency

| Concern | Detail |
| --- | --- |
| Native rebuild | `better-sqlite3` is a native addon. It must be rebuilt against Electron's ABI (`@electron/rebuild` or electron-builder's `npmRebuild: true`; today `electron-builder.yml` has `npmRebuild: false`). |
| asar and fuses | `.node` binaries cannot load from inside an asar archive and must go in `asarUnpack`. Check that the app still launches with `OnlyLoadAppFromAsar` on, and note that `EnableEmbeddedAsarIntegrityValidation` does **not** cover unpacked files. |
| Per-OS builds | Native binaries are built per OS and architecture. A macOS installer cannot be produced from Windows. The researcher's pilot OS (open) decides which CI runners are needed. |
| Alternative | Node's built-in `node:sqlite` would avoid a native addon. Whether Electron 45 exposes it, and how stable it is, must be verified in a spike before choosing. |
| Test runner | Vitest runs under plain Node, not Electron. Integration tests either use a Node-ABI build of the driver or run through Playwright `_electron`. Pick one in the spike. |

## 4. Recommended sequence

1. **Researcher answers the #2 checklist** on issue #2. Update `client-data-model.md` from `v1-draft` to `v1`, and record her approval in the issue.
2. **Researcher reviews the #3 prototype** and approves or requests changes. This gates #6–#8, not #5.
3. **Driver spike (part of #5):** add the driver and package it with `npm run package:dir`. Confirm that the packaged app opens a database with all fuses still flipped. Choose the test strategy.
4. **#5 storage:** migration `001_clients` (plus `client_notes` if #9 is next), repository layer in the main process, IPC channels above, integration tests for CRUD, invalid input, migration and restart.
5. **#6 / #7 / #8:** replace the prototype's in-memory store with the IPC calls, keeping the approved screens.
6. **#9 notes, #10 duplicate advisory, #11 backup/restore,** then **#12** packaged pilot.
