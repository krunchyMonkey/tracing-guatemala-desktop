# Tracing Guatemala Desktop

A local-first workspace for Tracing Guatemala genealogy research. Phase 1 built client management ([spec](docs/phase-1-client-management-spec.md)); Phase 2 adds research cases ([plan](docs/phase-2-case-management-spec.md)). Since #110 the **web app is the primary client**: a React UI over a small local web host on this computer. The Electron desktop app is kept working but paused.

> This repository is public. Never commit real client names, contact details, research records, or completed questionnaires. Use fictional data in tests and screenshots.

## Getting started

Requires Node.js 22.12 or newer.

```sh
npm install
npm run web:dev      # web app with hot reload + local API on http://127.0.0.1:5175 (open the printed sign-in link)
npm run dev          # Electron desktop app (paused for new features)
```

## Common commands

```sh
npm run check        # lint, typecheck, unit tests, then builds + Electron, demo and Live web E2E tests
npm run package:dir  # unpacked app for the current OS, in release/
npm run smoke:packaged  # after package:dir: packaged app creates and reopens its database
npm run smoke:live      # after web:build: Live launch, backup and restore drill with fictional data
```

## Live web app on this computer

Your real data, saved in SQLite, reachable **only from this computer** (127.0.0.1). It keeps its own data folder and never opens the desktop app's database:

```sh
npm run live         # builds if needed, starts the app and opens your browser; Ctrl+C stops it
npm run web:local    # same host without opening the browser; prints the private sign-in link
```

It also serves the fictional demo on this computer at `http://localhost:4181/` (Live port + 1; `--no-demo` turns it off). The sidebar always shows which mode you are in, with a link to the other one at a separate address, so demo changes never touch Live data and Live data never appears in the demo.

On Windows double-click `Start Tracing Guatemala.cmd`; on macOS or Linux run `./start-tracing-guatemala.sh`. `npm run smoke:live` rehearses backup and restore against the built app. Launching, stopping, backups, recovery and the real-use release checklist are in [docs/operations/live-readiness.md](docs/operations/live-readiness.md).

To bring desktop data across, make a backup in the desktop app and restore it in the web app's **Settings & Backup**. See [docs/architecture/web-first-runtime.md](docs/architecture/web-first-runtime.md) for data folders, the security model, the API and known limitations.

## Browser demo on your home network

A browser-only preview of the same screens with fictional, in-memory data (nothing is saved; a refresh resets it). For a trusted home network only:

```sh
npm run demo:build
npm run demo:lan     # prints http://<LAN-IP>:4173/#/clients; Ctrl+C stops it
```

Optional: `npm run demo:lan:feedback` also lets a researcher send feedback to a **private** GitHub Project (off unless you set `TG_FEEDBACK_GITHUB_TOKEN` and `TG_FEEDBACK_PROJECT_ID`; see the guide).

The demo has a **Take a tour** button (a short Driver.js walkthrough that never changes anything). See [docs/demo/lan-preview.md](docs/demo/lan-preview.md) for the tour, address selection, Windows firewall settings, limits and the second-device check.

See [docs/privacy-and-backup.md](docs/privacy-and-backup.md) for where data is stored and how backups work.

See [docs/architecture/electron-foundation.md](docs/architecture/electron-foundation.md) for all scripts, the security model, IPC conventions and packaging decisions.
