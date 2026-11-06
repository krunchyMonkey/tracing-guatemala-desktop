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
| [#206](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/206) | Live feedback editor with **Ctrl+V/Cmd+V inline screenshots** amid text, previews/removal, and host-private intake | After #205; engineer-ready |
| [#207](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/207) | Owner-approved promotion to PRIVATE numbered GitHub issues and PRIVATE Project board, preserving ordered inline images | After #206; private destination and owner approval needed |

## Note on case creation

At the time of grooming, the New Case form has **no acquisition/source selector**. The TikTok request cannot be satisfied by changing just a shared enum. #205 explicitly adds the missing persisted case-side field with backward compatibility, without rewriting the parent client's source.

## Feedback editor definition of done

This must be a **message composer**, not just a textarea with an unrelated file picker. When the researcher focuses the body and presses Ctrl+V on Windows (or Cmd+V on a Mac) with a copied screenshot, the image appears **at the caret** inside her prose. She can continue typing before/after it, paste several screenshots up to configured limits, remove a mistaken image, and review the composed message before submission. File selection/drag-and-drop are additional options, not substitutes for clipboard paste.

Store the text and inline attachment references in stable order and keep image bytes privately on the host. On owner-approved GitHub promotion, preserve their order with safe private attachment links if the supported GitHub API permits. Never assume a preview is redacted; private client data must not be pushed to this PUBLIC repository. Pending submissions do not leave the host until explicit promotion.

## Agent handoff

Read `CLAUDE_HANDOFF.md`, this file, epic #204 and child #205 before selecting the next issue. If safe, work through **#205 → #206 → #207** in that order, honoring the owner-only private destination and image-upload gates. Return to numbered feature phases only after verified merge and no ready P0 Phase FIX work.
