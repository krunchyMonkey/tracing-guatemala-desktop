# Phase 1 — Client Management: build-first MVP specification

**Status:** Project-owner-authorized **implementation baseline**. Researcher feedback and actual approval are deferred to the integrated MVP pilot (#12), not gates for #5–#11.  
**Source of truth:** [Completed workflow review](./researcher-workflow-review-2026-10-28.md) and GitHub issues #1–#12, [#100 — local LAN browser demo](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/100), and [#102 — Driver.js guided tour](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/102).  
**Goal:** Ship a secure, local-first, single-user client directory useful on its own, without requiring genealogy AI, document syncing, or Fiverr APIs.

## Verified facts vs. decisions

**Researcher-confirmed**
- Fiverr orders and their deadlines/packages start the current process.
- Private genealogy research currently spans Ancestry, FamilySearch, OneNote, local folders, and ChatGPT.
- Repeat customers receive personalized Fiverr offers, with package/price adjustments.
- Saving the same materials repeatedly, preparing detailed research notes, and writing client messages are the three highest frustrations.
- All ten current research steps were confirmed. The questionnaire did not define inactive-client, cancellation, permission, or case completion policies.

**Working MVP defaults (project-owner-authorized; subject to pilot feedback)**
- One client profile can represent many past and future engagements; the app will not automate Fiverr orders.
- A client is **active** by default and may be **archived** and **restored**; no hard deletion UI.
- A small client directory and internal contact notes are sufficient for the first pilot.
- The researcher must approve any external send or inferred genealogical conclusion; Phase 1 has no automated sends, uploads, AI calls, or data merges.

## Client data model v1 — implementation baseline (#2)

> **Superseded by the detailed #2 proposal:** [client-data-model.md](./client-data-model.md) (field rules, validation, personal-data classes, lifecycle and approval checklist). The table below is kept as the original baseline.

These are working implementation defaults, **not** evidence that the researcher endorsed individual fields:

| Field | Required | Purpose / notes |
| --- | --- | --- |
| `id` | System | Immutable UUID; never reuse |
| `displayName` | Yes | Researcher's identifying label; need not be legal name |
| `source` | Yes | `fiverr`, `referral`, `direct`, `other` (default to chosen value, not auto-assume Fiverr) |
| `fiverrHandle` | No | External platform handle, not an API credential |
| `email` | No | Contact method when provided |
| `preferredContactChannel` | No | `fiverr`, `email`, `other`, `unspecified` |
| `contactDetails` | No | Optional, structured/minimal, as approved by researcher |
| `status` | System | `active` or `archived` |
| `createdAt`, `updatedAt` | System | UTC timestamps |
| `archivedAt` | System | Nullable UTC timestamp |
| `notes` | Separate collection | Internal dated notes and contact activity (#9) |

**Privacy:** Names, handles, email, contact details, and notes are personal data. Local database only; do not log raw values or include them in analytics, exceptions, screenshots, fixtures, or GitHub. Use fictitious examples.

**Not in client table:** multiple orders, package pricing, case research goals, hours purchased, sourced documents, family tree, and report body. Model these separately in later phases, not as mutable client profile fields. The MVP may keep a freeform reference in a note rather than invent order semantics.

### Lifecycle proposal

- `create`: save valid record; duplicate warnings are advisory (#10).
- `edit`: update approved fields and `updatedAt`; stable ID remains unchanged.
- `archive`: user confirmation; remove from default active view without deleting or breaking notes/future linked cases.
- `restore`: returns to active view preserving stable ID and history.
- `hard delete`, `merge`, and batch actions: **out of scope** for Phase 1.
- Archive behavior for active research cases must be revisited in Phase 2; avoid schema design that cascades hard deletes.

## UI contract for #3 — working prototype, pilot feedback later

Single-window desktop navigation: **Clients**, client profile, and lightweight Settings/Backup route.

1. **Client directory:** clearly labeled Add Client; text search; status and source filters; default active-only view; stable alphabetical sort; no-record and no-match states.
2. **Create/edit:** fields from approved #2; optional fields clearly marked; inline validation; potential-duplicate advisory; Save/Cancel with no accidental partial persistence.
3. **Client profile:** identity, source, preferred channel, optional contacts, status, dated notes/contact history, archived/restore actions, future-cases placeholder clearly labeled.
4. **Archive/restore:** explicit confirmation for archive; archived records read-only or editable policy to be chosen in #2.
5. **Error/empty states:** missing required name, duplicate candidate, failed DB action, blank optional contacts, and backup/restore errors.

**Visual direction:** gentle modern/feminine style consistent with the Tracing Guatemala visual identity; accessible typography, contrast, and keyboard focus take priority. Use fictional client examples only.

## Technical baseline — for #4/#5

- Desktop: Electron, React, TypeScript; choose/document starter and dependency manager in #4.
- Strict renderer/main separation: `contextIsolation: true`, `nodeIntegration: false`, sandbox where supported; typed narrow preload/IPC APIs with input validation; deny arbitrary renderer file/DB access.
- SQLite DB in OS-specific user-data directory, not project directory; parameterized operations; versioned migrations and recovery-safe startup errors.
- No external integrations, browser automation, AI, cloud sync, or network transmission in Phase 1.
- Backups include the **complete Phase 1 local dataset** and can restore transactionally; do not overwrite without confirmation; document local privacy limits.
- Tests: unit (validation/domain), integration (SQLite, migration, persistence), UI smoke (CRUD, search/notes), backup/restore regression.
- Packaging: choose the researcher's target OS and installer **before** claiming installation acceptance; development can begin on the engineer's OS.

## Execution order — build-first

The project owner authorizes the working v1 data model and merged UI prototype for implementation. Researcher approval is **not a prerequisite** for #5–#11. Validate the integrated app with the researcher at #12; record actual feedback there and create focused follow-ups.

| Work | Ticket | Dependency | Next action |
| --- | --- | --- | --- |
| Client model defaults (PR #96) | #2 | Survey documented | **Complete for implementation**; actual feedback at #12 |
| Prototype (PR #97) | #3 | Working #2 model | **Complete as UI baseline**; actual feedback at #12 |
| Secure Electron shell (PR #95) | #4 | None | **Complete** |
| SQLite storage and migrations | #5 | #2 working model; #4 shell | **Complete** (PR #98) |
| Client create/edit/archive/restore | #6 | #5 | **Complete** (PR #99) |
| Optional browser-only HTTP LAN demo | [#100](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/100) (P01-13) | PRs #98/#99 merged | **Ready for Claude now**; browser-only fictional store; no real data |
| Optional provider-neutral guided tour (Driver.js) | [#102](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/102) (P01-14) | #100 merged and LAN HTTP demo usable | **After #100**; guidance-service interface isolates Driver.js and leaves future Pendo optional |
| Search/filter directory | #7 | #5 | **Complete** (PR #101) |
| Client profile | #8 | #5 | **Complete** (PR #103) |
| Notes and contact activity | #9 | #5, #8 | **Complete** (PR #104) |
| Validation and duplicate advisory | #10 | #5, #6 | **Complete** (PR #105) |
| Backup/restore/privacy | #11 | #5 | **Complete** (PR #106); protect unencrypted local backups |
| Packaged integrated pilot | #12 | #4–#11 | **Preparation merged** (PR #107); actual end-user walkthrough and approval pending |

Work in small reviewable PRs; do not invent real user acceptance. External APIs, cloud AI and automatic sends remain out of Phase 1.

### Rapid researcher demos over local HTTP — optional Phase 1 side work

[#100](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/100) creates a **separate browser-preview build**, reusing the existing React UI but **not** the Electron preload/IPC or SQLite database. The preview serves a fictional in-memory data adapter over plain HTTP on a trusted home LAN, with an obvious demo banner. It exists to gather *informal early feedback* without installing a desktop build. The browser site must never contain live records, credentials, genealogy documents, cloud APIs or externally accessible routes. LAN HTTP is not a production/data-sharing transport.

**Fit in roadmap (2026-10-29):** PRs #98–#107 are merged and core Phase 1 issues #1–#11 are closed. **#100 is ready now** on current `main` and must use a browser-only fictional data adapter because #99 replaced the original in-memory store. Start #102 after #100 is merged and the LAN demo is usable. Neither enhancement blocks the #12 installed desktop pilot. Use separate issue branches/worktrees.

**Follow-on tour is NOT part of #100:** After the HTTP demo is implemented, merged, and successfully hosted/accessed from a second home-LAN device, [#102 — Driver.js guided walkthrough](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/102) may build a 4–6 step tour using stable DOM anchors, provider-neutral guide definitions and a `GuidanceService` interface. Driver.js is the sole local/no-telemetry provider for now. Keep all vendor-specific imports inside its adapter. Any future Pendo option would need its own cloud-data and CSP/security review, and Pendo-authored tours may require re-authoring or mapping—do not promise drop-in content compatibility. The walkthrough is optional and should not hold up main MVP tickets.

**Validation remains #12:** researcher testing of the **integrated packaged desktop MVP**, with durable data and verified backup/privacy controls, is still the formal Phase 1 completion point. Browser demo feedback can inform UI changes ahead of that review but does not substitute for it.

## Shared definition of done for implementation tickets

1. Scope + acceptance criteria demonstrated, with a short PR summary referencing the issue.
2. Tests run with results documented; any unavailable tests explained.
3. No real client information, secrets, or filled surveys in public code/issues/test fixtures.
4. Manual validation steps and before/after screenshots for UI work use fictitious data.
5. No cloud/AI/network access or external sends introduced under a Phase 1 ticket.
6. Documentation updated when introducing commands, schema migrations, or behavior differences.

## Questions for the researcher during the integrated pilot (#12)

- [ ] Are the proposed required/optional fields right?
- [ ] How are inactive, archived, repeat, and prospective clients represented?
- [ ] Should archived clients be editable?
- [ ] How are manual offers/orders referenced until Phase 2?
- [ ] Which contact channels/fields are used routinely?
- [ ] Does the client directory/profile design reflect actual use?
- [ ] Which actions require confirmation? (Survey answer: *not sure*; default to conservative)
- [ ] Which OS will she use for the first installed pilot?

These questions **do not block implementation**. Record her actual answers and usability feedback during #12, then refine the model/UI in follow-up tickets. The build-first desktop MVP is implemented; end-user validation remains open. Browser demo and Driver.js tickets (#100, #102) are independent, fictional-data preview enhancements.
