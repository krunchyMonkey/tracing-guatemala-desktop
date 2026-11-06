# Public demo artifact (#191)

The public demo is the same browser demo as the [LAN preview](lan-preview.md). It uses the shared React UI with fictional in-memory adapters (`src/renderer/src/demo/`), built by `vite.demo.config.ts` into `dist-demo/`. There is no second repository, no submodule and no checked-in build output.

This document is the contract that `dist-demo/` must meet before anything publishes it. Publishing is covered in [#192](../operations/public-demo-pages.md).

## Build it

```sh
npm ci
npm run demo:artifact   # demo:build, then write demo-manifest.json, then verify
```

The script prints the artifact digest, for example `Public demo artifact passed verification: 7743…46af`.

## What the artifact may contain

| Allowed | Everything else fails the gate |
| --- | --- |
| `index.html` | databases (`*.db`, `-wal`, `-shm`), backups, `.env`, keys |
| `assets/*.{js,css,png,svg,webp,woff2,ico}` | source maps, `server/`, `*.mjs`, any other folder |
| `demo-manifest.json` | more than 10 MB in total |

## Manifest: `demo-manifest.json`

```json
{
  "schema": "tg-demo-artifact/1",
  "name": "tracing-guatemala-public-demo",
  "version": "0.1.0+<short sha>",
  "sourceSha": "<full 40-char commit SHA>",
  "builtAt": "<commit time, ISO 8601>",
  "digest": "<sha256>",
  "files": { "<path>": "<sha256>" }
}
```

- `digest` is the SHA-256 of every `"<path>\t<sha256>\n"` line, sorted by path, excluding the manifest.
- `builtAt` is the **commit** time, not the wall-clock time, so the manifest is reproducible.
- **Reproducibility:** two `npm run demo:artifact` runs at the same commit with the same lockfile give the same digest. This was verified locally and in CI.

## The gate (`node scripts/demo-artifact.mjs verify [dir] [--digest <sha256>]`)

It fails the build if it finds any of the following:

1. **Files:** any file outside the allowlist above.
2. **Content:** any of these in any HTML, JS or CSS file:
   - a private IPv4 address or the private Live host name
   - a Live API path (`/api/v1`) or Live session cookie names
   - Node server modules, database drivers or connection strings
   - GitHub, Google, AWS or Slack credential formats, private keys or credential variable names
   - `process.env` lookups, local filesystem paths, or `sourceMappingURL`
3. **External hosts:** any `http(s)://` or `ws(s)://` host not on a short allowlist. The allowlist covers XML namespaces, library error-doc links and input placeholders (`www.w3.org`, `react.dev`, `reactrouter.com`, `prosemirror.net`, `example.org`, `github.com`, `localhost`, `127.0.0.1`). These strings are never fetched.
4. **`index.html`:**
   - no CSP meta, or one other than `default-src 'none'`, `script-src 'self'` and `connect-src 'none'`
   - a `tg-live-url` meta, which would link to a Live host
   - a `tg-feedback` meta, which would turn on the private feedback relay
   - a script or style loaded from outside `./assets/`
5. **Manifest:** files that don't match the manifest, a `sourceSha` that isn't a full SHA, or a digest other than the promoted one (`--digest`).

String checks can't prove a bundle is safe. They are one of three layers:

- **CSP** `connect-src 'none'`: the browser refuses every `fetch`, XHR, WebSocket and beacon.
- **Browser negative tests**, `tests/demo/public-artifact.spec.ts`. They load `dist-demo/` at its real GitHub Pages origin and base path (`https://krunchymonkey.github.io/tracing-guatemala-desktop/`), served from disk by Playwright request routing. Every other request is aborted and fails the test. The tests prove that:
  - a multi-step fictional workflow works: browsing clients, creating a case and adding a journal entry
  - nothing is written to `localStorage`, `sessionStorage`, IndexedDB or cookies
  - a refresh resets the data
  - `/api/v1`, `/__feedback`, the private Live host, loopback Live, WebSocket and beacons are all blocked
  - there is no link to Live, and feedback is copy-only
  - phone and desktop layouts have no sideways scroll
  - a self-check proves the router does catch an outside request when CSP is bypassed
- **Malicious fixtures**, `tests/unit/demo-artifact.test.ts`. They inject fake secrets, a private API URL, a LAN address, a Node or SQLite bundle, database, backup, env and source-map files, a relaxed CSP, the Live and feedback metas, an external script and a tampered manifest. Each one must fail the gate.

## Feedback

The public build never has the `tg-feedback` meta, so the Feedback dialog is **copy-only** and makes no request. CSP would block one anyway. The `demo:lan:feedback` relay and its GitHub token exist only on a LAN host and can't run on a static host.

## Handoff to publishing

CI runs `npm run demo:artifact` on every PR and on `main`. The Pages workflow (#192) builds the artifact again from the promoted commit. It runs the same gate with `--digest` when a digest is given, and uploads only `dist-demo/` with its manifest and digest. To restore an earlier artifact, re-run that workflow at the earlier commit. The same commit gives the same digest.
