# Phase 2 — Research Case Management: Claude implementation plan

**Status:** Owner-directed **build-first working specification** (2026-10-29). All model fields and case-state names below are *engineering defaults*, **not** evidence of researcher approval. Preserve unresolved decisions for the Phase 2 integrated pilot (#21).  
**Repository:** [tracing-guatemala-desktop](https://github.com/krunchyMonkey/tracing-guatemala-desktop) · **Web-first foundation:** [#110](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/110) · **Issues:** [all Phase 2 tickets](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues?q=is%3Aissue+label%3Aphase%3AP02), including #102, #109, #110, #112 and #114–#117.

## Web-first architecture pivot — latest owner direction (2026-10-29)

**Supersedes any desktop-first implementation advice below.** The **React/Vite WEB application is now the primary development, testing and pilot client** to accelerate delivery. **Do not remove or break existing Electron code**, but freeze new desktop UI feature integration, installer work, Electron packaging-as-gate and desktop-specific polish until the browser product is feature-complete and the owner decides whether a desktop distribution is needed. Existing Phase 1 #12 desktop pilot stays open/deferred, not falsely completed. The application repository/name can remain `tracing-guatemala-desktop` for now; no needless rename.

**Foundation first:** [#110 — Web-first persistent local runtime](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/110) is a **P0 prerequisite for #15+ feature implementations**. It adds a typed Node-based local web API/SQLite host and reuses the existing React UI and domain validation. #13/#14 are documentation/design and may be prepared in parallel with #110. Features #15–#20 and #109 target the **persistent local web runtime + browser tests** as their acceptance surface, not Electron IPC. Avoid implementing the same feature twice.

**Two intentionally distinct browser modes:**
- **Public-facing only to the trusted HOME LAN, HTTP, fictional data:** existing `demo:*` scripts remain an isolated ephemeral walkthrough; no real data, no backend, no real records, no connection to local SQLite. Driver.js and opt-in private Project draft feedback from #102 remain scoped to this fictional demo.
- **Persistent LOCAL-ONLY web app:** #110 adds `web:dev`, `web:build`, `web:local` (or documented equivalents), a small same-origin API, typed runtime adapters and SQLite persistence for use *on the host computer*. Bind **only to loopback** by default, require Host/Origin/CSRF/size/auth protections, and test that it cannot be reached by a different LAN device. Do **not** serve personal research records through plain HTTP LAN. Later remote access needs HTTPS, authentication and explicit privacy review.

**Backend reuse:** extract narrowly scoped SQLite storage/domain services from the current Electron main where feasible; don't fork validation rules, duplicate DB schemas, silently open/overwrite the desktop user database, or embed private data/keys in browser bundles. Data model is shared; Electron runtime remains preserved but deferred. Transactional local backups still matter.

**Acceptance focus:** each Phase 2 coding ticket should deliver a tested feature in the **web client** with persistence through the local API and **fictional in-memory demo parity where useful**, not require an Electron packaged test to pass. Run web-first API/security/SQLite/browser E2E checks; describe any desktop regression but do not block web feature velocity on desktop packaging. Complete the actual researcher pilot for the web client in #21, while keeping prior #12 desktop signoff open/deferred.

## What Phase 2 delivers
One **client** can have multiple distinct **research cases**, each with a lifecycle, clearly separated objectives/facts/hypotheses/questions, time-ordered research journal, optional tasks/due dates, selected-case export, and tracked research hours. Archive/reopen preserves history. The web-first LOCAL runtime persists through SQLite on loopback; the separate trusted-LAN HTTP demo still uses **fictional data only**, an in-memory adapter and no real records. Electron implementation is preserved but paused. No FamilySearch/Fiverr API integration or cloud AI.

## Scope / provisional data decisions

- **One-to-many:** immutable UUID `case.id`, required FK `case.clientId`; case title required (max 160 chars); optional description/goal, date-only deadline and platform/order reference (plain text only, not credentials). Preserve links through client archive/reopen. No hard delete/cascade. Use forward-only SQLite migrations and server-side validation through the local web host.
- **Lifecycle working default:** `intake → active → waiting → delivered → closed`, with supported reopen to `active`. Users can move between active/waiting; do not invent automatic transitions or claim these states were confirmed by the researcher. **Archive** is separate from research progress: reversible `archivedAt` flag; it never deletes the case. `delivered` means a result was sent outside the application by the researcher; `closed` means administrative completion; no external sending automation. UI may allow correcting states explicitly with user confirmation as appropriate.
- **Parent archive:** archived clients remain viewable; existing cases remain linked, visible and recoverable. Provisional safety default: require restoring an archived client before *creating a new case* under that client. Do not silently mutate active cases when parent is archived.
- **Facts vs uncertainty:** distinct sections for objective/requested outcome, known facts/people (unverified unless marked as such), hypotheses, and unresolved questions. Don't present hypotheses as established genealogy facts. No genealogical relationship inference/AI.
- **Research journal:** date/time and plain-text body linked to exactly one case, with deterministic newest-first display. Keep case research journal distinct from Phase 1 *client communication* notes.
- **Tasks:** pending/completed state; optional date-only deadline; title and optional description; no external reminders. Use local calendar dates for due dates (avoid timezone-induced day shifts).
- **Export:** default a portable **Markdown or plain text** case summary, rather than PDF/report templates (later phase). In the web app, export a **user-initiated browser download** of a selected case, with safe filename/content handling and no arbitrary server file writes. Do not depend on Electron native dialogs. Scope strictly to selected case/client and applicable research notes/tasks; human-reviewed, no auto-send. If #109 hours tracking is done, optionally include a totals summary.
- **Research hours (#109):** a later feature after case CRUD/overview; one timer per local web app/profile, manual sessions, case-scoped totals, safe interrupted-session reconciliation, backup and migration tests. No billable/financial math in Phase 2.

Unresolved and **not researcher-approved**: actual case state vocabulary, required intake fields, when case is "complete", package/hours allowance, which activities count as research time, export format and journal naming. Capture answers during #21; avoid stopping safe MVP engineering.

## Architecture / privacy contract
- **Primary web client/runtime:** React/Vite UI and narrow typed same-origin API backed by server-side validation and versioned local SQLite migrations/backups. Start loopback-only with Host/Origin/CSRF/session protections. Never expose the persistent API to the LAN. Preserve Electron isolation/preload code for later decisions; no new Electron-only feature implementations.
- **Two web runtimes:** extend `useAppRuntime()` with typed case/journal/task/hour contracts for (1) local persistent API mode and (2) fictional in-memory LAN-demo mode. Never bundle actual client data, SQLite DB, backups or feedback credentials into `dist-demo/`. Demo refresh resets the data. Export and timer persistence differences must be explained honestly.
- **Public GitHub repo:** no real client/case names, genealogy materials, purchased packages, contact details or real research hours in source, fixtures, screenshot evidence, logs, comments or PRs. Fictional examples only.
- **Tests:** `npm run check` where practical, typed contract/unit, SQLite migrations on v2 data, persistence/restart, cross-client isolation, backup/restore, local HTTP API security and browser E2E in persistent mode plus fictional-demo parity. Electron packaging/security tests are regression information, **not a Phase 2 feature gate**. Report actual results; never invent pass claims.
- **Phase 2 demo showcase:** #102 moved from Phase 1 to **Phase 2, Milestone 2** and is independent Driver.js guided-tour/private Project feedback work. It is not a prerequisite for #110 or Live Mode readiness. If feature branches touch the same UI, coordinate by rebasing after merge or use explicit stacked PR bases; preserve local worktrees. Do not broaden #102 with Pendo or Live-data Project APIs.

## Nightly implementation order and dependencies

| Order | Issue | Deliverable | Prerequisite |
| --- | --- | --- | --- |
| Parallel | [#102](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/102) | Phase 2 guided fictional-demo tour and opt-in **private** Project draft feedback (separate worktree) | Merged #100; **does not block #110**; credentials optional for disabled mode |
| 0 | [#110](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/110) | P0 **web-first persistent local runtime**; React/browser primary | **Independent of #102**; coordinate shared-file changes across branches |
| 1 | [#13](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/13) | Provisional lifecycle/intake spec with unknowns flagged | Existing workflow review |
| 2 | [#14](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/14) | Case model, schema and migration contract | #13 spec |
| 3 | [#15](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/15) | Case repository/typed WEB API and create/edit/state/archive/reopen | #14 and **#110** |
| 4 | [#16](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/16) | WEB case directory/detail page and links; persistent localhost + fictional demo adapter | #15 |
| 5 | [#17](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/17) | Objectives, known facts, hypotheses and questions | #15/16 |
| 6 | [#18](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/18) | Case journal persisted in backups | #15/16 |
| 7 | [#19](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/19) | Pending/completed tasks and optional deadlines | #15/16 |
| 8 | [#109](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/109) | Case timer, manual entries, totals; late P1 | #15/16, preferably #18 |
| 9 | [#20](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/20) | Case summary export and isolation suite | #17–#19; #109 hours totals optional |
| 10 | [#21](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/21) | **Web-first** integrated pilot kit, tests and actual feedback | #110, #15–#20; include #109 if ready |

## Added Phase 2 backlog: Live safety + showcase (owner direction, 2026-10-29)

These are **focused, separate** tickets. The local datastore remains `node:sqlite` and the real-data host remains loopback-only; Docker/PostgreSQL, hosted access and multi-researcher sync are out of scope.

| Ticket | Priority | Scope | Dependency / ordering |
| --- | --- | --- | --- |
| [#114](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/114) | P0 | Safe Demo/Live entry and switch; isolated origins, session-aware Live, no data crossover | #110; never exposes Live via LAN |
| [#117](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/117) | P0 | Launch/stop simplicity, backup/recovery verification, storage warnings, Live-readiness checklist | #110, case roundtrip #15/#16 |
| [#112](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/112) | P1 | Locked and disabled Phase 3–9 navigation with accessible Coming Soon labels | Independent; proposed in open PR #113 |
| [#102](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/102) | P1 | Driver.js guided fictional-demo tour and opt-in private Project feedback | Independent, moved to Phase 2; not a prerequisite for #110 |
| [#115](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/115) | P1 | Deterministic fictional portfolio of 48 clients, eventually cases/journals/tasks | Start client fixtures now; extend when #16/#18/#19 land |
| [#116](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/116) | P1 | Elegant Research Studio Home, truthful API-derived Live stats and fictional-demo metrics | #110, #15/#16, #19 for due-task stats |
| [#109](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/109) | P1 | Case research hours (manual/timer) | #15/#16; prefer #18; not blocking #20 |

**Safety gate:** Demo is always fictional, ephemeral and safe for trusted LAN. Live is authenticated/session-protected on the local host only; do not implement a client-side mode flag that switches data source on the same LAN origin. Validate SQLite restart, backup/restore, denied external access, and cross-client data isolation before real records are used.

**Showcase target:** present an appealing, busy fictional research studio and gracefully label unreleased features; do not fake delivery of Evidence Library, AI, Reports, Family Trees, Integrations, or Business Tools.

**Acceptance:** #21 is the actual researcher-review gate, with both fictional Demo walkthrough and private Live persistence scenarios. Docs or demo visuals alone are not signoff. Prep PRs must use `Refs #21` rather than `Closes #21`. Preserve #12 as deferred legacy Electron pilot.

**PR coordination:** open docs PR #111 and sidebar PR #113 exist on separate branches. The new queue is owner direction, not evidence those PRs are merged or tests passed. Use worktrees/explicit stacked dependencies and **never auto-merge**.

**Throughput:** #110 is the first Live Mode prerequisite, while #102/#112/#115 can proceed in parallel as Phase 2 demo polish. #13/#14 are short engineering documents using **reversible defaults** and should not require a new meeting to start coding. #21 is the real researcher acceptance point. #12 (Phase 1 installed desktop researcher pilot) remains OPEN independently until genuine signoff.

## PR policy for an unattended Claude coding session

1. Locate the existing local checkout first and inspect `git worktree list --porcelain`; reuse issue worktrees. Clone only when no usable checkout exists. No reset, clean, removal or overwriting unrelated changes.
2. **One issue per small PR** with focused commits, tests, screenshots for UI, documented design/backup/privacy impact and `Closes #N` only when appropriate. **Never auto-merge, auto-close the pilot issue or fake signoff.**
3. If dependency PRs cannot merge overnight, Claude may **explicitly stack** the next PR on the previous issue's branch (document the actual base and dependency in every PR). Never pretend a stacked PR is independently mergeable into `main`. Keep the chain linear where schema/UI touches overlap; avoid parallel conflicting branches.
4. Prioritize a **passing, complete vertical slice** over checking every issue off. If long-running tests/permissions/credentials block, report blockers, preserve changes, and continue only on truly independent tasks.
5. Do not publish reports about actual GitHub Project private drafts unless a verified private destination is configured; default offline/demo paths and local mock tests should pass without external credentials.

## Exit criteria
Engineering ready when the **web-client** feature PRs are validated and merged into `main`. **Phase 2 accepted** only when the researcher exercises the local web app's client→case workflows, journal, tasks, optional time tracker and export in #21, with real feedback recorded. Phase 1 desktop user acceptance stays open/deferred in #12; desktop continuation will be decided only after web feature completeness. No fabricated completion.
