# Phase FIX — Researcher Feedback & Bugfixes (standing P0 interrupt lane)

**Owner instruction (2026-11-05):** Fixes requested by the researcher during actual use outrank ordinary work in Phase 2.7, 2.8, 2.9, Phase 3 and later phases. This phase has no numbered position in the roadmap; it is a permanent **interrupt priority queue**, not a renumbering of existing phases.

- **Tracker:** [Phase FIX epic #204](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/204)
- **Next implementation-ready task:** [#205 — TikTok across client, case and contact-log Via](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/205)
- **Priority:** P0; select the highest-priority dependency-ready Phase FIX issue **before starting** the next numbered-phase story.
- **Safety exceptions:** safely checkpoint current in-progress work; never abandon a partially applied schema migration, interrupt urgent security/data-loss recovery, bypass required review/consent or ship an unsafe regression. Routine verified PRs continue to follow the standing merge-to-main policy.
- **No scope creep:** this lane holds real, reproducible researcher defects and narrow usability consistency fixes. Feature ideas and platform integrations belong in separately evaluated roadmaps unless clearly essential to resolve the reported blocker.
- **Evidence:** every ticket gets concrete behavior, negative/compatibility checks, focused tests, actual `npm run check` results and a short manual QA scenario. Owner/researcher acceptance is still explicit, never implied by a green unit test.
- **Data boundary:** protect shared research records, preserve old values/migrations and backups, keep Demo fictional and never automatically deploy real-data LAN or public application surfaces. Publishing to `main` is separate from deploying.
- **Release cycle:** once a Phase FIX issue is verified and merged, review remaining P0 issues; only resume the feature phase when the Phase FIX ready queue is empty.

## Current backlog

| Issue | User outcome | Status |
| --- | --- | --- |
| [#205](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/205) | TikTok selectable and persistent when creating/editing a client, adding/editing a case, and logging a contact under **Via** | Ready for Claude |

## Note on case creation

At the time of grooming, the New Case form has **no acquisition/source selector**. The TikTok request cannot be satisfied by changing just a shared enum. #205 explicitly adds the missing persisted case-side field with backward compatibility, without rewriting the parent client's source.

## Agent handoff

Read `CLAUDE_HANDOFF.md`, this file, epic #204 and child #205 before selecting the next issue. If safe, switch to #205 for the next issue-scoped branch/PR. Return to the previously active phase only after verified merge and absence of additional P0 Phase FIX work.
