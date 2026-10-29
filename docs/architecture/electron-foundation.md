# Electron application foundation (#4)

**Status:** Implemented foundation. Packaging targets and the researcher's install OS remain **open choices** (see [Packaging](#packaging-approach)).
**Scope:** Secure shell, typed IPC boundary, placeholder navigation, scripts and tests. No client schema, storage, or integrations: those belong to #2, #5 and later tickets.

## Stack decisions

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Electron 45 | Current stable line at time of writing; Chromium sandbox and fuses support. |
| Build/dev | [electron-vite](https://electron-vite.org) 6 on Vite 8 | One config for main, preload and renderer; HMR in development. |
| UI | React 19 + TypeScript 6.0 (strict) | Per the Phase 1 technical baseline. TypeScript is pinned to `~6.0` because typescript-eslint does not support 6.1+. |
| Routing | `react-router` 7, `HashRouter` | Every screen stays on the single `app://renderer/index.html` document; no server-side fallback needed. |
| IPC validation | `zod` 4 (main process only) | Runtime validation of renderer input and of handler results. |
| Package manager | npm (lockfile committed) | Ships with Node; no extra tooling for contributors. |
| Unit/component tests | Vitest 4 + Testing Library (jsdom) | Vite-native; Vitest 5 was skipped because its engine range excludes Node 25. |
| Launch/security smoke | Playwright `_electron` | Drives the real built app, main process and renderer. |
| Packaging | electron-builder 26 | Mature multi-OS installers and built-in Electron fuse flipping. |

Requires Node `>=22.12`. Developed and verified on Windows 11 with Node 25.

## Layout

```
src/
  shared/      Contract shared by every process: IPC channel names + API types, CSP builder. No runtime deps.
  main/        Electron main process: window, security hardening, app:// protocol, IPC handlers.
  preload/     Sandboxed bridge exposing window.tracingGuatemala.
  renderer/    React UI (untrusted web content).
tests/
  unit/        Security policy, CSP, path resolution, IPC validation.
  renderer/    Navigation and placeholder screens (jsdom).
  e2e/         Launch + security smoke test against the built app.
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the app with the Vite dev server and HMR. |
| `npm run build` | Build main, preload and renderer into `out/`. |
| `npm run preview` | Run the built app. |
| `npm run lint` | ESLint, including the renderer import boundary. |
| `npm run typecheck` | Type-check main/preload/shared, renderer, and e2e projects. |
| `npm test` | Unit and renderer tests (Vitest). |
| `npm run test:e2e` | Build the app and the browser demo, then run the Playwright Electron launch + security smoke tests and the browser-demo tests. |
| `npm run check` | All of the above, in order. |
| `npm run package:dir` | Build an unpacked app for the current OS in `release/` (no installer). |
| `npm run package` | Build the installer for the current OS (see open choices below). |
| `npm run smoke:packaged` | After `package:dir`: launch the packaged app twice against a temporary profile and check its database. |
| `npm run demo:build` | Build the browser-only LAN demo (fictional in-memory data) into `dist-demo/`. Not part of the desktop app. See [LAN preview](../demo/lan-preview.md). |
| `npm run demo:lan` | Serve `dist-demo/` over plain HTTP on one home-LAN address, port 4173. |
| `npm run demo:dev` | Browser demo with hot reload, on this computer only (`http://localhost:5174`). |

> If you run Electron from a VS Code terminal and the app exits immediately, check for `ELECTRON_RUN_AS_NODE=1` in the environment and unset it. The e2e test strips it automatically.

## Security model

The renderer is treated as untrusted web content. It reaches the main process only through `window.tracingGuatemala`, a fixed set of typed functions.

### Process isolation

`src/main/security.ts` sets, for every window:

- `contextIsolation: true`, `nodeIntegration: false` (also in workers and sub-frames), `sandbox: true`
- `webSecurity: true`, `allowRunningInsecureContent: false`, `webviewTag: false`, `navigateOnDragDrop: false`
- `spellcheck: false`. Chromium's spellchecker can download dictionaries on some platforms; revisit when notes (#9) need it.

### Loading and Content Security Policy

- Production loads the renderer from a privileged custom scheme, `app://renderer/`, served by `protocol.handle` (`src/main/app-protocol.ts`), **not** `file://`. Requests are confined to the built renderer directory; anything else returns 404.
- Every production response carries this CSP header (also injected as a `<meta>` tag at build time):
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
- Development uses the Vite dev server only when the app is unpackaged and the URL is loopback `http`. Its CSP adds `'unsafe-inline'` for scripts and styles (React Refresh and Vite style injection) and the HMR websocket. It never allows `'unsafe-eval'`.

### Network, navigation and permissions

- A session-level `webRequest` filter cancels every request except the renderer's own origin, `data:` images, devtools, and (development only) the HMR socket. This applies to the main process's session requests too, so no telemetry, CDN fonts or cloud calls can slip through.
- In-window navigation and redirects to other origins are blocked, `window.open` is denied, `<webview>` attachment is prevented.
- All permission requests and checks (camera, notifications, geolocation, …) are denied.
- The default application menu is replaced, removing Help links that open external websites. Reload and devtools appear only in development.
- Security logs name only the URL scheme, never full URLs, which may later contain client details.

### Typed, validated IPC

- `src/shared/ipc.ts` defines channel names, the `TracingGuatemalaApi` type and result types. It has no runtime dependencies, so the sandboxed preload stays self-contained.
- The preload exposes named functions only, never `ipcRenderer` or a generic `invoke(channel, …)`.
- `src/main/ipc.ts` wraps each handler with `createValidatedHandler`, which:
  1. rejects calls whose sender frame is not the trusted renderer origin;
  2. validates arguments against a `zod` tuple, rejecting extras without echoing their content;
  3. validates the handler's result against the contract before returning it.
- ESLint forbids renderer imports of `electron`, Node built-ins, SQLite packages and main/preload code.

**Adding a channel:** add the name and types in `src/shared/ipc.ts`, a contract in `contracts` and a registration in `registerIpcHandlers` (`src/main/ipc.ts`), and a function in the preload. Then extend `tests/unit/ipc.test.ts` and the API-surface assertion in the e2e test.

Channels: `app:get-info` (name, version, platform), used by the Settings screen, and the `clients:*` channels added in #5 (see [Client storage](./client-storage.md#ipc)). Unexpected handler failures reach the renderer only as a generic `internal-error` rejection.

## Security smoke test

`npm run test:e2e` builds the app and launches it as production would, then verifies:

1. It loads from `app://renderer`, and Home, Clients and Settings & Backup are reachable through navigation.
2. The effective web preferences match the list above.
3. The renderer has no `require`, `process`, `module`, `Buffer`, `ipcRenderer` or `electron` globals, and `window.tracingGuatemala` exposes only `getAppInfo`.
4. The served HTML has the restrictive CSP header.
5. String-eval timers and injected inline scripts are blocked and raise `script-src` violations.
6. The renderer cannot fetch `https:`, `file:` or paths outside the renderer directory.
7. A main-process `session.fetch` to the internet fails with `ERR_BLOCKED_BY_CLIENT`.
8. `window.open`, external navigation and permission prompts are denied.

The packaged-build checks (fuses, launch) are manual for now; see below.

## Packaging approach

- `electron-builder.yml` packages `out/` into an asar archive and flips these Electron fuses: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on, `GrantFileProtocolExtraPrivileges` off, `EnableCookieEncryption` on.
- No auto-updates and no release publishing (`publish: null`).
- `npmRebuild: false` because there are no native modules. SQLite uses Node's built-in `node:sqlite` (#5), so nothing is unpacked from the asar.
- Manual check after `npm run package:dir`: `npx @electron/fuses read --app "release/win-unpacked/Tracing Guatemala.exe"` lists the fuses above, and the packaged app launches showing the Home screen. `npm run smoke:packaged` then checks that the packaged app creates, migrates and reopens its database.

### Open choices (not decided by #4)

These must be settled before claiming installation acceptance in #12:

- **Target OS for the first installed pilot.** The researcher has not yet said (spec approval checklist). Placeholder targets are configured for all three: Windows `nsis` (per-user, not one-click), macOS `dmg`, Linux `AppImage`. Only Windows unpacked builds have been exercised.
- **Code signing and notarization.** Not configured; unsigned installers will trigger OS warnings.
- **App identity.** `appId` is the placeholder `com.tracingguatemala.desktop`; no icon is set yet.
- **Installer behavior:** per-user vs per-machine install. The database lives in the per-user data directory (#5).

## Out of scope here

Client fields, storage, migrations, backup and any integration (Fiverr, FamilySearch, OneNote, AI). The Clients and Settings & Backup screens are placeholders that make no assumptions about the client model.
