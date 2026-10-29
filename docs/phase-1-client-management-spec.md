# Phase 1 — Client Management: proposed baseline and Claude handoff

**Status:** Engineering proposal based on the researcher-confirmed workflow; **not yet approved by the researcher**.  
**Source of truth:** [Completed workflow review](./researcher-workflow-review-2026-10-28.md) and GitHub issues #1–#12.  
**Goal:** Ship a secure, local-first, single-user client directory useful on its own, without requiring genealogy AI, document syncing, or Fiverr APIs.

## Verified facts vs. decisions

**Researcher-confirmed**
- Fiverr orders and their deadlines/packages start the current process.
- Private genealogy research currently spans Ancestry, FamilySearch, OneNote, local folders, and ChatGPT.
- Repeat customers receive personalized Fiverr offers, with package/price adjustments.
- Saving the same materials repeatedly, preparing detailed research notes, and writing client messages are the three highest frustrations.
- All ten current research steps were confirmed. The questionnaire did not define inactive-client, cancellation, permission, or case completion policies.

**Proposed for MVP, pending confirmation**
- One client profile can represent many past and future engagements; the app will not automate Fiverr orders.
- A client is **active** by default and may be **archived** and **restored**; no hard deletion UI.
- A small client directory and internal contact notes are sufficient for the first pilot.
- The researcher must approve any external send or inferred genealogical conclusion; Phase 1 has no automated sends, uploads, AI calls, or data merges.

## Client data model v1 — proposal for #2

These are suggested fields, **not** claims about the researcher's preferences:

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

## UI contract for #3 — researcher review required

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

## Execution order / gates

| Work | Ticket | Prerequisite | Ready to start? |
| --- | --- | --- | --- |
| Document lifecycle and fields | #2 | #1's documented survey | **Yes — draft proposal and request researcher decisions** |
| Wireframes/clickable mockup | #3 | #2 proposed fields | **Yes — exploratory design; signoff before final UI** |
| Secure Electron shell | #4 | None | **Yes — isolated foundation only** |
| SQLite persistence/migrations | #5 | Approved #2; #4 | **Blocked on #2 signoff and #4** |
| Client CRUD/archive | #6 | Approved #3; #5 | **Blocked** |
| Search/filter directory | #7 | Approved #3; #5 | **Blocked** |
| Client profile | #8 | Approved #3; #5 | **Blocked** |
| Notes/contact activity | #9 | #5; #8 | **Blocked** |
| Validation/duplicate advisory | #10 | Approved #2; #6 | **Blocked** |
| Backup/restore/privacy | #11 | #5 | **Blocked** |
| Installer/pilot | #12 | #4–#11 | **Blocked** |

**Parallelism:** Claude may work on **#2 and #4** immediately, and prototype #3 with explicitly provisional fields. Do not have Claude silently resolve questions reserved for the researcher.

## Shared definition of done for implementation tickets

1. Scope + acceptance criteria demonstrated, with a short PR summary referencing the issue.
2. Tests run with results documented; any unavailable tests explained.
3. No real client information, secrets, or filled surveys in public code/issues/test fixtures.
4. Manual validation steps and before/after screenshots for UI work use fictitious data.
5. No cloud/AI/network access or external sends introduced under a Phase 1 ticket.
6. Documentation updated when introducing commands, schema migrations, or behavior differences.

## Researcher approval checklist (#2/#3)

- [ ] Are the proposed required/optional fields right?
- [ ] How are inactive, archived, repeat, and prospective clients represented?
- [ ] Should archived clients be editable?
- [ ] How are manual offers/orders referenced until Phase 2?
- [ ] Which contact channels/fields are used routinely?
- [ ] Does the client directory/profile design reflect actual use?
- [ ] Which actions require confirmation? (Survey answer: *not sure*; default to conservative)
- [ ] Which OS will she use for the first installed pilot?

Record concrete answers in #2 and #3; unresolved choices should remain open, not treated as approval.
