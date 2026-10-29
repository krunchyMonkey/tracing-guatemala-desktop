# Client storage readiness (#5) — preparation notes

**Status:** **Implemented in #5. See [Client storage](./client-storage.md) for the result, driver spike and decisions.** Kept as the pre-implementation record. The project owner authorized the v1 client model as working defaults; researcher feedback will be collected at the integrated Phase 1 pilot (#12). This note captures schema assumptions, existing Electron constraints, and implementation order. Do not claim researcher signoff.

## 1. Schema defaults and later-feedback risks (not blockers)

Use the current [v1 model defaults](../client-data-model.md#researcher-approval-checklist) for the first migration. The questions below might lead to later schema migrations after researcher feedback, but they **do not block #5**.

| Pilot feedback question | Potential schema change if the researcher requests it |
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

## 4. Recommended implementation sequence

1. **#5 is unblocked:** use `client-model/v1` and the existing React prototype. Do a short driver/packaging spike first; preserve strict Electron sandbox and fuses.
2. Implement `001_clients` and a versioned migration strategy, a main-process repository with validated IPC, UUIDs, and tests for migration, error recovery and persistence. Keep the model evolvable rather than hardcoding speculative future fields.
3. **#6 / #7 / #8:** replace the in-memory prototype store with IPC operations while keeping existing user flows; refine obvious UX issues under engineering review.
4. **#9 / #10 / #11:** persistent notes, duplicate advisory and safe backup/restore. Test before any pilot with real client data.
5. **#12 integrated MVP review:** let the researcher use the app, gather her answers to the data-model questions and UI review guide, file actionable follow-ups, and obtain her actual approval before closing the phase.

No separate researcher signoff is needed between implementation tickets. Keep privacy/security review and technical PR checks intact.
