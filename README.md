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

See [docs/architecture/electron-foundation.md](docs/architecture/electron-foundation.md) for all scripts, the security model, IPC conventions and packaging decisions.
