# Claude handoff — Phase 1 completed core; LAN demo and guided-tour queue (2026-10-29)

**Repository:** `krunchyMonkey/tracing-guatemala-desktop`  
**URL:** https://github.com/krunchyMonkey/tracing-guatemala-desktop  
**Default branch:** `main`

## Current status (verified from GitHub)
- **Core Phase 1 engineering (#1–#11):** complete; PRs #95–#106 have merged.
- **#12 pilot preparation:** PR #107 merged, including `docs/pilot/phase-1-pilot-guide.md`, screenshots and Windows installer validation. **The researcher pilot itself is open**; do not claim researcher approval.
- **Next:** [#100 — Local HTTP browser demo](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/100), **ready for immediate implementation** on the merged `main` state.
- **After #100 merges and LAN preview works:** [#102 — Provider-neutral Driver.js walkthrough](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/102). Separate PR and worktree, not part of #100.
- Both #100 and #102 are **optional developer/researcher-preview enhancements** and **do not block** the installed desktop MVP pilot (#12).

Read [Phase 1 plan](./docs/phase-1-client-management-spec.md), [Electron foundation](./docs/architecture/electron-foundation.md), [client storage](./docs/architecture/client-storage.md), [pilot guide](./docs/pilot/phase-1-pilot-guide.md), and the applicable GitHub issue before modifying code.

## Next coding task: #100 — browser LAN HTTP demo

**Goal:** re-use the existing React UI as a demo site on a trusted home LAN, with **fictional, temporary data only**. No Electron process, SQLite connection, backend, native IPC, credentials or cloud services. Separate browser Vite entry, browser demo data adapter, truthful demo-specific Settings state and `Demo Mode — Fictional Data Only` banner.

**Required commands to add:**
- `npm run demo:build` — build browser-only static preview.
- `npm run demo:lan` — serve built assets over HTTP on a configurable trusted LAN interface, port 4173 by default.
- Optional `npm run demo:dev` — browser-only HMR.

**Important existing code boundaries:** `ClientStore.tsx`, `useClientNotes.ts` and `SettingsScreen.tsx` directly use `window.tracingGuatemala`; browser mode needs a clean typed runtime adapter/provider. Reuse `src/shared/client-model.ts` where possible. Do **not** weaken Electron's security/CSP or make backup/restore controls pretend to operate in the demo. Handle secure-context limitations on HTTP LAN origins, including UUIDs.

**Evidence:** browser build and HTTP launch; navigation, edits, notes, filters, duplicate advisory, archive/restore, reset-on-refresh; phone/tablet widths; existing `npm run check` and packaged security smoke. Supply instructions and manual second-device check if physical LAN access isn't available to the coding agent. Do **not** claim second-device testing unless done.

**PR:** one focused PR referencing `Closes #100`, with tests, screenshots, limits, `docs/demo/lan-preview.md` and README updates. Do not add Driver.js here.

## Follow-on coding task: #102 — Driver.js guided walkthrough

**Start only after #100 is merged and the LAN demo is working.** Use the actual demo routes/controls, not duplicate placeholder screens.

- Implement an application-owned guide catalog (`guideId`, `stepId`, route, stable anchor, plain text) and `GuidanceService` interface.
- Feature UI uses stable `data-guide-id` attributes and calls `GuidanceService`; only the `DriverJsGuidanceProvider` adapter imports Driver.js.
- Bundle Driver.js CSS/JS locally through npm, no external calls. Provide fake/no-op provider for unit tests.
- A concise 4–6 step `Take a Tour` walkthrough; skip, back, next, restart, route transitions and missing-anchor recovery; keyboard/mobile-friendly.
- Document future Pendo adapter boundary realistically. **Do not install Pendo** or imply guide content will transfer unchanged. Later Pendo adoption requires privacy/analytics/consent/CSP/network review.
- One focused PR referencing `Closes #102`. Tests, screenshots and manual LAN walkthrough evidence required.

## Worktree safety rules (both issues)

1. Verify `origin` points to **`krunchyMonkey/tracing-guatemala-desktop`**; inspect all existing checkouts and `git worktree list --porcelain`.
2. **Reuse an issue-specific worktree** when present. If no such worktree exists but the repository is locally available, create one from the existing repo and current `origin/main`.
3. **Only clone if there is no usable existing checkout/worktree.**
4. Keep each issue in its own branch/worktree (suggested `feat/100-lan-demo`, `feat/102-guided-tour`). Never reset, clean, delete or overwrite uncommitted files or other worktrees.
5. Before starting #102, update its worktree's base from the merged `main` **without destroying local edits**. Do not stack the #102 PR on an unmerged #100 branch.

## Quality, privacy, and delivery

- Repository is public. Only fictional people, contacts and research content in source, screenshots, logs and tests.
- No real client data over HTTP, no cloud sync, analytics, internet exposure, router forwarding, SaaS integrations or automatic messages.
- Development demo can use plain HTTP on a **trusted home LAN only**; restrict binding/firewall exposure and do not disable Vite host checks. It is not a production deployment or client-data portal.
- Keep existing desktop SQLite, hardened Electron, privacy/backup behavior and tests intact.
- Product owner authorized working defaults; **researcher approval is still pending**, recorded only during the real #12 pilot.
- Follow one ticket per PR. Include summary, build/test commands and outcomes, browser screenshots, manual steps, security impact, limitations. **Never automatically merge PRs.**
