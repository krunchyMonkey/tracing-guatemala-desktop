# LAN browser preview (demo)

A browser-only copy of the Tracing Guatemala screens, for showing the current client workflows on a phone, tablet or another computer on the **same trusted home network** without installing the desktop app (#100).

- **Fictional data only.** It starts with eight made-up clients and their notes. Every screen shows a *Demo Mode — Fictional Data Only* banner.
- **Nothing is saved.** Changes live in that browser tab's memory. Refreshing the page, or opening it again, goes back to the sample clients.
- **No backups.** Settings explains that backup and restore exist only in the desktop app.
- **It is not the real app.** It has no Electron, no SQLite database and no server API. It can't read the desktop app's data, files or backups, and the desktop app's data is never changed by it. The page's Content Security Policy blocks all network requests (`connect-src 'none'`).

## Start it

Requires Node.js 22.12 or newer, on the computer that will serve the demo.

```sh
npm ci              # first time, or after pulling changes
npm run demo:build  # builds dist-demo/
npm run demo:lan    # serves it over HTTP on port 4173
```

`demo:lan` uses this computer's home-network address and prints the link to open, for example:

```
Open on a phone, tablet or computer on the same home network:
  http://192.168.1.24:4173/#/clients
```

**Stop it** with <kbd>Ctrl</kbd>+<kbd>C</kbd> in that terminal. Closing the terminal also stops it.

### Choosing the address or port

`demo:lan` skips the virtual adapters that Hyper-V, WSL, Docker, VirtualBox and VMware add, and says so. If several real adapters remain (for example Wi-Fi and Ethernet, or a VPN), it lists them and asks you to choose:

```sh
npm run demo:lan -- --host 192.168.1.24
npm run demo:lan -- --host 192.168.1.24 --port 4180
```

`DEMO_HOST` and `DEMO_PORT` environment variables work too. For this computer only, use `--host 127.0.0.1`.

The server only listens on one private address (10.x.x.x, 172.16–31.x.x or 192.168.x.x) or loopback. It refuses `0.0.0.0` (every adapter) and public addresses. Vite's host check and its localhost-only CORS default stay on.

### Finding the computer's LAN address yourself

- **Windows:** run `ipconfig` and look for **IPv4 Address** under your Wi-Fi or Ethernet adapter.
- **macOS:** System Settings → Wi-Fi → Details → **IP address**, or `ipconfig getifaddr en0`.
- **Linux:** `hostname -I` or `ip -4 addr`.

## Guided tour

Every screen has a **Take a tour** button beside the Demo Mode banner (**Restart tour** once you have started or finished it). The tour never starts by itself, and it never creates, edits, saves, archives, submits or exports anything.

1. Welcome on the Research Studio home.
2. Clients: search and filters.
3. Add client (explained, not opened).
4. A fictional client profile (Lucía Fernández).
5. Notes and contact history (explained).
6. Archive and restore (explained).
7. That client's research case.

Use **Next** and **Back** (or the arrow keys), **Finish**, or **Escape** / the close button to leave at any time. Focus returns to the tour button. Reduced-motion settings turn the animation off. Completion is remembered only in that browser tab. If you use the browser's own Back button during the tour, the tour ends.

The tour's code and styles are bundled with the demo (no outside requests) and the page's Content Security Policy is unchanged. How it is built: [docs/architecture/guidance-service.md](../architecture/guidance-service.md).

## Researcher feedback (optional, off by default)

Every screen has a **Send feedback** button next to **Take a tour**. It opens a short form: kind (bug, confusing, improvement, other), a title (up to 120 characters), comments (4000) and optional steps to reproduce (2000). The form says that feedback goes to a private project, asks for no real client names or genealogy records, and reminds that the demo uses plain HTTP on the home network. Along with the text it sends only the screen name (Home, Directory, New Client, Client Profile, Case or Settings), the tour step id if a tour is running, and the app version. Never URLs, ids, names, emails, notes or other values from the page.

**Default (`npm run demo:lan`):** sending does not exist. The form offers **Copy feedback**, which puts the text in a box and on the clipboard so it can be pasted into a message. The page makes no network request, there are no feedback routes, and the Content Security Policy is unchanged (`connect-src 'none'`).

**Opt-in (`npm run demo:lan:feedback`):** the host adds two same-origin routes and, from this computer only, creates a **draft issue in a private GitHub Project** (GraphQL `addProjectV2DraftIssue`). It never creates repository issues and never falls back to the public repository: if the Project is missing, public, or cannot be verified at startup, sending stays off (the form shows Copy feedback) and the demo still runs.

### Owner setup

1. **Project.** Use a GitHub Project (v2) that is **private** (Project settings, Visibility, Private). Feedback is visible only to people with access to it.
2. **Project node id.** It looks like `PVT_...`. With the GitHub CLI: `gh project view <number> --owner <user-or-org> --format json --jq .id` (a user or organisation Project). Or query GraphQL: `user(login: "<you>") { projectV2(number: <n>) { id public } }`. Keep the id out of the repository.
3. **Token.** A fine-grained personal access token for the Project owner with the minimum permission: **Projects: Read and write** (for an organisation Project, the organisation's *Projects* permission; for a classic token, the `project` scope). No repository access is needed. Set an expiry. Store it in your password manager or shell profile, never in the repository, a committed file, or the browser.
4. **Verify it is private.** The host checks `ProjectV2.public === false` at startup and prints *private GitHub Project verified* (sending on) or *not private / could not verify* (sending off). To check by hand: `gh api graphql -f query='query { node(id: "<PVT_id>") { ... on ProjectV2 { public } } }'` must print `"public": false`.
5. **Start it** with the settings in the environment (PowerShell shown):

```powershell
$env:TG_FEEDBACK_GITHUB_TOKEN = "<token>"
$env:TG_FEEDBACK_PROJECT_ID   = "<PVT_...>"
npm run demo:build
npm run demo:lan:feedback
```

   The terminal prints a **one-time access code** (for example `K7QM-3XRT`) that changes every time the server starts. Give it to the researcher separately (for instance by message); the form asks for it before **Submit feedback**. It is never in the page, the URL or any file. Plain HTTP is not encrypted, so the code keeps casual visitors out; it is not the same as HTTPS authentication.

`TG_FEEDBACK_GITHUB_API` exists only so tests can point at a local fake (https only, or `http://127.0.0.1`); leave it unset.

### What the host enforces

- Same-origin only: the `Origin` and `Host` headers must equal the server's own address; `Content-Type: application/json` only; 16 KB body cap; strict schema (unknown fields are rejected); the access code in an `X-Feedback-Code` header, compared in constant time.
- At most 5 attempts a minute and 30 an hour for the whole process; a per-form idempotency key so a double click or retry creates one item; a 10 second upstream timeout.
- Responses carry only `{ok, itemUrl?}`. The token, the code and message text are never logged or echoed. No CORS headers. Still bound to one private (or loopback) address, never `0.0.0.0`.
- **Content Security Policy:** only `connect-src` changes, from `'none'` to `'self'`, in both the response header and the page's meta tag (the host rewrites the built `index.html` as it serves it, and adds a `tg-feedback` marker so the page knows it may ask `/__feedback/status`). No other directive changes. The default server and the built `dist-demo/` keep `'none'`.
- On success the researcher sees *Feedback added to private project* and a link to the Project (only people with access can open it). It is a Project draft item, not a numbered repository issue: no labels, milestone or `Closes #` workflow.

### Live smoke test (not yet performed)

These steps need the owner's private Project and token, so they have **not** been run. Automated tests use a fake GitHub endpoint only.

1. Set the two environment variables above, run `npm run demo:lan:feedback`, confirm the terminal says *private GitHub Project verified*.
2. Open the demo link, **Send feedback**, write a fictional test comment, enter the access code, **Submit feedback**.
3. Confirm the confirmation message, then that a draft item with the right title and screen appears in the private Project, and that nothing was created in the public repository's Issues.
4. Repeat with a wrong code (refused), then stop the server and start it with a public Project's id (sending must stay off).

## Windows firewall

The first time `demo:lan` runs, Windows may ask whether Node.js may communicate on networks.

1. Make sure your home Wi-Fi is set to **Private**: Settings → Network & internet → Wi-Fi → (your network) → Network profile type → **Private network**.
2. In the prompt, allow **Private networks** only. Leave **Public networks** unchecked.

If you dismissed the prompt or want a narrower rule, open PowerShell **as administrator** and allow only the demo port, only on Private networks, only from your local subnet:

```powershell
New-NetFirewallRule -DisplayName "Tracing Guatemala LAN demo" -Direction Inbound -Protocol TCP -LocalPort 4173 -Profile Private -RemoteAddress LocalSubnet -Action Allow
```

Remove it when you no longer need the demo:

```powershell
Remove-NetFirewallRule -DisplayName "Tracing Guatemala LAN demo"
```

**Never** set up port forwarding on your router for this port, put it in a DMZ, or expose it to the internet in any other way. It is plain HTTP for a trusted home network, not a website.

## Second-device check

Run this once on the real home network after `npm run demo:lan` is running. (The automated tests open the demo at this computer's own LAN address; they can't test a second physical device.)

1. On a phone or tablet on the **same Wi-Fi**, open the printed link (`http://<LAN-IP>:4173/#/clients`).
2. The *Demo Mode — Fictional Data Only* banner is visible, and the Clients list shows **7 active · 1 archived**.
3. Search `lucia` → one client. Clear it, then tap **Referral** under Source → only María José Alvarado. Tap **All** under Status → the archived Rosa Chávez Ixcoy appears too.
4. Open **Lucía Fernández**, add a note, and see it at the top of the history.
5. **Add client** named `Daniel Ochoa` → the "This might be someone you already have" warning appears. Choose *Save as a new client anyway*.
6. **Archive** that new client → the profile becomes read-only. **Restore client** → editable again.
7. Open **Settings & Backup** → it says backup is only available in the desktop app, with no backup buttons.
8. Refresh the page → the list is back to **7 active · 1 archived** and the new client and note are gone.
9. Turn the phone sideways and back → no sideways scrolling, and the menu stays reachable.
10. Stop the server with <kbd>Ctrl</kbd>+<kbd>C</kbd> → the page no longer loads on the phone after a refresh.

If the phone can't connect: check that both devices are on the same Wi-Fi (not a guest network, which often isolates devices), that the Windows network profile is Private, and that the firewall allows port 4173.

## Sample data

| Client | What it shows |
| --- | --- |
| Lucía Fernández (Quetzaltenango line) | Fiverr client with notes and logged contacts |
| Daniel Ochoa | Try adding a client with this name to see the duplicate warning |
| María José Alvarado | Referral, prefers email |
| Sofía Tzul | Direct client with an "other" contact method |
| Grace Whitfield | Fiverr username only, no notes |
| Ethan Morales-Reyes | Recently updated |
| Tomás Recinos | Returning client: archived, then restored, with system entries |
| Rosa Chávez Ixcoy | Archived (read-only) profile |

All names, contact details and notes are invented. Email addresses use the reserved `example.com` / `example.org` domains.

## Limits

- Feedback sending, when enabled, goes from this computer to GitHub over HTTPS; the browser only ever talks to this server.
- Plain HTTP: anyone on the same network who knows the address can open the demo while it runs. Use it only on a home network you trust, and only with fictional data.
- One browser tab = one copy of the data. Two devices don't see each other's changes.
- No backup, restore, export or persistence of any kind.
- Tested in Chromium-based browsers (Edge) at 375px, 768px and 1280px widths. Safari and Firefox on phones haven't been checked yet.
- `npm run demo:dev` is for development only: hot reload, on `localhost` only, and without the production CSP.

## For developers

- Feedback bridge: `scripts/demo-feedback.mjs` (routes, validation, GitHub calls), wired in by `scripts/demo-server.mjs` only with `--feedback`; the form is `src/renderer/src/demo/FeedbackDialog.tsx` and the allowlisted payload builder `src/renderer/src/demo/feedback/payload.ts` (demo-only, so none of it is bundled into the Live web or desktop apps).
- Entry: `src/renderer/demo/index.html` → `src/renderer/src/demo/main.tsx`; build config `vite.demo.config.ts`; server `scripts/demo-lan.mjs` + `scripts/demo-server.mjs`.
- The shared UI reads data through `useAppRuntime()` (`src/renderer/src/runtime/AppRuntime.tsx`). The desktop runtime forwards to the preload bridge; the demo runtime uses `createDemoApi()` with the same shared validation, search and duplicate rules, and has no backup API. ESLint stops non-demo renderer code from importing `demo/` or reading `window.tracingGuatemala` directly, and a Playwright test checks that the desktop bundle contains no demo data.
- `crypto.randomUUID()` doesn't exist on non-secure origins such as `http://192.168.x.x`; the demo builds v4 UUIDs from `crypto.getRandomValues()` instead (never `Math.random()`).
- Tests: `tests/renderer/DemoMode.test.tsx`, `tests/renderer/GuidanceTour.test.tsx`, `tests/unit/guidance-isolation.test.ts`, `tests/demo/tour.spec.ts`, `tests/unit/demo-server.test.ts`, `tests/unit/demo-feedback.test.ts` (against a fake GitHub endpoint), `tests/renderer/Feedback.test.tsx`, `tests/demo/feedback.spec.ts`, and the `browser-demo` Playwright project (`tests/demo/`), which runs `demo:lan` against a private LAN address of the test machine when one exists. On Windows it uses the installed Edge; elsewhere run `npx playwright install chromium` once. Refresh screenshots with `npm run demo:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project browser-demo` (writes `docs/screenshots/issue-100/`).
