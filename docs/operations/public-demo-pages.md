# Public demo on GitHub Pages (#192)

| | |
| --- | --- |
| **URL** | <https://krunchymonkey.github.io/tracing-guatemala-desktop/> |
| **Branded entry** | <https://krunchymonkey.dev/tracing-guatemala/demo/>, a separate repo (`krunchymonkey-site`) that links here |
| **Workflow** | `.github/workflows/demo-pages.yml` ("Public demo (GitHub Pages)") |
| **Content** | only the verified fictional `dist-demo/` artifact from [#191](../demo/public-artifact.md) |

This workflow does **not** build, deploy, restart or contact the private Live application. It has nothing to do with `tg.krunchymonkey.dev`, the home network, Caddy, DNS or any database. The private Live host never runs it, and no self-hosted runner is involved.

## Why `github.io`

`github.io` is on the Public Suffix List, so `krunchymonkey.github.io` is a different **site** from `krunchymonkey.dev` and `tg.krunchymonkey.dev`:

- The demo can't share or receive cookies with the private Live origin.
- The demo has no login, sets no cookies and uses no storage. Tests assert this.
- Do not move it to `demo.krunchymonkey.dev` until the #168/#180 same-site review says that is safe.

## How a release works

1. A PR that touches the demo or this workflow runs a **dry run**. The `build` job builds, verifies, runs the browser negative tests and stages the Pages artifact. `deploy` is skipped.
2. To publish, go to **Actions → Public demo (GitHub Pages) → Run workflow**, from `main`:
   - `source_sha`: a commit on `main`. Leave it empty for the current `main` HEAD.
   - `expected_digest`: optional. It must match the artifact, for example the digest a dry run printed.
3. The `build` job (`contents: read`):
   - refuses refs other than `main` and commits that are not on `main`
   - runs `npm run demo:artifact`, then the browser negative tests against that exact output
   - re-verifies the digest and uploads **only** `dist-demo/`
   - writes the source SHA and digest to the run summary
4. The `deploy` job (`pages: write`, `id-token: write`, environment `github-pages`) publishes it.
5. The `smoke` job (no permissions) fetches the live `demo-manifest.json`. It checks that `sourceSha` and `digest` match and that `index.html` still has `connect-src 'none'`.

Record each release with the run URL, source SHA and digest. The deployed version is readable at `https://krunchymonkey.github.io/tracing-guatemala-desktop/demo-manifest.json`.

## One-time owner setup

1. **Pages source:** open <https://github.com/krunchyMonkey/tracing-guatemala-desktop/settings/pages> and set **Build and deployment → Source** to **GitHub Actions**. Leave **Custom domain** empty.
2. **Protect the environment:** open <https://github.com/krunchyMonkey/tracing-guatemala-desktop/settings/environments> and choose **github-pages**.
   - Set **Deployment branches and tags** to **Selected branches** with `main` only. GitHub usually creates this rule.
   - Recommended: under **Required reviewers**, add the owner, so every publication waits for an approval click.
3. Run the workflow as described above.

## Headers and limits

GitHub Pages can't send custom headers, so the CSP comes from the `<meta>` tag in `index.html`, which the verifier requires. A meta CSP can't set `frame-ancestors`, so another site could frame the demo. That is acceptable for a fictional, login-free page, and is noted here for review. The page also sets `referrer: no-referrer` and `robots: noindex, nofollow`.

Routing is hash-based (`#/clients`) and assets use relative paths (`base: './'`), so the `/tracing-guatemala-desktop/` base path needs no server rewrites. The browser tests load it at that exact path.

## Smoke test by hand

From any browser, on any network:

1. Open the URL. The Clients screen shows the *Demo Mode — Fictional Data Only* banner.
2. Create a case under a client and add a journal entry, then refresh. Both are gone.
3. In DevTools → Network, the only requests are `index.html`, `assets/*` and nothing else. The Console shows no errors.
4. Open `demo-manifest.json` and compare `sourceSha` and `digest` with the release record.

## Rollback

Run the workflow again with `source_sha` set to the last good commit, and `expected_digest` set to its recorded digest. The same commit gives the same digest. The deployment history is at <https://github.com/krunchyMonkey/tracing-guatemala-desktop/deployments/github-pages>.

## Turning publication off

Open **Settings → Pages** and choose **Unpublish site**, or run `gh api -X DELETE repos/krunchyMonkey/tracing-guatemala-desktop/pages`. Then switch the branded page in `krunchymonkey-site` back to "Coming soon". Nothing about the private Live application changes either way.

## Release record

| Date | Run | Source | Digest | Approved by | Smoke |
| --- | --- | --- | --- | --- | --- |
| 2026-11-06 | [42199222654](https://github.com/krunchyMonkey/tracing-guatemala-desktop/actions/runs/42199222654) | `005b943035b2798bd3aa781ad7833bf10ca83e2c` | `774362dff0343b34e6295377b1aca052711a1af0fd2f14c779a0f3ce439046af` | owner (first public go-live) | workflow smoke passed; external desktop and phone check from the branded page passed |
