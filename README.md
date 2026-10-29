# Tracing Guatemala Desktop

A local-first desktop workspace for Tracing Guatemala genealogy research. Phase 1 focuses on client management; see the [Phase 1 specification](docs/phase-1-client-management-spec.md).

> This repository is public. Never commit real client names, contact details, research records, or completed questionnaires. Use fictional data in tests and screenshots.

## Getting started

Requires Node.js 22.12 or newer.

```sh
npm install
npm run dev
```

## Common commands

```sh
npm run check        # lint, typecheck, unit tests, then build + security smoke test
npm run package:dir  # unpacked app for the current OS, in release/
npm run smoke:packaged  # after package:dir: packaged app creates and reopens its database
```

## Browser demo on your home network

A browser-only preview of the same screens with fictional, in-memory data (nothing is saved; a refresh resets it). For a trusted home network only:

```sh
npm run demo:build
npm run demo:lan     # prints http://<LAN-IP>:4173/#/clients; Ctrl+C stops it
```

See [docs/demo/lan-preview.md](docs/demo/lan-preview.md) for address selection, Windows firewall settings, limits and the second-device check.

See [docs/privacy-and-backup.md](docs/privacy-and-backup.md) for where data is stored and how backups work.

See [docs/architecture/electron-foundation.md](docs/architecture/electron-foundation.md) for all scripts, the security model, IPC conventions and packaging decisions.
