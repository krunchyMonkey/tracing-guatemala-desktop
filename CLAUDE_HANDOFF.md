# Claude handoff — Phase 1: build-first MVP (updated 2026-10-29)

**Repository:** `krunchyMonkey/tracing-guatemala-desktop` — https://github.com/krunchyMonkey/tracing-guatemala-desktop  
**Delivery direction:** The project owner has authorized the draft client model and prototype as **working implementation defaults**. Do not claim the researcher (his wife) reviewed or approved them. Capture her actual feedback and approval when she can use the integrated MVP at the Phase 1 pilot (#12). Researcher interviews/sign-off are **not implementation blockers** for #5–#11.

Read:
- [Client data model](./docs/client-data-model.md) — working `client-model/v1` defaults
- [Phase 1 client-management specification](./docs/phase-1-client-management-spec.md)
- [Prototype and walkthrough](./docs/prototypes/client-directory.md)
- [Storage architecture readiness](./docs/architecture/client-storage-readiness.md)
- [Electron foundation](./docs/architecture/electron-foundation.md)

## Current project status

- #4: complete, PR #95 merged — secure Electron foundation.
- #2: working data model documented, PR #96 merged. Authorized **for implementation**, not researcher-validated.
- #3: clickable UI prototype merged, PR #97. Authorized **as the UI baseline**, not researcher-validated.
- #5: SQLite persistence, migrations, typed `clients:*` IPC implemented on `feat/5-sqlite-client-storage` (driver `node:sqlite`; see [Client storage](./docs/architecture/client-storage.md)). The renderer still uses the in-memory prototype store until #6.
- #6: Clients screens save create/edit/archive/restore through IPC (`feat/6-persistent-client-crud`, stacked on #5). Notes stay session-only until #9.
- #7: directory queries run in the main process via `clients:list`; filters survive profile round trips (`feat/7-persistent-directory`, stacked on #6).
- #8: profile re-reads the saved client via `clients:get`, focus management after archive/restore, full/sparse/archived tests (`feat/8-persistent-client-profile`, stacked on #7).
- #9: notes and contact log persisted via `notes:*`, editable with an Edited marker, client-scoped (`feat/9-persistent-notes`, stacked on #8).
- #10: duplicate advisory via `clients:find-duplicates` in the main process, punctuation-insensitive name key (`feat/10-duplicate-advisory`, stacked on #9). Existing prototype may be adapted rather than rebuilt.
- Then #9 notes, #10 validation/duplicate advisory, #11 safe backup/restore.
- **#12 integrated MVP pilot:** present the actual app to the researcher, collect usability/field/flow feedback, implement required changes, and obtain actual signoff before declaring Phase 1 complete.

## Worktree and repository rules

1. Verify the repository URL and inspect local checkouts and `git worktree list --porcelain` before doing anything.
2. If an issue-specific worktree exists, reuse it. If only a checkout exists, create an issue worktree from its up-to-date `origin/main`.
3. Clone only when no usable local checkout/worktree exists.
4. Protect existing branches and uncommitted changes: never reset, clean, force-update or delete worktrees without explicit instruction.
5. One issue per branch and PR by default; inspect current repository state and existing code first.

## Engineering approach

- Treat proposed requirements as **revisable MVP defaults**. Make ordinary product choices and document them; do not stop implementation for missing researcher confirmation.
- Keep changes scoped and testable. Reference existing issues; no need to create new approval tickets or questionnaires for Phase 1.
- On #5, perform a short SQLite compatibility spike in the **packaged Electron app** (native module/fuses/asar concerns); decide the driver based on evidence. SQLite belongs in the main process, in the app's OS user-data directory, with migrations, secure validated IPC, and restart-persistence tests.
- On #6–#8, replace the in-memory store with persisted operations while preserving existing approved-for-implementation UX interactions. No separate researcher signoff gate.
- Add tests, report validation outcomes, and follow normal PR review. Merge criteria are engineering correctness and ticket acceptance, **not pre-implementation external user review**.

## Non-negotiable protections

- Repository is public: only fictional people/data in issues, source, screenshots, and tests.
- No cloud sync, external AI, Fiverr/FamilySearch/OneNote integration, or automated client-facing messages in Phase 1.
- Keep Electron renderer sandbox and CSP; validate at IPC/main boundaries; never echo personal input in errors/logs.
- Require confirmation for destructive local actions; do not silently delete/merge data.
- Ship safe backup/restore before pilot with real client information.
- Make no claim of actual researcher approval until the researcher has reviewed the working MVP.

## PR handoff

Each PR references its issue and includes scope, manual checks, automated tests, security/privacy impact and decisions made. Reuse the existing code rather than rebuilding prototype components. Continue through unblocked tickets without waiting for new researcher approval. Stop only for genuinely blocking technical/security decisions or actions needing explicit owner authorization (e.g., real external data transmission or destructive data loss).
