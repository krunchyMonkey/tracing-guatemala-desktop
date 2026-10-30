# Claude handoff — Web-first pivot / nightly execution queue (2026-10-29)

**Repository:** https://github.com/krunchyMonkey/tracing-guatemala-desktop  
**Base:** `main` · **Current owner direction: WEB CLIENT FIRST** · **No autonomous merge**

## Latest direction (supersedes desktop-first ticket language)
The project's **React/Vite WEB application is now the primary feature client**, chosen to accelerate iterative development. Continue using the existing shared React UI. **Preserve but PAUSE** Electron-specific feature development, installer polish, and desktop packaging as a merge gate. When the WEB client is feature-complete, the owner will reassess whether to maintain/ship a desktop client. Do not delete desktop files or data and do not falsely close #12 (its installed desktop researcher pilot has not occurred).

Read [Phase 2 web-first roadmap](./docs/phase-2-case-management-spec.md) and [#110 web-first runtime foundation](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/110) before implementing new Phase 2 features. Tickets #13–#21 and #109 have been groomed to target web-first development. All user-specific changes must be consistent with these newer directions; ticket references to “main process”, “IPC”, “desktop restart”, or “native export” should be interpreted as web host/API, browser refresh+host restart, and browser download for the web-first target.

### Two *separate* web modes — security boundary
1. **`demo:build` / `demo:lan` / `demo:dev`**: existing trusted-LAN **plain HTTP, fictional, in-memory demo**, resets on refresh. **NEVER** accepts or displays real clients/research records or accesses SQLite. #102 adds a Driver.js tour (`src/renderer/src/guidance/`, demo-only dynamic import; see `docs/architecture/guidance-service.md`) and an *opt-in* server-side private GitHub Project draft feedback bridge; no GitHub tokens in browser, no fallback to PUBLIC repo issues.
2. **Persistent local web app, added by #110**: use a compact Node host plus typed same-origin HTTP API, shared validation and SQLite. Start **loopback-only** (127.0.0.1) on the same computer, with Host/Origin/CSRF/session safeguards and transactional backups. No remote-LAN real data or unencrypted access to sensitive records. New feature pages and tests use **this** app as the primary working product.

Electron and its DB remain preserved, but no automatic migration from the researcher's existing `userData` database. Do not make actual client records public, upload data to GitHub, or bundle secrets in `dist-demo/`.

## Current reality
- Core Phase 1 #1–#11 and LAN preview #100 merged (PR #108, commit `b17881c`).
- **#102** (Driver.js guided walkthrough + private Project draft feedback) remains OPEN and is the last planned Phase 1 web-demo feature. Implement/test with fictional data. If private Project ID/credential unavailable, ship opt-in feedback disabled with mock tests and explicit owner setup. Do not invent a private Project or post user feedback to the public repo.
- **#12** remains OPEN/**deferred** because desktop acceptance hasn't happened. This is not an engineering blocker for web-first Phase 2.
- **#110** is the new Phase 2 P0 **web-first persistent local runtime foundation**.
- Phase 2 groomed: **#13–#21 plus #109**. Each issue defines tests, scope and dependencies. All substantive design defaults are provisional, with actual researcher review in the **WEB-first pilot #21**.

## Suggested coding sequence for tonight

1. **#102** — final Phase 1 web-demo tour + optional private Project feedback. One focused PR with browser E2E/CSP/security checks. No public feedback issues, no default external connections.
2. **#110** — web-first persistent *localhost* runtime (P0). One PR with `web:dev`, `web:build`, `web:local` or documented equivalents, typed React adapters, Phase 1 persisted client/note parity, local SQLite/backup safety and browser API security tests.
3. **#13** — short owner-authorized *provisional* research case lifecycle/intake design; **#14** — one-to-many case schema/data/typed API design. These two may be drafted separately while #110 is in flight; do not fabricate researcher approval.
4. **#15** — case storage, migration and web API; **#16** — browser case directory/detail/forms and fictional-demo parity.
5. **#17**, **#18**, **#19** — case research brief, journal, tasks/optional deadlines; can run as independent PRs only when #15/#16's case contract is stable.
6. **#109** — actual research hours per case (timer + manual sessions) after case overview; prefer after journal.
7. **#20** — web-browser user-triggered Markdown/text summary download plus strict client/case isolation.
8. **#21** — integrated WEB researcher pilot kit and test evidence. **Do not close** until the actual researcher completes her review and gives a decision.

**Priority if the night is short:** make #102 and #110 solid and open a first complete #13/#14/#15 vertical slice rather than dozens of incomplete PRs. No developer may assert PRs are merged or tests passed without verifying it.

## Git/worktree and PR workflow

- Find existing local checkout and inspect `git worktree list --porcelain`; **reuse** issue-specific worktrees. Only clone if none usable. Never reset/clean/delete/overwrite existing changes.
- Pull latest `origin/main`; make one focused PR per issue with `Closes #N` only if the work is complete. #21 must remain open until real end-user approval; #12 stays open/deferred.
- **Do not auto-merge.** If the upstream PRs aren't merged, use an **explicit stacked PR chain** (state `base: feat/... ` and dependencies in title/body). Don't make independent-looking PRs off `main` that lack schema prerequisites. Rebase/retarget safely after merges; no destructive Git operations.
- Default tasks do not require repeatedly interrupting the owner for individual model-field choices. Use bounded, reversible defaults documented as unconfirmed. Stop for sensitive security decisions involving external access, secrets, real client data or deployment exposure.
- Build/test web-first paths: lint/TS/unit, API validation/CSRF/Host, SQLite migration/backup, browser Playwright at mobile/tablet/desktop, fictional demo reset and CSP. Keep prior Electron tests when practical and report regressions; don't block web progress on standalone desktop packaging.
- Every PR: summary, issue/dependencies, scope, screenshots for UI, exact test results/unrun checks, security/privacy impact, manual steps and known limitations. No real names, research records, credentials or screenshots in PUBLIC GitHub.

## Definition of complete
The last Phase 1 **feature PR** can finish at #102, but installed desktop **pilot #12 is intentionally deferred**, not signed off. Phase 2 **web engineering complete** means web PRs merged/tested; Phase 2 **accepted** means the researcher actually pilots the local persistent WEB app in #21 and provides feedback. Desktop continuation is a later owner product decision.

## #110 web-first runtime: implemented (PR pending review)
- `npm run web:dev` (127.0.0.1:5175, HMR + API, `.web-dev-data/`), `npm run web:build` (`dist-web/`), `npm run web:local` (127.0.0.1:4180, real data in its own profile folder).
- Runtime `mode: 'live'` with `src/renderer/src/web/liveApi.ts`; the host is in `src/server/`. Contracts are shared via `src/main/contracts.ts`, services via `src/main/data-services.ts`.
- Security: loopback only, Host check, launch link → HttpOnly SameSite=Strict cookie, Origin + CSRF header on writes, size and media-type limits, CSP `connect-src 'self'`. See `docs/architecture/web-first-runtime.md`.
- New Phase 2 data calls: add the zod contract to `src/main/contracts.ts`, a name to `callable` in `src/server/live-host.ts`, a method to `AppDataApi`, `liveApi.ts` and `demoApi.ts`, and tests in `tests/unit/live-host.test.ts` / `tests/web/`.
