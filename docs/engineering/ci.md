# Continuous integration (#190)

`.github/workflows/ci.yml` runs on every pull request to `main`, on every push to `main`, and on manual dispatch. It runs only on **GitHub-hosted** Ubuntu runners.

| Job | Commands |
| --- | --- |
| `quality` | `npm ci`, `npm run lint`, `npm run typecheck`, `npx vitest run --maxWorkers=2` |
| `browser` | `npm ci`, `npm run build` (Electron renderer compile only, for the bundle-separation test), `npm run web:build` (includes `demo:build`), `npx playwright install --with-deps chromium`, `npx playwright test --project browser-demo --project web-live` |

## Safety rules

- The workflow token is `contents: read`. The workflow has no secrets and no deploy step, and it uses no self-hosted runner. Checkout does not persist credentials.
- Every test server binds `127.0.0.1` (or, for the LAN-origin demo tests, the runner's own private IPv4) on the throwaway runner with a temporary data folder seeded with fictional records. Nothing reaches the private Live host, its network or its data.
- Actions are pinned to full commit SHAs, with the release tag in a comment.
- On failure, only `test-results/` is uploaded, and it is kept for 3 days. It holds fictional data only: Playwright error context, plus a trace and a screenshot for each failed `web-live` test (`trace: 'retain-on-failure'`, `screenshot: 'only-on-failure'`), plus the #250 selection log when a notebook selection step fails. Passing tests keep nothing.
- A newer push to the same PR cancels the older PR run. Runs on `main` are never cancelled.

## Notebook selection repeat (#250)

`.github/workflows/notebook-selection-repeat.yml` runs on pull requests to `main` that touch notebook UI code, the notebook selection specs, `playwright.config.ts` or the workflow itself. It can also be started by hand, with repetition counts as inputs, once it is on `main`.

It builds the web bundles and then runs, with `--retries 0`:

- the autosave bridge test (link records, create a task from a selection), `--repeat-each 40` by default;
- the Release A journey (`live-notebook-release-a.spec.ts`), `--repeat-each 15` by default.

Every repetition has to pass on its own. It follows the same safety rules as `ci.yml`. Failed-test results are uploaded for 3 days.

## Not run in CI

- **Playwright `electron` project.** It needs a display and an Electron binary, so it stays a local pre-merge check (`npm run check` on a workstation that isn't hosting Live).
- **`TG_CADDY_BIN` and Windows-only `pwsh` launcher tests.** These skip on Linux, as designed.
- **LAN-interface tests.** These skip when the runner has no private IPv4.

## Running checks on the Live host workstation

Several `tests/web` specs default to fixed loopback ports, for example `live-web.spec.ts` on 4191 and `live-cases.spec.ts` on 4192. Those ports are the same ones a running Live server uses: Live holds `port`, `port+1` and `port+2`.

**Do not run `npm run check`, `npm run test:e2e` or the `web-live` project on a machine that is currently hosting Live.** If you must run tests there, override every `WEB_E2E_*` and `SWITCH_E2E_PORT` variable to free ports, and leave it to CI to cover the rest.

## Requiring CI before merge (owner setting)

GitHub only enforces this after an owner sets it:

1. Open **Settings → Rules → Rulesets → New ruleset → New branch ruleset**: <https://github.com/krunchyMonkey/tracing-guatemala-desktop/settings/rules>.
2. Set **Target branches** to *Include default branch*.
3. Enable **Require status checks to pass** and add `Lint, types and unit tests` and `Demo build and browser tests`.
4. Optionally enable **Block force pushes**. Save with **Enforcement status: Active**.

Until that ruleset exists, CI is advisory: reviewers must check that the run is green before merging.
