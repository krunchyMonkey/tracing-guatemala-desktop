# Client storage (#5)

**Status:** Implemented for Phase 1 using the owner-authorized `client-model/v1` baseline. The researcher has not reviewed the model yet; schema changes that come out of the #12 pilot ship as new migrations.

## Driver spike (2026-10-29)

Both candidates were loaded inside Electron 45.1.0 (Node 24.22.1, `NODE_MODULE_VERSION` 150) on Windows 11, then the chosen driver was checked in the packaged app.

| Check | `node:sqlite` (built in) | `better-sqlite3` (native addon) |
| --- | --- | --- |
| Loads in Electron 45 main process | Yes. SQLite 3.53.4, FTS5 available | Yes in development (prebuilt binary) |
| Native rebuild per Electron/OS/arch | Not needed | Needed (`@electron/rebuild` or `npmRebuild: true`), per-OS CI runners |
| asar | Nothing to unpack. All app code stays in the integrity-checked `app.asar` | `.node` file must go in `asarUnpack`, **outside** `EnableEmbeddedAsarIntegrityValidation` |
| Existing fuses (`RunAsNode` off, `OnlyLoadAppFromAsar` on, …) | Unchanged, verified in packaged build | Would need the unpacked exception |
| Vitest under plain Node | Same API (Node 25 ships SQLite 3.50.4) | Needs a second, Node-ABI build of the addon |
| API stability | Experimental in Node 24 (prints an `ExperimentalWarning`, API may change) | Mature, widely used |

**Decision:** `node:sqlite`. It keeps the packaged app free of native code, so the asar integrity fuse still covers everything that runs, and the same driver runs in unit tests. The risk is the experimental API. Only `src/main/database/` imports it, and it uses a small surface (`DatabaseSync`, `prepare`, `run`/`get`/`all`, `exec`), so moving to better-sqlite3 would mean rewriting two files plus a packaging change.

