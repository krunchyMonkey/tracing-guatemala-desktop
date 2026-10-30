# Claude handoff — Web-first pivot / nightly execution queue (2026-10-29)

**Repository:** https://github.com/krunchyMonkey/tracing-guatemala-desktop  
**Base:** `main` · **Current owner direction: WEB CLIENT FIRST** · **No autonomous merge**

## Latest direction (supersedes desktop-first ticket language)
The project's **React/Vite WEB application is now the primary feature client**, chosen to accelerate iterative development. Continue using the existing shared React UI. **Preserve but PAUSE** Electron-specific feature development, installer polish, and desktop packaging as a merge gate. When the WEB client is feature-complete, the owner will reassess whether to maintain/ship a desktop client. Do not delete desktop files or data and do not falsely close #12 (its installed desktop researcher pilot has not occurred).

Read [Phase 2 web-first roadmap](./docs/phase-2-case-management-spec.md) and [#110 web-first runtime foundation](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/110) before implementing new Phase 2 features. Tickets #13–#21 and #109 have been groomed to target web-first development. All user-specific changes must be consistent with these newer directions; ticket references to “main process”, “IPC”, “desktop restart”, or “native export” should be interpreted as web host/API, browser refresh+host restart, and browser download for the web-first target.

### Two *separate* web modes — security boundary
1. **`demo:build` / `demo:lan` / `demo:dev`**: existing trusted-LAN **plain HTTP, fictional, in-memory demo**, resets on refresh. **NEVER** accepts or displays real clients/research records or accesses SQLite. #102 adds Driver.js and an *opt-in* server-side private GitHub Project draft feedback bridge; no GitHub tokens in browser, no fallback to PUBLIC repo issues.
2. **Persistent local web app, added by #110**: use a compact Node host plus typed same-origin HTTP API, shared validation and SQLite. Start **loopback-only** (127.0.0.1) on the same computer, with Host/Origin/CSRF/session safeguards and transactional backups. No remote-LAN real data or unencrypted access to sensitive records. New feature pages and tests use **this** app as the primary working product.

Electron and its DB remain preserved, but no automatic migration from the researcher's existing `userData` database. Do not make actual client records public, upload data to GitHub, or bundle secrets in `dist-demo/`.

## Current reality
- Core Phase 1 #1–#11 and LAN preview #100 merged (PR #108, commit `b17881c`).
- **#102** (Driver.js guided walkthrough + private Project draft feedback) moved from Phase 1 to **Phase 2, Milestone 2** as optional, parallel demo-experience work. It does NOT block #110. Implement/test with fictional data. If private Project ID/credential unavailable, ship opt-in feedback disabled with mock tests and explicit owner setup. Do not invent a private Project or post user feedback to the public repo.
- **#12** remains OPEN/**deferred** because desktop acceptance hasn't happened. This is not an engineering blocker for web-first Phase 2.
- **#110** is the new Phase 2 P0 **web-first persistent local runtime foundation**.
- **Phase 2 groomed: 17 open tickets** (#13–#21, #102, #109, #110, #112, #114–#117). Includes safe Demo/Live entry, fictional 48-client preview, Research Studio dashboard, launch/backup readiness and future-phase locked navigation. All substantive workflow defaults remain provisional; actual researcher review stays at **#21**.

## Claude-ready Phase 2 execution queue (updated 2026-10-29)

All Phase 2 tickets are in Milestone 2. **SQLite remains the local database.** Engineering can start without new approval gates; the researcher alone supplies actual pilot acceptance at #21.

### Track A — Safe Live data (release prerequisites)
1. **#110 — P0**: typed local web API/SQLite runtime, client + note parity, Host/Origin/CSRF/session protections, backups and migration safety. **Start this first; #102 is not a prerequisite.**
2. **#13/#14 — P0 design**: provisional lifecycle/intake and portable case schema; may proceed in parallel with #110. Avoid new researcher meetings as coding gates.
3. **#15 — P0**: case migration, repository, typed local API, lifecycle; requires #110 and #14.
4. **#16 — P0**: working case list/detail/dossier UI and small fictional demo adapter; requires #15.
5. **#17/#18/#19 — P0**: research brief, case journal and tasks; depend on #15/#16, and can be separately stacked once contracts stabilize.
6. **#20 — P0**: scoped user-triggered Markdown/text case export; depends on #17–#19; do not block on #109.
7. **#114 — P0**: safe Demo/Live navigation between independently isolated runtimes; depends on #110. LAN demo never exposes private SQLite or a functional Live endpoint.
8. **#117 — P0**: supported local start/stop, backup recovery, unencrypted-copy warnings and real-use operational checklist; depends on #110 and validates #15/#16 case roundtrip.
9. **#21 — P0 final gate**: integrate and verify the actual local persistence workflow with researcher; **NEVER use `Closes #21` in a preparatory PR or close without real approval.**

### Track B — Demo and showcase (parallel where safe)
- **#112 — P1, PR #113 open**: locked future-phase navigation; no active route for incomplete features.
- **#102 — P1, Phase 2**: Driver.js fictional-demo guide and opt-in verified-private GitHub Project feedback; does NOT block #110.
- **#115 — P1**: deterministic 48-client fictional portfolio, first client-only then cases/journal/tasks as their contracts become available; preserve demo reset.
- **#116 — P1**: elegant Studio home dashboard with real metrics from APIs (never hardcoded in Live), derived fictional demo metrics, and accessibility; depends on #110, #15/#16, and #19 for due-task indicators.
- **#109 — P1**: case-scoped timer/manual research hours after case overview, preferably after #18. Does not block #20/initial persistence release.

**Existing doc PR #111** aligns the roadmap; **UI PR #113** is still open, unmerged and unverified for final test status. Check current GitHub state on every development session.

**Priority when time is short:** #110 + a tested #14→#15→#16 case slice; #114/#117 are required before claiming trustworthy Live Mode. Demo visuals may be delivered separately. One issue per PR, explicit stack dependencies, no auto-merges.

## Git/worktree and PR workflow

- Find existing local checkout and inspect `git worktree list --porcelain`; **reuse** issue-specific worktrees. Only clone if none usable. Never reset/clean/delete/overwrite existing changes.
- Pull latest `origin/main`; make one focused PR per issue with `Closes #N` only if the work is complete. #21 must remain open until real end-user approval; #12 stays open/deferred.
- **Do not auto-merge.** If the upstream PRs aren't merged, use an **explicit stacked PR chain** (state `base: feat/... ` and dependencies in title/body). Don't make independent-looking PRs off `main` that lack schema prerequisites. Rebase/retarget safely after merges; no destructive Git operations.
- Default tasks do not require repeatedly interrupting the owner for individual model-field choices. Use bounded, reversible defaults documented as unconfirmed. Stop for sensitive security decisions involving external access, secrets, real client data or deployment exposure.
- Build/test web-first paths: lint/TS/unit, API validation/CSRF/Host, SQLite migration/backup, browser Playwright at mobile/tablet/desktop, fictional demo reset and CSP. Keep prior Electron tests when practical and report regressions; don't block web progress on standalone desktop packaging.
- Every PR: summary, issue/dependencies, scope, screenshots for UI, exact test results/unrun checks, security/privacy impact, manual steps and known limitations. No real names, research records, credentials or screenshots in PUBLIC GitHub.

## Definition of complete
Phase 1 core engineering is merged; **#102 is now a Phase 2 showcase ticket**, not a Phase 1 gate. The installed desktop **pilot #12 remains deferred**, not signed off. Phase 2 **web engineering complete** means web PRs merged/tested; **safe for Live use** additionally requires #110, #114, #117 and verified backup/restore/isolation; Phase 2 **accepted** means the researcher actually pilots the local persistent WEB app in #21 and provides feedback. Desktop continuation is a later owner product decision.
