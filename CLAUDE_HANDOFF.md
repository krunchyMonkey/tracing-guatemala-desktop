# Claude handoff — Web-first (updated 2026-10-30 for Phase 3 notebook priority)

> **LATEST OWNER ROADMAP / PR POLICY OVERRIDE — 2026-10-30:** Phase 3 is now **Research Notebook & Freeform Canvas**, prioritized before previous Phase 3 Evidence Management (now future Phase 4). See [Phase 3 spec](docs/phase-3-research-notebook-spec.md) and [tracking issue #145](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/145); child issues #146–#157 by Release A–D, with #158 AI formalization design **DEFERRED**. Older instructions below are historical where inconsistent.
>
> **Standing PR instruction for routine project implementation:** When an issue's acceptance criteria are complete, local tests/review/security checks genuinely pass and dependencies are merged/verified, **merge its PR promptly**, confirm GitHub reports merged, and continue to the next unblocked issue. Prefer squash for focused PRs. Never merge a failing/blocked PR or bypass real researcher signoff (#21/#157), unresolved review, privacy decision, HTTPS LAN exposure (#139), or other sensitive owner-required approval. GitHub repo `allow_auto_merge=false`; this is a safe merge-on-completion process, **not** blind auto-merge. Preserve unrelated PR #111 pending its own review.
>
> **Replaceable notebook libraries:** Domain, SQLite, typed API and recap service use application-owned versioned notebook/page/block/scene IDs/contracts; rich-text and canvas implementation libraries stay behind injected editor/canvas adapters. Canvas references canonical blocks, not duplicate copies. No LLM dependency or external calls in Phase 3; deterministic recaps are first class. No real client data over HTTP LAN.

**Repository:** https://github.com/krunchyMonkey/tracing-guatemala-desktop  
**Base:** `main` · **Current owner direction: WEB CLIENT FIRST** · **No autonomous merge** unless the owner authorizes a named set of PRs (Phase 2.5 #135–#138 was authorized on 2026-10-30; that authorization does not cover #111, #139 or later work)

## Verified state (2026-10-30)
GitHub is the source of status and the code is the truth; re-check both before acting on this file.

- **Phase 2 web engineering:** merged (#13–#20, #109, #110, #112–#117). **#21 researcher pilot stays OPEN** until the researcher actually reviews and decides. Never close it on engineering evidence.
- **Phase 2.5 — opt-in HTTP LAN Live (#134):** merged as PRs #140 (#135 LAN listener), #141 (#136 device enrollment), #142 (#137 UX, controls, Demo/Live LAN switching; closed #136 and #137) and #143 (#138 automated validation).
  - #135, #136 and #137 are closed.
  - **#138 is open:** its owner manual checklist in `docs/pilot/phase-2.5-lan-validation.md` is NOT RUN, and the owner has not approved engineering readiness.
  - #134 is open until #138 closes.
- **Phase 3 Release A — Research Notebook foundation (#145):** merged under the standing merge-on-completion instruction (squash PRs, local gate each time):
  - #146 → PR #160: app-owned `tg-note/1` content and `tg-canvas/1` contract (`src/shared/note-content.ts`, `notebook.ts`, `notebook-canvas.ts`), editor/canvas ports (`src/renderer/src/notebook/ports.ts`), DI via `NotebookAdaptersProvider` and the composition root `notebook/adapters/index.ts`, plain-text adapter, ESLint vendor boundary.
  - #147 → PR #161: migration 8 (`case_notebooks`, `notebook_sections`, `notebook_pages`, append-only `notebook_page_revisions`), `NotebookRepository`, 16 typed API calls, demo implementation with demo/SQLite parity script, backup restore verifies page count. JSON body limit is 1 MiB.
  - #148 → PR #162: Tiptap **3.31.4** (MIT, exact pins, vanilla core) only in `notebook/adapters/tiptap/`; notebook routes `cases/:caseId/notebook[/:pageId]`, sections/pages UI, toolbar, responsive Pages drawer.
  - #149 → PR #163: in-memory `NotebookDraftStore` (no browser storage of notes), retry/backoff, conflict banner + `keepPrevious`, history dialog with `NoteContentView`, links to journal/task/hours records (never copies), explicit confirmed "create task / add to journal", notebook timer via `TimerContext`.
  - Integrated verification: `tests/web/live-notebook-release-a.spec.ts`, `tests/renderer/NotebookReleaseA.test.tsx`, checklist `docs/pilot/phase-3-release-a-verification.md` (manual items NOT RUN), screenshots `docs/screenshots/release-a/`.
  - Architecture and extension points: `docs/architecture/research-notebook.md`. Replacing the editor = new folder under `notebook/adapters/<provider>/` passing `describeEditorAdapterContract`, then switch the composition root; no domain/SQLite/API change.
  - **#145 stays OPEN**: Releases B–D remain, and researcher acceptance is #157. Never claim researcher approval of the notebook.
  - Known limitations: revisions are snapshotted at most every 5 minutes (plus restore points) and never pruned; any non-refusal save error is retried (a permanently rejected payload keeps "retrying"); clicking a reference chip in the editor opens its record; cancelling the web-address Link dialog can collapse the selection; wrapped toolbar row shows a stray separator; lint warning in `notebook/ModalDialog.tsx` (exhaustive-deps); occasional flakes `live-lan.spec.ts:245` (timeout) and `live-notebook.test.ts` 413 case (`ECONNRESET` under load) — both pass on rerun. Under parallel load, Vitest also intermittently fails `notebook-boundary` (ESLint timeout), `NotebookReleaseA` (autosave timing), `CaseHours` and `live-lan-ux`; rerun the full gate with nothing else running.
- **Phase 2.6 — HTTPS home-network Live (#139), owner authorized routine PRs for #165–#169 on 2026-10-30; never merge anything that enables real data or LAN exposure without explicit owner approval:**
  - #165 → PR #170: `docs/operations/https-lan-dns.md`. **Owner decision 2026-10-31 (Option B):** a public Cloudflare **DNS only** A record `tg` → the host's private IPv4 (no AAAA, never proxied) replaced split-horizon DNS, because neither router supports local records and per-device DNS was brittle. Verified via 1.1.1.1, 8.8.8.8, 9.9.9.9 and both home routers. The apex and `www` serve a GitHub Pages site (same site as `tg`; noted for #168). **Open:** dashboard checks, DHCP reservation, router port-forward/UPnP check, mobile-data check.
  - #166 → PR #171: `deploy/caddy/` (pinned build, portable Caddyfile, launcher) and `docs/operations/https-lan-tls.md`, guarded by `tests/unit/caddy-config.test.ts`; set `TG_CADDY_BIN` for the real-binary checks. A production Let's Encrypt certificate for `tg.krunchymonkey.dev` was issued on the owner's host (valid to 2027-01-28). **Open:** no renewal observed yet; Caddy runs only when started by hand.
  - #167 → PR #172: `--https-host <name>` adds a listener on `127.0.0.1:<port+2>` for the reverse proxy. It uses the paired-device path with `https://<name>` origin and Secure cookies, never reads forwarded headers, and keeps the fictional-profile gate; it is exclusive with `--lan-host`. Verified end to end through Caddy on loopback. #174 fixed the pairing page, banner and Settings claiming "Unencrypted HTTP" over HTTPS.
  - **Fictional LAN pilot (2026-10-31):**
    - **Running:** Caddy runs on the host's LAN address, TCP 443 only (`protocols h1 h2`). The owner applied one firewall rule for it, limited to the Deco subnet; the network category is still Public on purpose. Live runs on `--port 4190 --https-host`, because a plain-HTTP LAN test host holds 4180.
    - **Verified:** pairing, CSRF/Origin/host-only checks, revocation, persistence and two household devices; results in `docs/operations/https-lan.md`.
    - **Open:** devices still to pair and save records, a revoke test, the mobile-data check, retiring the pilot CoreDNS and its two firewall rules, and a persistent Caddy so renewal can be observed.
    - **Playwright clash:** the web specs use 4191/4192 while the pilot runs, so set `WEB_E2E_PORT` and `WEB_E2E_CASES_PORT`.
  - **Blocked on owner decisions:** #168 (how real data may be enabled over HTTPS; Google Sign-In is not in its scope) and #169 (final validation and explicit privacy approval).
  - **Host-only, never in GitHub:** the token is the single `.txt` in a restricted folder outside the repo. Host Caddy lives in a `<tg-https>` folder in the owner's profile (copies of `deploy/caddy`, `data\` ACL-restricted). Never print or log the token.
- **Next implementation issue:** #150 (Release B, P03-05 draggable linked canvas) through the existing `CanvasSurfaceAdapter` port and `tg-canvas/1` contract.
- **Open, not in scope:** docs PR #111.
- **Gate:** `npm run check` (lint, typecheck, Vitest, Playwright electron + browser-demo + web-live), plus `smoke:live`, `pilot:rehearsal`, `lan:rehearsal` and `demo:build`. This repo has **no GitHub CI and no branch protection**, so record local results and never claim CI.

### LAN Live rules (Phase 2.5) — read `docs/operations/lan-live.md`
- **Default is unchanged:** `npm run live` listens on `127.0.0.1` only. LAN needs `--lan-host <private IPv4 of this computer>`: RFC 1918, on exactly one adapter, no wildcard, no env var.
- **Fictional test profiles only.** `--lan-host` refuses the default data folder and any folder without `lan-test-profile.json`. `--init-lan-test-profile` marks only a new or empty folder. While LAN is on, restore and backup upload are disabled. Real records over LAN wait for HTTPS (#139) and an explicit owner decision.
- **Devices:**
  - pair with a 5-minute, one-time code shown in host Settings;
  - each device gets its own memory-only session (`tg_lan_<port>`, HttpOnly, SameSite=Strict, `Secure` automatic on https), with 60 min idle / 12 h absolute expiry;
  - revoke, logout and **Turn off home-network access** (`disableLan`) are available;
  - backups and device admin are host-only.
- **Demo/Live switching on the LAN** needs `--lan-demo-name <dns name resolving to the LAN IP>`, so the demo is a different *site* from Live's IP. Switch targets come only from server configuration (the session `demoUrl`, the `tg-live-url` meta tag). Never run `demo:lan` alongside LAN Live (same IP = same site).
- **Plain HTTP encrypts nothing:** codes, cookies and records can be read on the network. Never describe pairing as protection against interception. No router forwarding, UPnP, guest/public Wi-Fi or internet ingress. No LAN IPs, codes or links in public GitHub.
- Test hook `TG_TEST_RESOLVE` works only with `TG_TEST_HOOKS=1` (automated tests only).

The sections below are the 2026-10-29 Phase 2 queue, kept for history; their "pending" notes are superseded by the state above.

## Latest direction (supersedes desktop-first ticket language)
The project's **React/Vite WEB application is now the primary feature client**, chosen to accelerate iterative development. Continue using the existing shared React UI. **Preserve but PAUSE** Electron-specific feature development, installer polish, and desktop packaging as a merge gate. When the WEB client is feature-complete, the owner will reassess whether to maintain/ship a desktop client. Do not delete desktop files or data and do not falsely close #12 (its installed desktop researcher pilot has not occurred).

Read [Phase 2 web-first roadmap](./docs/phase-2-case-management-spec.md) and [#110 web-first runtime foundation](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/110) before implementing new Phase 2 features. Tickets #13–#21 and #109 have been groomed to target web-first development. All user-specific changes must be consistent with these newer directions; ticket references to “main process”, “IPC”, “desktop restart”, or “native export” should be interpreted as web host/API, browser refresh+host restart, and browser download for the web-first target.

### Two *separate* web modes — security boundary
1. **`demo:build` / `demo:lan` / `demo:dev`**: existing trusted-LAN **plain HTTP, fictional, in-memory demo**, resets on refresh. **NEVER** accepts or displays real clients/research records or accesses SQLite. #102 adds a Driver.js tour (`src/renderer/src/guidance/`, demo-only dynamic import; see `docs/architecture/guidance-service.md`) and an *opt-in* (`npm run demo:lan:feedback`, `scripts/demo-feedback.mjs`) server-side private GitHub Project draft feedback bridge; no GitHub tokens in browser, no fallback to PUBLIC repo issues.
2. **Persistent local web app, added by #110**: use a compact Node host plus typed same-origin HTTP API, shared validation and SQLite. Starts **loopback-only** (127.0.0.1) by default, with Host/Origin/CSRF/session safeguards and transactional backups. Phase 2.5 adds an explicit opt-in LAN listener for **fictional test profiles only** (see above); no real records over unencrypted LAN. New feature pages and tests use **this** app as the primary working product.

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

## #110 web-first runtime (merged)
- `npm run web:dev` (127.0.0.1:5175, HMR + API, `.web-dev-data/`), `npm run web:build` (`dist-web/`), `npm run web:local` (127.0.0.1:4180, real data in its own profile folder).
- Runtime `mode: 'live'` with `src/renderer/src/web/liveApi.ts`; the host is in `src/server/`. Contracts are shared via `src/main/contracts.ts`, services via `src/main/data-services.ts`.
- Security: loopback only, Host check, launch link → HttpOnly SameSite=Strict cookie, Origin + CSRF header on writes, size and media-type limits, CSP `connect-src 'self'`. See `docs/architecture/web-first-runtime.md`.
- New Phase 2 data calls: add the zod contract to `src/main/contracts.ts`, a name to `callable` in `src/server/live-host.ts`, a method to `AppDataApi`, `liveApi.ts` and `demoApi.ts`, and tests in `tests/unit/live-host.test.ts` / `tests/web/`.
