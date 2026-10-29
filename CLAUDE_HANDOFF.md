# Claude handoff — Phase 1 final feature / Phase 2 transition (2026-10-29)

**Repository:** `krunchyMonkey/tracing-guatemala-desktop`  
**Origin:** https://github.com/krunchyMonkey/tracing-guatemala-desktop  
**Base branch:** `main`

## Verified project status
- **Core Phase 1 engineering:** #1–#11 done; PRs #95–#107 merged. Real desktop client management, SQLite, case-ready client identity, contacts/notes, duplicates and backup/restore are implemented.
- **LAN HTTP preview:** #100 done, [PR #108](https://github.com/krunchyMonkey/tracing-guatemala-desktop/pull/108) merged (commit `b17881c`). Browser scripts: `npm run demo:build`, `npm run demo:lan` and `npm run demo:dev`. Browser-only fictional data, no persistence/cloud/backend. Read [LAN preview guide](./docs/demo/lan-preview.md).
- **NEXT / LAST PLANNED PHASE 1 FEATURE:** [#102 — Driver.js guided tour with provider-neutral guidance adapter](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/102) is **ready for implementation**. No PR for #102 exists yet. **One scoped PR**; do not auto-merge.
- **Formal Phase 1 pilot:** [#12](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/12) remains OPEN. The pilot kit and unsigned Windows installer were prepared in #107, but there is no recorded researcher walkthrough or signoff. **Engineering complete is not researcher approved.**
- **Next workstream:** Phase 2 — Research Case Management, existing issues [#13–#21](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues?q=is%3Aissue+label%3Aphase%3AP02). Groom #13/#14 with revisable MVP defaults, then build and pilot case management. Do not introduce new researcher approval gates before the integrated Phase 2 review.

## Current assignment — implement #102

**Read first:** GitHub issue #102 (canonical acceptance criteria), `docs/demo/lan-preview.md`, `src/renderer/src/App.tsx`, `src/renderer/src/components/AppLayout.tsx`, `src/renderer/src/runtime/AppRuntime.tsx`, `src/renderer/src/demo/main.tsx`, `src/renderer/src/screens/ClientsScreen.tsx`, `src/renderer/src/screens/ClientProfileScreen.tsx` and `src/shared/csp.ts`.

Build a **replayable 5–6 step tour** over the actual browser demo: welcome/navigation; directory search/filter; Add Client; existing fictional client profile; notes/contact history; archive/restore explanation. Use real routes and stable app-owned `data-guide-id` anchors. The tour **explains** actions but never silently mutates data, and stays restricted to fictional client information.

Keep the integration deliberately small and swappable:
- App-owned `GuideDefinition`, `GuideStep`, `GuidanceService`/React context and stable anchor IDs.
- One `DriverJsGuidanceProvider` adapter owns all Driver.js imports and locally bundled CSS. A no-op/fake provider supports unit tests. No Driver.js in feature components.
- Demo-mode-only provider by default; do not bundle the tour into desktop releases or change the Electron security model.
- A future Pendo adapter can reuse guide triggers and anchors, but the Pendo guide content may require migration/re-authoring. **No Pendo SDK, analytics, credentials or external requests now.**
- The production demo's CSP stays restrictive (`script-src 'self'; style-src 'self'; connect-src 'none'`); verify the tour works under that CSP with no violations. Never quietly relax security directives.
- Support hash-route transitions, loading/missing targets, Skip/Close, Next/Back, restart, teardown, focus, keyboard and phone/tablet views.

Tests: `npm run check`, built `npm run demo:build`, browser-demo Playwright walkthrough cases and packaged Electron smoke verification. Capture screenshots, document keyboard/a11y and any testing limitations. The browser has been tested on the development machine's LAN-origin URL; **physical second-device access is a documented manual owner check, not a coding blocker**. Don't claim it passed unless tested.

Deliver one PR referencing **`Closes #102`**, with tests, screenshots, updated preview docs, an architecture note for provider swap, and manual tour steps. **Do not merge without owner action.**

## Local checkout / worktree rules
1. Inspect existing local repos and verify `origin` matches this repo. Run `git worktree list --porcelain`.
2. Reuse a `#102` worktree if present; otherwise create `feat/102-guided-tour` from up-to-date `origin/main` in the existing checkout.
3. Clone only if no usable checkout/worktree exists. Never overwrite/delete/reset/clean other worktrees or uncommitted files.
4. Keep the guide in its own branch/PR. Avoid unnecessary edits to other issues.

## Closeout and next phase
- **After #102 merges:** confirm its checks on `main`, record the guide/preview commands, and mark Phase 1 **feature engineering complete**.
- **Issue #12:** complete a short actual desktop pilot on the researcher's selected OS, review unencrypted local DB/backups and the realistic client workflow using fictional data, capture her feedback and actual decision. Do not claim or record signoff on her behalf; #12 stays open until that happens.
- Phase 2 preparation and design may start **in parallel with #12** so end-user feedback does not become an unnecessary build gate. Address any must-fix Phase 1 issues before declaring the full Phase 1 milestone accepted.
- Keep real genealogy data off GitHub, browser HTTP preview, screenshots, external analytics or SaaS. Desktop privacy rules, offline/no-telemetry policy and Electron CSP remain mandatory.
