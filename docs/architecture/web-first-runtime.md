# Web-first runtime: Live mode on this computer (#110)

**Status:** implemented in #110; Demo/Live switching added in #114. Owner direction (2026-10-29): the React web app is the primary client; Electron is kept working but paused. This document describes the runtimes, the local web host's security model, and what is deliberately **not** done yet.

## Three runtimes, one UI

The shared React UI (`src/renderer/src`) gets all data through `useAppRuntime()` (`runtime/AppRuntime.tsx`). Screens never know which transport is behind it.

| `mode` | Entry | Data | Backups | Reachable from |
| --- | --- | --- | --- | --- |
| `live` | `src/renderer/src/web/main.tsx`, `npm run web:*` | SQLite through the local web host (`src/server`) | Download + upload | **This computer only** (`127.0.0.1`) |
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
| `server.ts` | Opens the data folder (lock + `AppData`) and listens on **`127.0.0.1` only**. There is no host option. |
| `demo-mirror.ts` | Static-only listener for the fictional demo on `127.0.0.1:<port + 1>` (#114). |
| `live-host.ts` | Request handler: launch link, `/api/v1/*`, static client files. |
| `access.ts` | Launch token, sessions, CSRF tokens, Host/Origin checks. |
| `backup.ts` | Backups in `<data>/backups`, downloads, upload-and-check, restore. |
| `data-dir.ts` | Default profile folder, desktop-profile refusal, single-host lock. |
| `main.ts` | `web:local` command line. |

### API (v1)

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /launch?token=…` | Launch token | Sets the session cookie, then `303` to `/` so the token leaves the address bar |
| `GET /api/v1/session` | Cookie (optional) | `{ authenticated, csrfToken?, demoUrl }`; `demoUrl` is the demo mirror's address or `null` (not secret). Unreadable cross-origin (no CORS). |
| `POST /api/v1/call/<name>` | Cookie + Origin + CSRF | Body `{ "args": [...] }`, validated by the call's contract. Returns `{ "result": … }`. |
| `POST /api/v1/backup/upload` | Cookie + Origin + CSRF | `application/octet-stream`, ≤ 512 MB. Checked before anything changes; returns a one-time restore token. |
| `GET /api/v1/backup/download/<file>` | Cookie, not cross-site | Only file names this host generated |

Callable names are `getAppInfo`, `listClients`, `getClient`, `createClient`, `updateClient`, `archiveClient`, `restoreClient`, `findDuplicateClients`, `listNotes`, `createNote`, `updateNote`, `createBackup` and `restoreBackup`. Later Phase 2 features (cases, journal, tasks, hours) add contracts and names here.

Errors are `{ "error": "<code>" }` with codes such as `bad-host` (421), `not-signed-in` (401), `not-same-origin`/`bad-csrf-token` (403), `unsupported-media-type` (415), `too-large` (413), `invalid-arguments` (400), `not-found` (404) and `internal-error` (500). They never echo submitted or stored values. Logs hold method, route template and status only. They never hold bodies, ids, names, paths or tokens; database errors are logged by error name only.

## Threat model and protections

**Assets:** real client records, notes and backups of the researcher, on her own computer.

| Threat | Protection | Test |
| --- | --- | --- |
| Another device on the LAN/Wi-Fi | Listens on `127.0.0.1` only, with no option to change it | `live-host.test.ts`: connecting via this computer's LAN address fails |
| A malicious website in the same browser (CSRF) | Writes need `Origin` = the host's own origin, `Sec-Fetch-Site` same-origin when sent, `application/json`/`octet-stream` (forces a CORS preflight, which is refused), and the per-session CSRF header. The cookie is `SameSite=Strict`. | Unit tests; E2E "refuses writes from another site" |
| DNS rebinding | Every route requires `Host` = `127.0.0.1:<port>` (421 otherwise; `localhost` is refused because it's the demo mirror's site, #114) | Unit test on every route |
| Other pages on `127.0.0.1` (e.g. the demo on loopback) | Cookies ignore ports, so another loopback port counts as same-site. Origin equality and the CSRF token still block it, and the cookie name includes the port. | Unit test with `Origin: http://127.0.0.1:4173` |
| Another OS user on the same computer | Data is useless without a session, and sessions start only from the launch link printed in the host's own terminal | Unit tests for wrong tokens and forged cookies |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | Header test |
| Script injection | CSP `script-src 'self'`, no inline scripts, `connect-src 'self'`; React escaping | Header test |
| Oversized or malformed requests | JSON ≤ 64 KB, uploads ≤ 512 MB (rejected by `Content-Length` before reading), strict schemas, timeouts | Unit tests |
| Path traversal | Static files and downloads are confined to their folder; downloads only allow generated names | Unit tests |
| Two hosts on one database (or a restore under a running host) | `web-host.lock` with PID; stale locks replaced; in-process double open refused | Unit test |
| Silent desktop data migration | Separate profile folder; refuses the desktop profile and Chromium-style folders | Unit test |

**Known limitations (document before real client use, #117):**

- **Loopback is not OS-user isolation.** Any program running as the same OS user can read the terminal output (launch link), the browser history (its `/launch?token=…` entry works until the host restarts), the data folder and backups. That is the same exposure as the desktop app.
- Plain HTTP on loopback: traffic never leaves the computer, so TLS adds nothing here. Remote access would need it.
- Sessions live in memory. Restarting the host signs every browser out (the page says so; nothing is lost). The launch link works for as long as the host runs, and opening it again starts another session (at most 20 are kept).
- Backups (`<data>/backups/*.tgbackup`) and downloads are **not encrypted**, the same as the desktop backup. Pre-migration and pre-restore safety copies stay in `<data>/data/`.
- No retention policy yet for the backups folder (#117).
- `node:sqlite` is still marked experimental in Node; `web:local` hides that warning.

**Deferred on purpose:** any access from another device (phone, tablet). That needs authentication beyond a link, HTTPS, hardened sessions and a separate privacy review, and it is not part of Phase 2. `demo:lan` stays fictional-only and has no API.

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
npm run web:local   # Live on http://127.0.0.1:4180, demo on http://localhost:4181/ (--port <n>, --data-dir <folder>, --no-demo); Ctrl+C stops
```

On a clean machine (Node ≥ 22.12): `npm ci`, then `npm run web:build`, then `npm run web:local`, then open the printed link **on the same computer**. One-click start and stop, backup reminders and a readiness checklist belong to #117.
## Tests

- `tests/unit/live-host.test.ts`: real HTTP against the host. Covers the launch link and cookies, Host spoofing, cross-origin and unauthenticated writes, CSRF, media types, sizes, strict arguments, no echo or logging of values, CSP and headers, path traversal, persistence across restart, cross-client note isolation, backup create/download/upload/restore, rejection of junk files, LAN unreachability, data-folder guards and the lock.
- `tests/renderer/LiveWeb.test.tsx`: the browser adapter (CSRF header, session loss, download, upload, cancel) and the sign-in screen.
- `tests/unit/demo-mirror.test.ts`, `tests/renderer/ModeSwitch.test.tsx`, `tests/web/live-mode-switch.spec.ts` and the LAN case in `tests/demo/lan-demo.spec.ts` (#114): the demo mirror, every switch rule, and the two-origin journey in a real browser.
- `tests/web/live-web.spec.ts` (Playwright `web-live`): the built host in Edge/Chromium. Covers sign-in guidance, CRUD + notes persisting across reload and host restart, backup download, a hostile page in the same browser, demo-bundle isolation, and 375/768/1280px layouts.
