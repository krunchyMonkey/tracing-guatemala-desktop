# Web-first runtime: Live mode on this computer (#110)

**Status:** implemented in #110; Demo/Live switching added in #114. Owner direction (2026-10-29): the React web app is the primary client; Electron is kept working but paused. This document describes the runtimes, the local web host's security model, and what is deliberately **not** done yet.

## Three runtimes, one UI

The shared React UI (`src/renderer/src`) gets all data through `useAppRuntime()` (`runtime/AppRuntime.tsx`). Screens never know which transport is behind it.

| `mode` | Entry | Data | Backups | Reachable from |
| --- | --- | --- | --- | --- |
| `live` | `src/renderer/src/web/main.tsx`, `npm run web:*` | SQLite through the local web host (`src/server`) | Download + upload | **This computer only** (`127.0.0.1`) by default; with the opt-in `--lan-host`, the static page alone is also served on one home-network address (#135) |
| `demo` | `src/renderer/src/demo/main.tsx`, `npm run demo:*` | In-memory, fictional; resets on refresh | None | Trusted home LAN, plain HTTP |
| `desktop` | `src/renderer/src/main.tsx`, Electron | SQLite through IPC (preload bridge) | Native dialogs | The desktop window (paused) |

ESLint keeps the bundles apart: shared UI code can't import `demo/` or `web/`; demo code can't import `web/`; Live code can't import `demo/`. The demo build has `connect-src 'none'` and contains no API client. An E2E test checks the built demo for `/api/v1`.

## Shared business rules

The web host reuses, unchanged, what the desktop app already trusts:

- `src/main/database/*`: the connection, forward-only migrations, repositories and the verified `AppData` backup/restore (#5, #11).
- `src/main/contracts.ts`: the zod argument/result schemas. They moved out of `ipc.ts` so both transports validate the same shapes. Strict objects reject system fields such as `id`, `status` and timestamps.
- `src/main/data-services.ts`: the client and note services. They look up the repositories on every call, because a restore replaces the connection.
- `src/shared/client-model.ts`: normalization, validation, search and duplicates.

No business rule is duplicated in `src/server`.

## The local web host (`src/server`)

A plain `node:http` server with no framework:

| Module | Purpose |
| --- | --- |
| `server.ts` | Opens the data folder (lock + `AppData`) and listens on **`127.0.0.1`**, plus, only with an explicit `lanHost`, one validated private address that serves the static client and no data (#135). Failure to set up the second listener closes everything. |
| `demo-mirror.ts` | Static-only listener for the fictional demo on `127.0.0.1:<port + 1>` (#114). |
| `lan.ts` | Strict IPv4 parsing and `validateLanHost` for the opt-in home-network address (#135). |
| `live-host.ts` | Request handlers: `handle` (loopback: launch link, `/api/v1/*`, static client) and `handleLan` (static client only; data refused), each with its own Host/origin policy. |
| `access.ts` | Launch token, sessions, CSRF tokens, Host allowlists and Origin checks against the listener's own origin. |
| `backup.ts` | Backups in `<data>/backups`, downloads, upload-and-check, restore. |
| `data-dir.ts` | Default profile folder, desktop-profile refusal, single-host lock. |
| `open-browser.ts` | `--open`: validates the launch link and builds the OS "open" command (no shell). |
| `main.ts` | `web:local` command line (`--port`, `--data-dir`, `--open`, `--lan-host`). |

### API (v1)

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /launch?token=…` | Launch token | Sets the session cookie, then `303` to `/` so the token leaves the address bar |
| `GET /api/v1/session` | Cookie (optional) | `{ authenticated, csrfToken?, demoUrl }`; `demoUrl` is the demo mirror's address or `null` (not secret). Unreadable cross-origin (no CORS). |
| `POST /api/v1/call/<name>` | Cookie + Origin + CSRF | Body `{ "args": [...] }`, validated by the call's contract. Returns `{ "result": … }`. |
| `POST /api/v1/backup/upload` | Cookie + Origin + CSRF | `application/octet-stream`, ≤ 512 MB. Checked before anything changes; returns a one-time restore token. |
| `GET /api/v1/backup/download/<file>` | Cookie, not cross-site | Only file names this host generated |

Callable names are `getAppInfo`, `listClients`, `getClient`, `createClient`, `updateClient`, `archiveClient`, `restoreClient`, `findDuplicateClients`, `listNotes`, `createNote`, `updateNote`, `createBackup`, `restoreBackup` and `getBackupStatus` (#117: `{ lastBackupAt, fileName, backupCount }`, names and dates only), plus the research case calls below. Later Phase 2 features (journal, tasks, hours) add contracts and names here.

Errors are `{ "error": "<code>" }` with codes such as `bad-host` (421), `not-signed-in` (401), `not-same-origin`/`bad-csrf-token` (403), `unsupported-media-type` (415), `too-large` (413), `invalid-arguments` (400), `not-found` (404) and `internal-error` (500). They never echo submitted or stored values. Logs hold method, route template and status only. They never hold bodies, ids, names, paths or tokens; database errors are logged by error name only.

## Threat model and protections

**Assets:** real client records, notes and backups of the researcher, on her own computer.

| Threat | Protection | Test |
| --- | --- | --- |
| Another device on the LAN/Wi-Fi (default) | Listens on `127.0.0.1` only unless `--lan-host` is given | `live-host.test.ts`: connecting via this computer's LAN address fails; `live-lan.test.ts`: default start has no LAN origin |
| Data read or changed over the opted-in home network (#135) | The LAN listener serves the static client only. Every `/api` path except the signed-out `session` probe answers `401 not-signed-in` before any body or session is read; `/launch` is `404` and never reads the token; no cookie is set or read | `live-lan.test.ts`: a valid loopback session, CSRF token and LAN Origin still get `401` on call, upload and download |
| A wildcard, public, link-local or wrong-adapter bind (#135) | `validateLanHost`: strict dotted quad, RFC 1918 only, must be a non-internal IPv4 address of exactly one adapter; no auto-pick, never `0.0.0.0` | `lan.test.ts` (every refusal); `live-lan.test.ts` fails closed on invalid or busy address |
| DNS rebinding or wrong-name access on the LAN listener (#135) | Host must equal `<address>:<port>`; `127.0.0.1`, `localhost`, hostnames and other ports get `421`; the loopback listener refuses the LAN Host | `live-lan.test.ts` |
| Eavesdropping or tampering on the home network (#135) | **Not mitigated**: plain HTTP. Only the public static client is served, no data. HTTPS is future work (#139) | Documented; the startup banner warns |
| A malicious website in the same browser (CSRF) | Writes need `Origin` = the host's own origin, `Sec-Fetch-Site` same-origin when sent, `application/json`/`octet-stream` (forces a CORS preflight, which is refused), and the per-session CSRF header. The cookie is `SameSite=Strict`. | Unit tests; E2E "refuses writes from another site" |
| DNS rebinding | Every route on the loopback listener requires `Host` = `127.0.0.1:<port>` (421 otherwise; `localhost` is refused because it's the demo mirror's site, #114) | Unit test on every route |
| Other pages on `127.0.0.1` (e.g. the demo on loopback) | Cookies ignore ports, so another loopback port counts as same-site. Origin equality and the CSRF token still block it, and the cookie name includes the port. | Unit test with `Origin: http://127.0.0.1:4173` |
| Another OS user on the same computer | Data is useless without a session, and sessions start only from the launch link printed in the host's own terminal | Unit tests for wrong tokens and forged cookies |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | Header test |
| Script injection | CSP `script-src 'self'`, no inline scripts, `connect-src 'self'`; React escaping | Header test |
| Oversized or malformed requests | JSON ≤ 256 KB (a full research brief, #17), uploads ≤ 512 MB (rejected by `Content-Length` before reading), strict schemas, timeouts | Unit tests |
| Path traversal | Static files and downloads are confined to their folder; downloads only allow generated names | Unit tests |
| Two hosts on one database (or a restore under a running host) | `web-host.lock` with PID; stale locks replaced; in-process double open refused | Unit test |
| Silent desktop data migration | Separate profile folder; refuses the desktop profile and Chromium-style folders | Unit test |

**Known limitations (document before real client use, #117):**

- **Loopback is not OS-user isolation.** Any program running as the same OS user can read the terminal output (launch link), the browser history (its `/launch?token=…` entry works until the host restarts), the data folder and backups. That is the same exposure as the desktop app.
- Plain HTTP on loopback: traffic never leaves the computer, so TLS adds nothing here. Remote access would need it.
- Sessions live in memory. Restarting the host signs every browser out (the page says so; nothing is lost). The launch link works for as long as the host runs, and opening it again starts another session (at most 20 are kept).
- Backups (`<data>/backups/*.tgbackup`) and downloads are **not encrypted**, the same as the desktop backup. Pre-migration and pre-restore safety copies stay in `<data>/data/`.
- Nothing in the backups folder or the safety copies is deleted automatically; the retention habit is a proposal in [live-readiness](../operations/live-readiness.md). The data folder is `0700` on macOS/Linux; on Windows it relies on the per-user AppData permissions.
- `node:sqlite` is still marked experimental in Node; `web:local` hides that warning.

**Deferred on purpose:** real access to data from another device (phone, tablet). That needs device enrollment and sign-in (#136), hardened sessions, HTTPS (#139) and a separate privacy review. Until then the opt-in home-network listener (#135) serves the page only. `demo:lan` stays fictional-only and has no API.

## Opt-in home-network listener (#135)

Off by default. `npm run live -- --lan-host <address>` (or `web:local`) starts a second `http.Server` bound to exactly that address and the Live port, next to the unchanged loopback listener. It is a command-line flag only: no environment variable can switch it on.

- **Address rules** (`src/server/lan.ts`): a strict dotted quad (four decimal parts, no leading zeros, no spaces); RFC 1918 only (`10/8`, `172.16/12`, `192.168/16`); it must be assigned to a non-internal IPv4 interface of this computer, and to only one. Refused with a plain-English message: hostnames, IPv6, `0.0.0.0`, loopback, link-local `169.254/16`, CGNAT `100.64/10`, public addresses, addresses this computer lacks (the private addresses found are listed) and ambiguous duplicates. The address is never guessed.
- **No wildcard, no UPnP, no port forwarding.** After binding, the bound address must equal the requested one.
- **Fail closed:** the address is validated before anything is bound or opened. If the second listener cannot start (for example the port is busy on that address) the loopback listener, the database and the folder lock are all released and the command exits with an error.
- **Host allowlist:** built from the bound address and port: `<address>:<port>` only. `localhost`, `127.0.0.1`, hostnames and other ports get `421 bad-host`. The loopback listener in turn refuses the LAN Host. Origin checks compare against each listener's own configured origin, with the scheme as a parameter so HTTPS can follow.
- **Data API closed until device sign-in (#136):** the LAN listener serves the static client (same CSP and security headers). `GET /api/v1/session` answers `{ authenticated: false, demoUrl: null, remote: true }` without looking up sessions, and the signed-out page then says Live on the home network cannot open data yet. Every other `/api` path, any method, is `401 not-signed-in`. `/launch` is `404`. No `Set-Cookie`, no CORS headers. Log lines start with `lan ` and hold only method, route label and status.
- **Unencrypted:** traffic is plain HTTP. Anyone on the network can read or change it. The banner says so. Only use a trusted home network; never forward the port on a router.
- The private launch link, `--open` and sessions stay loopback-only.

## Demo and Live on the host (#114)

The researcher needs to look at the fictional demo and at her real data from the same computer without ever mixing them up. **Switching is navigation between two independently served origins, never a data-source flip inside one page.**

| | Live | Demo (mirror) |
| --- | --- | --- |
| Address | `http://127.0.0.1:<port>/` (4180) | `http://localhost:<port + 1>/` (4181) |
| Served by | `live-host.ts` | `demo-mirror.ts`, the unchanged `dist-demo/` bundle |
| Data | SQLite through the API | This page's memory; resets on refresh |
| Cookie | `tg_live_<port>`, HttpOnly, SameSite=Strict | Never set, never read |
| `connect-src` | `'self'` | `'none'` (the page cannot call anything) |

**Why `localhost` and `127.0.0.1`.** Browsers treat them as different *sites*, so cookies and storage are not shared between them (cookies already ignore ports, which is why Live's cookie name carries the port). Opening the demo as `localhost` and Live as `127.0.0.1` puts a site boundary between them as well as an origin boundary. The mirror is a second, static-only listener bound to `127.0.0.1`. It accepts only Host `localhost:<port>` or `127.0.0.1:<port>` (421 otherwise) and only GET/HEAD (405), and answers 404 for anything under `/api`. Files go through `resolveStaticPath`. Responses carry the production CSP, `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `no-store`. If `dist-demo/index.html` is missing or the port is busy, the mirror isn't started; Live still starts and reports `demoUrl: null`.

**The switch rules.** Each page decides its link from what it already knows: no shared state and no extra API call.

- *Live to demo:* the host reports `demoUrl` (`http://localhost:<port + 1>/?live=<port>`). The page accepts only `http:`, hostname `localhost`, an explicit port 1024-65535, path `/`, no credentials or fragment and no query other than `?live=<port>`, and rebuilds the link from those parts. Anything else means "Demo not available". The link opens in the same tab. The signed-out screen offers it too.
- *Demo to Live:* computed from `window.location` alone (`demo/modeLink.ts`). If the hostname is `localhost` or `127.0.0.1` and `live` is exactly one integer 1024-65535, the link is `http://127.0.0.1:<live>/`. A loopback page without a usable `live` says "Start Tracing Guatemala on this computer to use Live." Any other hostname says "Live mode opens only on the researcher's own computer." and has **no link at all**, even when `?live=` is present.
- The sidebar always shows the current mode and what persists ("Live · saved on this computer", "Demo · nothing is saved"); the demo banner stays. The unavailable cases are plain text: no anchor, no button.
- Back in Live nobody is asked for the launch link again: the cookie belongs to `127.0.0.1` and the demo never touched it. The page document is static; the session is read by the page's own same-origin request, which `SameSite=Strict` allows.

**On the home network.** `demo:lan` is unchanged: fictional-only, no API. A phone opening it at `http://192.168.x.x:4173/` is *not* on the host, so the demo offers no link to Live; a `127.0.0.1` link there would open the phone's own localhost. The mirror listens on loopback only and is not reachable from the LAN.

Threat-model rows added by #114:

| Threat | Protection | Test |
| --- | --- | --- |
| Cross-mode leakage (Live data or session reaching the demo, or demo data written into Live) | Separate origins and sites; the mirror ignores cookies and sets none; `connect-src 'none'` stops the demo page calling Live; demo data lives in page memory only; no in-page mode flip | `demo-mirror.test.ts`; E2E "switches Live → demo → Live" (cookies, blocked `fetch`, data on each side) |
| A link that opens the *viewer's own* localhost (LAN phone or tablet) | The demo makes a Live link only on a loopback hostname; a LAN hostname never links, whatever `?live=` says | `ModeSwitch.test.tsx` (every hostname/param); LAN demo E2E |
| Hostile or odd `demoUrl` or `?live=` (`javascript:`, other hosts, paths, extra params) | Strict parsing; the link is rebuilt from validated parts; invalid input means "unavailable" | `ModeSwitch.test.tsx` |
| Fallback when Live or the demo isn't there | No demo bundle or busy port: Live still starts, with no link. Host stopped: the browser shows its own "can't connect" page for both origins; nothing substitutes demo content for Live | `demo-mirror.test.ts`; E2E "never shows demo content when the host is stopped", `--no-demo`, busy port |
| DNS rebinding to the mirror | Host check on every request | `demo-mirror.test.ts` |
| Clickjacking or script injection on the demo origin | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `script-src 'self'`, `connect-src 'none'` | `demo-mirror.test.ts` |

Live answers **only** to `127.0.0.1`: opening it as `localhost:<port>` is refused (421), so Live's cookie can never be set on the demo mirror's site. The demo makes no requests, so it can't tell whether the host is running; "Back to Live" may lead to the browser's "can't connect" page.

```sh
npm run web:build                # also builds the demo (dist-demo/) that the mirror serves
npm run web:local                # Live :4180 + demo http://localhost:4181/
npm run web:local -- --no-demo   # Live only
npm run web:dev                  # no mirror (demoUrl is null); use npm run demo:dev separately
```

## Data folders

| Use | Default | Override |
| --- | --- | --- |
| `web:local` (real data) | Windows `%APPDATA%\Tracing Guatemala Web`; macOS `~/Library/Application Support/Tracing Guatemala Web`; Linux `~/.config/Tracing Guatemala Web` | `--data-dir <folder>` or `TG_WEB_DATA_DIR` |
| `web:dev` | `.web-dev-data/` in the repo (gitignored). **Fictional data only.** | `TG_WEB_DEV_DATA_DIR` |
| Desktop app (untouched) | `%APPDATA%\Tracing Guatemala` etc. | — |

The layout inside matches the desktop's (`data/tracing-guatemala.sqlite`, `data/pre-migration/`, `data/pre-restore/`), plus `backups/`, `uploads/` (temporary) and `web-host.lock`.

**Moving desktop data into Live:** this is always explicit. In the desktop app, choose **Settings & Backup → Create backup**. Then in the Live web app, choose **Restore from backup** and pick that file. The restore checks the file, keeps a safety copy of the current Live data, migrates the copy forward if needed, and leaves the desktop database untouched. The host never opens the desktop database.

## Commands

```sh
npm run web:dev     # React HMR + API on http://127.0.0.1:5175, prints a sign-in link; data in .web-dev-data/
npm run web:build   # demo → dist-demo, client → dist-web/client, host → dist-web/server/main.mjs
npm run web:local   # Live on http://127.0.0.1:4180, demo on http://localhost:4181/ (--port <n>, --data-dir <folder>, --open, --no-demo); Ctrl+C stops
npm run live        # build if missing, then web:local --open (scripts/live.mjs)
npm run smoke:live  # drill against the built host: restart, backup, restore, isolation
```

On a clean machine (Node ≥ 22.12): `npm ci`, then `npm run web:build`, then `npm run web:local`, then open the printed link **on the same computer**. `npm run live`, `Start Tracing Guatemala.cmd` and `start-tracing-guatemala.sh` build if needed, start the host and open the browser (#117; see [live-readiness](../operations/live-readiness.md) for stop, backups, recovery and the release checklist). The Demo/Live entry UX is #114: the sidebar shows the current mode and links to the other one at its own address.

## Tests

- `tests/unit/live-host.test.ts`: real HTTP against the host. Covers the launch link and cookies, Host spoofing, cross-origin and unauthenticated writes, CSRF, media types, sizes, strict arguments, no echo or logging of values, CSP and headers, path traversal, persistence across restart, cross-client note isolation, backup create/download/upload/restore, rejection of junk files, LAN unreachability, data-folder guards and the lock.
- `tests/unit/backup-status.test.ts`, `tests/unit/live-launch.test.ts` (#117): the backup status file and `getBackupStatus`, restoring a schema-v2 backup by upload, the `--open` link check and per-platform commands, and the `0700` folder mode.
- `tests/renderer/LiveWeb.test.tsx`: the browser adapter (CSRF header, session loss, download, upload, cancel) and the sign-in screen.
- `tests/unit/demo-mirror.test.ts`, `tests/renderer/ModeSwitch.test.tsx`, `tests/web/live-mode-switch.spec.ts` and the LAN case in `tests/demo/lan-demo.spec.ts` (#114): the demo mirror, every switch rule, and the two-origin journey in a real browser.
- `tests/web/live-web.spec.ts` (Playwright `web-live`): the built host in Edge/Chromium. Covers sign-in guidance, CRUD + notes persisting across reload and host restart, backup download, a hostile page in the same browser, demo-bundle isolation, and 375/768/1280px layouts.

## #15 status: research cases (storage and typed API)

Cases arrive as storage and API only; the screens belong to #16. The rules, states and schema are in `docs/case-data-model.md` (`case-model/v1`). Migration 3 adds `research_cases` and `case_events` (forward-only, nothing cascades or deletes). Case changes and their event row are written in one transaction.

| Call | Args | Result |
| --- | --- | --- |
| `listCases` | `[CaseQuery]` | `ResearchCase[]` |
| `getCase` | `[caseId]` | `ResearchCase \| null` |
| `listCaseEvents` | `[caseId]` | `CaseEvent[]`, newest first |
| `createCase` | `[clientId, CaseInput]` | `CaseMutationResult` |
| `updateCase` | `[caseId, CaseInput]` | `CaseMutationResult` |
| `setCaseState` | `[caseId, CaseState]` | `CaseMutationResult` |
| `archiveCase` / `unarchiveCase` | `[caseId]` | `CaseMutationResult` |

- The contracts live in `caseContracts` (`src/main/contracts.ts`) and have no Electron IPC channel: desktop stays frozen, so `AppRuntime.cases` is `null` there and in the demo until #16 adds the in-memory adapter. `CaseInput` is strict, so `id`, `clientId`, `state` and timestamps are rejected as `invalid-arguments`.
- Tests: `tests/unit/{case-model,cases,live-cases}.test.ts` (rules, transition matrix, real v2 to v3 migration, backup round trips, HTTP), the case block in `tests/renderer/LiveWeb.test.tsx`, and `tests/web/live-cases.spec.ts` (port 4192, built host, persistence across restart).

## Case summary export (#20)

"Export summary…" on a case page saves a Markdown summary of that one case. It is composed entirely in the browser and needs nothing new from the host.

- **No server involvement, no writes.** The page reads the selected case with its existing, case-scoped calls (`getCase`, `getClient`, `getCaseBrief`, `listJournalEntries`, `listCaseTasks`, `listCaseEvents`), composes the text with `src/shared/case-summary.ts` (pure, no DOM) and saves it with an ordinary browser download (`Blob` + a temporary `<a download>`, `src/renderer/src/cases/downloadText.ts`; the loader is `exportSummary.ts`). There is no export endpoint, the host writes no file, and SQLite is never changed by exporting. A blob download needs no `connect-src`, so the production CSP is unchanged; `tests/web/live-case-export.spec.ts` checks the real download and that only those read calls go over the wire.
- **Scope check.** `checkSummaryScope` requires the client id to match the case's client and every brief, journal entry, task and event to carry that case's id. `composeCaseSummary` throws, producing no output, when anything does not match. `tests/unit/live-case-export.test.ts` loads look-alike cases of two clients over real HTTP and asserts that none of the other cases' or clients' text appears.
- **Included:** the case title, the client's display name, state, archived flag, order reference, due date (with "(overdue)"), created/updated/generated times, the requested outcome, the research brief (hypotheses always prefixed "Hypothesis — not established:", known facts labelled "as reported — not verified"), next steps, the research journal and the case history. In the demo the file starts with "Fictional demo data — not a real client."
- **Excluded:** every client contact detail (email, Fiverr username, other contact, source detail), client notes and the contact log. The summary data type carries only the client's id and display name, so they cannot be added by mistake. Research hours are not included.
- **Safe text.** User text is kept as typed, but a leading Markdown marker on any line is backslash-escaped and `<` becomes `&lt;`, so it cannot create headings, lists, quotes or HTML. Due dates are written as the stored `YYYY-MM-DD`, never shifted by a time zone.
- **The file is not encrypted.** The dialog says so and asks the researcher to keep it private. The file name is `case-summary-<slug>-<YYYY-MM-DD>.md` (ASCII slug, at most 50 characters, no separators).
- **Where it goes is the browser's business.** The app cannot know whether the browser saved the file or where, so the copy says "Your browser will save it or ask where to save it" and never claims more. Archived cases can be exported (it is read-only).
