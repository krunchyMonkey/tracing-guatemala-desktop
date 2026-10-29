# Claude handoff — Phase 1 final feature / Phase 2 transition (2026-10-29)

**Repository:** `krunchyMonkey/tracing-guatemala-desktop`  
**Origin:** https://github.com/krunchyMonkey/tracing-guatemala-desktop  
**Base branch:** `main`

## Verified project status
- **Core Phase 1 engineering:** #1–#11 done; PRs #95–#107 merged. Real desktop client management, SQLite, case-ready client identity, contacts/notes, duplicates and backup/restore are implemented.
- **LAN HTTP preview:** #100 done, [PR #108](https://github.com/krunchyMonkey/tracing-guatemala-desktop/pull/108) merged (commit `b17881c`). Browser scripts: `npm run demo:build`, `npm run demo:lan` and `npm run demo:dev`. Browser-only fictional data, no persistence/cloud/backend. Read [LAN preview guide](./docs/demo/lan-preview.md).
- **NEXT / LAST PLANNED PHASE 1 FEATURE:** [#102 — Driver.js tour + private Project feedback](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/102) is **ready for implementation**. One PR with separately testable tour and feedback features; no PR exists yet. Do not auto-merge.
- **Formal Phase 1 pilot:** [#12](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/12) remains OPEN. The pilot kit and unsigned Windows installer were prepared in #107, but there is no recorded researcher walkthrough or signoff. **Engineering complete is not researcher approved.**
- **Next workstream:** Phase 2 — Research Case Management, existing issues [#13–#21](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues?q=is%3Aissue+label%3Aphase%3AP02). Groom #13/#14 with revisable MVP defaults, then build and pilot case management. Do not introduce new researcher approval gates before the integrated Phase 2 review.

## Current assignment — implement #102 (tour + private feedback)

**Read first:** GitHub issue #102 (canonical acceptance criteria), `docs/demo/lan-preview.md`, `src/renderer/src/App.tsx`, `src/renderer/src/components/AppLayout.tsx`, `src/renderer/src/runtime/AppRuntime.tsx`, `src/renderer/src/demo/main.tsx`, `src/renderer/src/screens/ClientsScreen.tsx`, `src/renderer/src/screens/ClientProfileScreen.tsx` and `src/shared/csp.ts`.

Build a **replayable 5–6 step tour** over the actual browser demo: welcome/navigation; directory search/filter; Add Client; existing fictional client profile; notes/contact history; archive/restore explanation. Use real routes and stable app-owned `data-guide-id` anchors. The tour **explains** actions but never silently mutates data, and stays restricted to fictional client information.

Keep the integration deliberately small and swappable:
- App-owned `GuideDefinition`, `GuideStep`, `GuidanceService`/React context and stable anchor IDs.
- One `DriverJsGuidanceProvider` adapter owns all Driver.js imports and locally bundled CSS. A no-op/fake provider supports unit tests. No Driver.js in feature components.
- Demo-mode-only provider by default; do not bundle the tour into desktop releases or change the Electron security model.
- A future Pendo adapter can reuse guide triggers and anchors, but the Pendo guide content may require migration/re-authoring. **No Pendo SDK, tour analytics, remote tour scripts or data collection.**
- **Additional feature: “Send Feedback.”** The demo should offer a small, mobile-friendly feedback form with a clear privacy notice. On intentional submission, the opt-in **local host process** creates a **DRAFT ISSUE in a verified PRIVATE GitHub Project** via GitHub GraphQL `addProjectV2DraftIssue`. It is not a numbered repository issue, and no public issue is ever created from feedback.
- **Critical privacy boundary:** Our `krunchyMonkey/tracing-guatemala-desktop` source repo is **public**. Private GitHub Project visibility does not make that repository's issues private. Prefer the existing private Project's draft issues, which live only in that Project. A future normal numbered-issue workflow would require a **separate private repository** connected to the same Project. Do not automatically create the repository.
- Use server-side, owner-supplied Project credentials only; **no token or Project auth in browser assets**. Confirm `ProjectV2.public === false` before publishing. Fail closed if Project ID/token/verification is unavailable. Offline `demo:lan` should continue to work with a Copy Feedback fallback.
- **CSP:** Default static demo remains `connect-src 'none'`; only a separately enabled feedback mode may allow a **same-origin** POST to the LAN host. Align build meta CSP and server header. Do not weaken Electron CSP, enable wildcard CORS, expose WAN addresses, or create an unauthenticated GitHub issue proxy. The host connects to GitHub with HTTPS.
- Feedback form must **never automatically capture names, client identities, notes, emails, full routes, search queries, screenshots or IP addresses**. Explicit warning against entering sensitive client/genealogy details. Remember the user's LAN HTTP is plaintext; a private GitHub destination does not encrypt the local hop. Restrict/rate-limit the endpoint and use a host-provided access code.
- If a real private Project URL/ID/token isn't available during implementation, ship the server+UI disabled by default with mocks, instructions, and copy fallback. Never claim a live issue was created unless the private project actually returned success.
- The production demo's CSP stays restrictive (`script-src 'self'; style-src 'self'; connect-src 'none'`); verify the tour works under that CSP with no violations. Never quietly relax security directives.
- Support hash-route transitions, loading/missing targets, Skip/Close, Next/Back, restart, teardown, focus, keyboard and phone/tablet views.

Tests: `npm run check`, built `npm run demo:build`, browser-demo Playwright walkthrough cases and packaged Electron smoke verification. Capture screenshots, document keyboard/a11y and any testing limitations. The browser has been tested on the development machine's LAN-origin URL; **physical second-device access is a documented manual owner check, not a coding blocker**. Don't claim it passed unless tested.

Deliver one PR referencing **`Closes #102`**, with separately tested guide and feedback paths, screenshots, updated preview docs, an architecture note for provider swap, **private GitHub Project draft issue setup/limitations** and manual tour and private feedback test steps. **Do not merge without owner action.**

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
