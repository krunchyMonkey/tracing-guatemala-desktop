# Claude handoff — Phase 1 starter queue (2026-10-29)

Read [Phase 1 specification](./docs/phase-1-client-management-spec.md) and [researcher survey findings](./docs/researcher-workflow-review-2026-10-28.md) before working tickets.

## Start here, in this order

1. **#2 — Client data model and lifecycle:** Write a proposed, versioned field/schema decision document, distinguish confirmed survey facts from proposed defaults. Produce a checklist for the researcher's approval. **Do not treat the draft as signed off.**
2. **#4 — Secure Electron foundation:** Implement the independent starter shell, test/build scripts, typed and validated preload IPC, security posture, placeholder navigation, and document OS packaging assumptions. Do not create speculative client tables or integrations. Can run parallel with #2 on a separate branch.
3. **#3 — Prototype directory and profile:** Use #2's provisional model; create reviewable wireframes or clickable prototype with fictitious client scenarios. Do not implement persisted CRUD until researcher signs off.

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

## Immediate output expected

First PR: #4 secure application skeleton (independent from requirements).  
Second deliverable: #2 proposed field/lifecycle decisions for researcher approval.  
Next: #3 design prototype based on provisional #2, then gated implementation.