**Packaged verification** (`npm run package:dir` then `npm run smoke:packaged`): the fuses read back unchanged, `release/win-unpacked/resources` has only `app.asar` (no `app.asar.unpacked`), the packaged app creates and migrates `<userData>/data/tracing-guatemala.sqlite` to version 2 in WAL mode, and a relaunch reopens the existing file and keeps its rows. Only Windows was exercised. macOS and Linux need the same check when a pilot OS is chosen (#12).

## Layout

| Path | Role |
| --- | --- |
| `src/shared/client-model.ts` | `client-model/v1` types and pure rules: normalization, validation (field and rule codes only), duplicate keys, directory query. Used by both the main process and the renderer. |
| `src/main/database/migrations.ts` | Forward-only numbered migrations and the runner. |
| `src/main/database/connection.ts` | Opens the database file, sets pragmas, runs migrations, takes the pre-migration copy. The only place the driver is configured. |
| `src/main/database/client-repository.ts` | Client reads and writes. Re-runs `checkClient` on every write; renderer checks are never trusted. |
| `src/main/database/note-repository.ts` | Notes and contact log (#9). Every query is scoped by client id. Re-runs `checkNote`. |
| `src/main/ipc.ts` | zod contracts for the `clients:*` channels. |
| `scripts/packaged-smoke.mjs` | Packaged-app database smoke test. |

## Database file

- `app.getPath('userData')/data/tracing-guatemala.sqlite`. On Windows that is `%APPDATA%\Tracing Guatemala\data\`. It is never in the install directory or the repository.
- Pragmas: `journal_mode=WAL`, `synchronous=FULL` (durability over speed for a single-user app), `foreign_keys=ON`, `busy_timeout=5000`, `trusted_schema=OFF`.
- Unpackaged builds honor `TRACING_GUATEMALA_TEST_USER_DATA` so e2e tests use a throwaway profile. Packaged builds ignore it. A packaged build can still be pointed elsewhere with Chromium's `--user-data-dir` switch, which the packaged smoke test uses.

## Migrations

- Tracked with `PRAGMA user_version`. Each migration runs in its own `BEGIN IMMEDIATE` transaction together with the version bump, so a failure rolls back to the previous version.
- Before upgrading an existing database, a consistent copy is written with `VACUUM INTO` to `data/pre-migration/tracing-guatemala.sqlite.v<from>.<timestamp>.sqlite`. A new empty database is not copied.
- A database with a higher version than the app knows (written by a newer build) is refused without changes, with an explanatory dialog.
- Any open or migration failure shows a generic dialog ("Nothing was changed or deleted") and exits. Only the error name is logged, never the message, because SQLite messages can quote stored values.

| Version | Content |
| --- | --- |
| 1 `clients` | `client-model/v1` §2.1 columns, `STRICT` table, `CHECK` constraints for enums, lengths and the `status`/`archived_at` invariant. Triggers forbid `DELETE` and changes to `id`. |
| 2 `client_notes` | §2.3 notes table, `ON DELETE RESTRICT` to `clients`. Archive and restore write `system` entries; notes and logged contacts come through the `notes:*` channels (#9). |

## IPC

| Channel | Args | Result |
| --- | --- | --- |
| `clients:list` | `DirectoryQuery` (`text`, `status`, `sources`, `sort`) | `Client[]` |
| `clients:get` | UUID | `Client \| null` |
| `clients:create` | `ClientInput` | `ClientMutationResult` |
| `clients:update` | UUID, `ClientInput` | `ClientMutationResult` |
| `clients:archive` / `clients:restore` | UUID | `ClientMutationResult` |
| `clients:find-duplicates` | `ClientInput`, UUID or `null` (the client being edited) | `DuplicateCandidate[]` (client and matching signals), archived included |
| `notes:list` | client UUID | `ClientNote[]`, newest first |
| `notes:create` | client UUID, `NoteInput` | `NoteMutationResult` |
| `notes:update` | client UUID, note UUID, `NoteInput` | `NoteMutationResult` |

- `ClientInput` is a strict object: an `id`, `status`, timestamp or any other extra key rejects the whole call (`invalid-arguments`) before it reaches storage. Raw strings are capped at 1,000 characters to stop oversized payloads. The real field limits are rule checks.
- `ClientMutationResult` is `{ ok: true, client }` or `{ ok: false, reason }` with `reason` one of `invalid` (plus `issues: { field, severity, code }[]`), `not-found`, `wrong-status`. Expected failures are results, not exceptions, and never contain submitted values.
- Unexpected failures (database errors, a result that breaks its contract) reach the renderer only as `IPC request rejected: internal-error`.

## Decisions and assumptions to revisit

| Decision | Why | Revisit when |
| --- | --- | --- |
| `clients:list` loads all rows and filters in JS with the shared `queryClients`. | Keeps accent-insensitive search and locale collation identical to the prototype. Phase 1 volumes are hundreds of clients. | Directory reaches thousands of clients: add a folded-name column or FTS5. |
| Notes are scoped by client id in every query. An update through the wrong client returns `not-found`. | No cross-client leakage, even with a valid note id. | Never. |
| Notes and contact entries can be edited, never deleted. Only the latest text is kept; the entry shows "Edited <date>". | Matches "no hard delete" and keeps Phase 1 simple. | #12 feedback (full revision history if wanted). |
| Entries can be back-dated; dates more than a day ahead are rejected. | Logging a message after the fact is common; a day of tolerance covers time zones. | #12 feedback. |
| System entries (archive/restore) cannot be edited. Archived clients' entries are read-only. | Model §5.2/§5.4. | #12 feedback (checklist Q5). |
| Duplicate advisory (#10) runs in the main process over every client, archived included. Only exact matches of folded name, email or handle count; no fuzzy matching. If the check fails, nothing is saved. | Predictable, few false positives; a failed check must not silently skip the warning. | #12 feedback (fuzzy names if real duplicates slip through). |
| Control characters are also rejected in `sourceDetail` and `otherContact`. | The model calls them single-line fields (§4.1). Previously only `displayName` was checked. | Pilot feedback. |
| `synchronous=FULL` | Safety over write speed. Writes are rare and small. | Never, unless profiling says otherwise. |
| Archived clients cannot be edited (`wrong-status`). | Model §5.2 default (checklist Q5). | #12 feedback. |
