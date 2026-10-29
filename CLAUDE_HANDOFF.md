# Claude handoff — Phase 1 starter queue (updated 2026-10-29)

Read [Phase 1 specification](./docs/phase-1-client-management-spec.md) and [researcher survey findings](./docs/researcher-workflow-review-2026-10-28.md) before working tickets.

## Status

| Ticket | State |
| --- | --- |
| **#4 — Secure Electron foundation** | **Done.** Merged in PR #95. See [electron-foundation.md](./docs/architecture/electron-foundation.md). Preserve its security controls, IPC conventions and tests. |
| **#2 — Client data model and lifecycle** | **Active.** Proposal in [client-data-model.md](./docs/client-data-model.md). Awaiting researcher answers to its approval checklist. |
| **#3 — Directory and profile prototype** | **Active.** Clickable prototype on in-memory fictional data, built on the provisional #2 model. Awaiting researcher review. |
| #5 onward | **Blocked.** See [client-storage-readiness.md](./docs/architecture/client-storage-readiness.md) for the remaining decisions and order. |

## Active workstream

1. **#2:** Collect the researcher's answers on the issue. Update the model document to `v1` only when she explicitly approves it. **Do not treat the draft as signed off.**
2. **#3:** Iterate on the prototype from her feedback. Do not add persistence, SQLite, or IPC for client data until #2 is approved and #5 lands.

## Dependency flow after researcher signoff

- #2 approved and #4 complete → #5 storage/migrations.
- #3 approved and #5 complete → #6 lifecycle, #7 directory, #8 profile.
- #8 + #5 → #9 notes; #6 + #2 → #10 validation and duplicates.
- #5 → #11 backup/restore.
- #4–#11, plus approval evidence → #12 packaged researcher pilot.

## Working rules

- Treat the existing GitHub ticket as the source for acceptance criteria. Commit only the ticket scope. Do not infer approval from a survey about a different subject.
- Reference `Closes #N` only when *all* acceptance criteria are verifiably met. Otherwise reference `Refs #N` and document blockers.
- One issue per pull request by default; no merge/close just because a draft is ready.
- Before writing code, inspect existing repo/files and do not overwrite concurrent changes.
- Add realistic but **fictional** data to screenshots and tests. Never publish client details in GitHub. The repository is public.
- No unapproved transmission of client records, external AI calls, or provider automation.
- For each PR provide: summary, tests performed/results, manual validation, security/privacy implications, any decisions requiring approval, and screenshots for UI changes.
