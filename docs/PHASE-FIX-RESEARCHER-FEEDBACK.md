# Phase FIX — Researcher Feedback & Bugfixes (standing P0 interrupt lane)

**Highest priority PRIVACY CHANGE (2026-11-05):** [Epic #208](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/208) changes the original shared workspace to private-by-default per-user records with owner-approved sharing. Work order **#209 → #210 → #212 → #211**. This supersedes the former start-with-#205 direction. Protect data immediately: while current multi-user Live still uses the old shared model, do not treat private records as isolated. A deliberate legacy-ownership reconciliation and owner/researcher validation are required. Never silently grant a remote app administrator access to other people's records.

**Owner instruction (2026-11-05):** Fixes requested by the researcher during actual use outrank ordinary work in Phase 2.7, 2.8, 2.9, Phase 3 and later phases. This phase has no numbered position in the roadmap; it is a permanent **interrupt priority queue**, not a renumbering of existing phases.

- **Tracker:** [Phase FIX epic #204](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/204)
- **Next implementation-ready task:** [#209 — ownership, ACL schema and legacy reconciliation](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/209), followed by #210, #212, and acceptance #211. #205 resumes after privacy gates.
- **Priority:** P0; select the highest-priority dependency-ready Phase FIX issue **before starting** the next numbered-phase story.
- **Safety exceptions:** safely checkpoint current in-progress work; never abandon a partially applied schema migration, interrupt urgent security/data-loss recovery, bypass required review/consent or ship an unsafe regression. Routine verified PRs continue to follow the standing merge-to-main policy.
- **No scope creep:** this lane holds real, reproducible researcher defects and narrow usability consistency fixes. Feature ideas and platform integrations belong in separately evaluated roadmaps unless clearly essential to resolve the reported blocker.
- **Evidence:** every ticket gets concrete behavior, negative/compatibility checks, focused tests, actual `npm run check` results and a short manual QA scenario. Owner/researcher acceptance is still explicit, never implied by a green unit test.
- **Data boundary:** protect shared research records, preserve old values/migrations and backups, keep Demo fictional and never automatically deploy real-data LAN or public application surfaces. Publishing to `main` is separate from deploying.
- **Release cycle:** once a Phase FIX issue is verified and merged, review remaining P0 issues; only resume the feature phase when the Phase FIX ready queue is empty.

## Privacy migration — non-destructive release gates (owner direction 2026-11-06)

**Production Live is off limits to development and CI.** Never open its SQLite data folder with a new build or test utility: `openAppDatabase()` applies pending migrations automatically. Do not run `npm run check`, web-live Playwright/default 4191/4192 tests, or database migration rehearsals on the host running private Live. Use synthetic isolated profiles, separate ports and GitHub-hosted CI. Preserve existing worktrees, Caddy, domain, HTTPS and the fictional-only Demo.

**Engineering sequence, not a deployment sequence:** #209 additive ownership/ACL/host-only reconciliation → #210 enforced per-request authorization → #212 explicit sharing → #211 security and recovery validation. #209 and #210 must activate **as one coordinated Live release**; an independently mergeable PR is never an independently deployable database upgrade. The original Phase 2.7 shared-workspace behavior must never be silently retained or re-enabled. Existing legacy records remain unclaimed/sealed until deliberate host-only researcher's ownership assignment; never guess from admin role or first login.

**Release checklist in #211 (no implicit authorization):**
1. On **fictional** database fixtures, enumerate all durable entities (clients, cases, client contacts/notes, journals, tasks, time, notebooks/pages/**revisions**, users and relationships). Verify before/after canonical content hashes and counts, archives, `PRAGMA integrity_check` and `foreign_key_check`, failed/interrupted migration and data recovery.
2. Prove a complete, SQLite-consistent backup restores successfully with the compatible app. For a future approved Live window require two verified recoverable copies, including one encrypted/protected **off the Live machine**; never copy only an active WAL-mode `.sqlite` file.
3. Obtain **fresh explicit owner cutover approval**. Finish autosaves, stop writes, preserve old build, take final verified backups, migrate schema + activate authorization with users offline, check exact content equivalence and ownership, perform researcher-approved host-only reconciliation, validate negative cross-account behavior, and **only then** reopen writes.
4. Before reopening writes, rollback may restore the tested old snapshot **and old compatible app** if checks fail. After writes resume, no blind rollback: a snapshot would discard new work, so use a separately approved data reconciliation/forward-fix plan.
5. Do not close #211/#208 or assume private real-data LAN approval without genuine researcher/owner acceptance; #168/#169/#139 are separate.

**Status:** this section authorizes planning and issue grooming only. It does not approve touching or deploying to private Live, restoring backups, transferring client data, or changing source PR merge gates.

## Current P0 privacy workstream (updated 2026-11-07)
**Source state at grooming:** [PR #238](https://github.com/krunchyMonkey/tracing-guatemala-desktop/pull/238) (ownership) and stacked [PR #244](https://github.com/krunchyMonkey/tracing-guatemala-desktop/pull/244) (authorization) are open with passing GitHub-hosted CI, neither merged nor deployed. This does not constitute independent security approval.

Mandatory preservation-first follow-ups:
- [#248](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/248): production startup refuses pending SQLite auto-migrations; upgrade requires explicit owner-controlled maintenance with backups, offline writer and schema/version checks. **Eligible for isolated Claude work now.**
- [#245](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/245): host-only bulk/per-client **legacy ownership wizard**, consent, restore-verified backups, auditable claims, unchanged notes/notebook revisions.
- [#246](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/246): separate host-operator from ordinary signed-in researcher creation, explicit approved target account/audit for host-only exceptional operations; no remote admin override.
- [#247](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/247): independent timers per researcher and careful reconciliation of the existing global active timer without lost history or cross-account busy signals.
- [#212](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/212): researcher-sharing UI must make **case-only shares usable** with scoped minimal context even if `getClient` returns null, and revoke access on the next request.
- [#211](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/211): **cannot be closed or deployed** until #209/#210/#212/#245/#246/#247/#248, independent privacy review, complete synthetic restore/rollback, two recoverable consistent backups, human owner/researcher sign-off, and successful verification that historic records are visible to the assigned researcher.

No default production migration is authorized by a source merge, issue closure, `claude-ready` label or green CI. Existing Live must remain running and untouched unless user gives **fresh explicit deployment consent**. Note that the repository is PUBLIC: never paste real data, owner consent artifacts with names, paths, row hashes, backups or screenshots into public GitHub. All rehearsals use fictional data and isolated CI/worktrees/ports. No commands on the Windows host that may run Live tests or open production SQLite.

## Current backlog

| Issue | User outcome | Status |
| --- | --- | --- |
| [#209](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/209) | Ownership/ACL persistence and safe host-only legacy claim | **Privacy P0 · first** |
| [#210](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/210) | Enforce resource authorization for all Live APIs and nested records | **Privacy P0 · after #209** |
| [#248](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/248) | Guard production SQLite startup; migration requires explicit maintenance authorization | **Privacy P0 · isolated work can start now** |
| [#245](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/245) | Host-only legacy ownership wizard and consented bulk claim | **Privacy P0 · after #209/#210 security review** |
| [#246](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/246) | Signed-in researcher vs host-operator account creation and recovery | **Privacy P0 · after #209/#210** |
| [#247](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/247) | One active timer per researcher, preserve legacy elapsed time | **Privacy P0 · after #209/#210** |
| [#212](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/212) | Explicit sharing UI, viewer/editor grants and instant revocation | **Privacy P0 · after #210** |
| [#211](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/211) | Cross-user security validation, safe rollout, researcher sign-off | **Privacy P0 · after #212/#245/#246/#247/#248** |
| [#213](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/213) | Per-user configurable source/contact catalog, immutable reserved defaults, seeded editable TikTok | **After Privacy #208, before #214/#205** |
| [#214](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/214) | Settings hub with My Workspace category management, user administration and host-only backups | **After #213, before #205** |
| [#205](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/205) | Use configured values (TikTok plus future new platforms) in client source, case source and contact **Via** | **After #213 and #214** |
| [#206](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/206) | Live feedback editor with **Ctrl+V/Cmd+V inline screenshots** amid text, previews/removal, and host-private intake | After #205; engineer-ready |
| [#207](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/207) | Owner-approved promotion to PRIVATE numbered GitHub issues and PRIVATE Project board, preserving ordered inline images | After #206; private destination and owner approval needed |

## Settings evolution and configurable lists (owner direction 2026-11-05)

The original #205 TikTok request is now implemented **through an editable catalog** rather than hard-coded enums. After the privacy-first #208 work (because custom options must be isolated by account), deliver **#213 backend catalog → #214 Settings hub → #205 form integration**, then #206–#207.

- The current single **Settings & Backup** page mixes account, users, backups, devices and About. Organize as **My Workspace** (each researcher's own configurable sources/contact methods), **Administration** (application owner-only user management), **Backup & Recovery** (trusted host operator only), **About** (everyone).
- Each researcher may add, rename, activate and deactivate their own custom platforms, for example TikTok, Instagram and WhatsApp. Options have stable IDs and applicability to `lead source` and/or `contact Via`; the **case source** uses lead-source choices. When editing an explicitly shared record, its owner's catalog controls available values. An admin role never implicitly grants access to another researcher's catalog or records.
- Protect existing built-in values (Fiverr, Referral, Direct, Other, Email, Unspecified as appropriate) as **Reserved**; they cannot be changed through the UI. Ship TikTok initially active but **editable**, not system-locked. A custom value's stable ID survives edits; deactivate never removes or rewrites historical data; no hard-delete when referenced.
- Keep host-only backups and device actions **host-only**, even for remote account owners; don't mistake a user-admin page for physical-backup authorization. Browser Demo remains fictional/in-memory.
- Scope this as the self-service catalog needed to fix the researcher's dropdown friction, **not** a generic system-wide settings engine, third-party social integration or a new mandatory feature phase.

## Note on case creation

At the time of grooming, the New Case form has **no acquisition/source selector**. The TikTok request cannot be satisfied by changing just a shared enum. #205 explicitly adds the missing persisted case-side field with backward compatibility, without rewriting the parent client's source.

## Feedback grooming gate: default NOT Claude Ready

Researcher feedback entering the private Live intake is initially `Pending owner review` and **not a GitHub issue**. After explicit owner promotion (#207), the new **private** numbered issue must start with the label `needs-grooming`, and the private Project's dedicated single-select `Grooming State` should be `Needs Grooming`. A normal Project Status of `Todo` is insufficient.

Grooming transitions: `Needs Grooming` → `In Grooming` → **explicit owner/trusted reviewer acceptance** → `Claude Ready`; or `Won't Do`. Only after an issue has a concrete scope, acceptance criteria, sanitized reproduction/evidence, tests, dependencies, estimated effort, privacy review and an owner priority decision may the reviewer remove `needs-grooming`, add the `claude-ready` label and mark `Grooming State = Claude Ready`.

**Authorization rule for automation:** A private feedback issue with `needs-grooming`, or without the `claude-ready` label, is NOT eligible to be picked up by Claude, even when a user selects Bug or Phase FIX and even if Project Status says `Todo`. Never automatically mark raw reports ready or P0. Project field sync failure must retain `needs-grooming` and expose a recoverable sync error, never pretend grooming succeeded. Only separately sanitized/approved implementation tickets may enter the public source repository.

This applies to **future feedback submissions**, not the already-owner-groomed implementation stories #205–#207 themselves.

## Feedback editor definition of done

This must be a **message composer**, not just a textarea with an unrelated file picker. When the researcher focuses the body and presses Ctrl+V on Windows (or Cmd+V on a Mac) with a copied screenshot, the image appears **at the caret** inside her prose. She can continue typing before/after it, paste several screenshots up to configured limits, remove a mistaken image, and review the composed message before submission. File selection/drag-and-drop are additional options, not substitutes for clipboard paste.

Store the text and inline attachment references in stable order and keep image bytes privately on the host. On owner-approved GitHub promotion, preserve their order with safe private attachment links if the supported GitHub API permits. Never assume a preview is redacted; private client data must not be pushed to this PUBLIC repository. Pending submissions do not leave the host until explicit promotion.

## Agent handoff

Read `CLAUDE_HANDOFF.md`, this file, epic #204 and child #205 before selecting the next issue. If safe, **prioritize #209/#210 review + #248, then #245/#246/#247/#212 → #211**, including migration/privacy/owner gates. Next implement **#213 → #214 → #205 → #206 → #207**, honoring user-scoped catalogs and owner-only private feedback/image-upload gates. Resume numbered feature phases afterward. Return to numbered feature phases only after verified merge and no ready P0 Phase FIX work.
