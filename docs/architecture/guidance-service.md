# Guidance service (guided demo tour)

Added in #102. The browser demo has a replayable walkthrough. Guides, anchors and navigation belong to the app; the library that draws the popovers is replaceable.

## Pieces

| File (`src/renderer/src/`) | Role |
| --- | --- |
| `guidance/types.ts` | `Guide`, `GuideStep`, `GuidanceState`, `GuidanceService` (`start(guideId)`, `stop()`, `isActive()`, `getState()`, `subscribe()`). No library types. |
| `guidance/anchors.ts` | The stable `data-guide-id` anchor ids and `guideAnchor(id)`, which screens spread on the element a step points at. |
| `guidance/GuidanceContext.tsx` | React provider and hooks. No provider (Live web, desktop) means no service and no tour button. |
| `guidance/tourEngine.ts` | Provider-neutral engine: progress, route changes, skipping missing anchors, interruption, in-memory completion. Draws nothing; it calls a `StepRenderer`. |
| `guidance/waitForAnchor.ts` | Bounded wait for an anchor (MutationObserver plus a timeout, no fixed sleeps). |
| `guidance/fakeGuidance.ts` | `noopGuidanceService` and a recording fake for tests. |
| `guidance/driverJsProvider.ts` | The **only** file that imports `driver.js` and its CSS. A `StepRenderer` over Driver.js plus `createDriverJsGuidanceService()`. |
| `demo/demoTour.ts` | The demo's guide catalog (fixed fictional ids from `sampleData.ts`). Lives under `demo/` because it uses demo data. |
| `components/DemoToolbar.tsx` | Take a tour / Restart tour button beside the Demo Mode banner. |

## Guide schema

```ts
Guide     { guideId, version, steps: GuideStep[] }
GuideStep { stepId, route, anchorId, title, body }   // title and body are plain text
```

`route` is a hash route (`/clients`). `anchorId` is one of `guideAnchors`. The engine navigates to `route` by setting the hash, waits for the anchor, then asks the renderer to show the step. Bump `version` when steps change meaningfully. The tour never clicks, types, saves, archives, submits or exports: interaction with highlighted elements is disabled and every step only explains.

## Provider boundary

- Only `driverJsProvider.ts` imports `driver.js`; ESLint (`no-restricted-syntax`) and `tests/unit/guidance-isolation.test.ts` enforce it.
- `demo/main.tsx` loads it with a dynamic `import()`, so Driver.js is its own chunk and only the demo entry can reach it. The Live web and Electron entries cannot; the isolation test checks the import graph and, when `dist-web/` or `out/` exist, that their built output contains no Driver.js code or CSS.
- Driver.js and its stylesheet are bundled locally. No CDN, no API key, no telemetry, no network request.
- Guide copy is escaped before it reaches Driver.js (which renders `title` and `description` as HTML).
- Completion is kept in memory for the tab. Nothing is stored and the tour never starts by itself.

## Content Security Policy

The demo's production CSP is unchanged (`script-src 'self'; style-src 'self'; connect-src 'none'`, and the rest). Driver.js applies its styles through the CSSOM, which `style-src 'self'` permits. `tests/demo/tour.spec.ts` runs a whole tour while listening for `securitypolicyviolation` and console errors and requires none. If a future Driver.js version needed `unsafe-inline`, do not relax the policy: pin the previous version or replace the renderer.

## Future Pendo migration: what carries over and what does not

Carries over: the `GuidanceService` interface, the `data-guide-id` anchors, the guide ids and step ids, and the entry points (the toolbar button calls `start(guideId)`).

Does not carry over:

- Pendo-authored guides, targeting, segments and analytics are defined in Pendo, not in this catalog. Step copy would have to be recreated there or generated from the catalog.
- Pendo needs its SDK, an external network connection and an API key. That contradicts `connect-src 'none'`, the no-telemetry rule and the offline desktop app, so it needs its own consent, privacy, CSP and client-data-handling review before anything is enabled. It must never run in the fictional LAN demo as-is or in the desktop app.
- Pendo identifies visitors; this demo has none. Anchors must never carry client names, ids or other personal data.
- The engine's route-by-hash navigation and "never click anything" guarantee are app-owned behaviour that a hosted guide would not enforce.
