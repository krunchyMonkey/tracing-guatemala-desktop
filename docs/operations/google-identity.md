# Google identity for HTTPS Live (#177)

Phase 2.7 ([#176](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/176)) lets an approved person sign in to the private HTTPS Live app at `https://tg.krunchymonkey.dev` with Google. This page is the configuration runbook and decision record for [#177](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/177). The code lands in #178 (verification), #179 (approved users), #180 (sessions) and #181 (UI).

**Status (2026-11-05):** engineering is merged: verification (#178), users (#179), sessions and authorization (#180) and screens (#181), all tested with a fake provider. The validation record and operator runbook are in [phase-2.7-identity-validation.md](../pilot/phase-2.7-identity-validation.md) (#182). The Google Cloud project, OAuth client, domain verification, branding and the working sign-in test have **not** been done. Those are owner steps (see the checklist below). Nothing has been run against real Google yet, so nothing here claims that it works.

## What Google is used for, and what it is not

- **Authentication only.** Google tells the host *who* is signing in. The local approved-user directory (SQLite, #179) decides whether that person may use the app, and in which role. A successful Google sign-in on its own grants nothing.
- **Scopes:** `openid email profile`. Nothing else: no Gmail, Drive, Contacts, Calendar or FamilySearch scopes, and no `access_type=offline`, so Google issues **no refresh token**.
- **The stable key is the ID token `sub`**, never the email address or name. Google says to "only use Google ID token sub field as identifier for the user" because "a Google Account can have multiple email addresses". Email and name are kept only as display attributes.
- **Google never receives research records.** The browser talks to Google only during sign-in. The host talks to Google only to exchange the one-time code and fetch Google's public signing keys. Research data stays between the household browser and the host.
- **Google tokens are never the app session.** After verification the host issues its own opaque, revocable session (#180) and discards the Google tokens. No Google token is stored in the database, in browser storage or in logs.
- **The app stays LAN-only.** `tg.krunchymonkey.dev` resolves to a private address (Option B, [https-lan-dns.md](https-lan-dns.md)). No Cloudflare proxy or tunnel, no router forwarding, no public endpoint. Google's redirect is a browser navigation back to the private host. Google's servers never connect to it.

## Flow decision

Two Google web flows were evaluated against the current architecture (strict CSP, `connect-src 'self'`, `frame-src 'none'`, COOP `same-origin`, `Referrer-Policy: no-referrer`, same-origin Origin and Fetch Metadata checks on every write).

| | A. GIS "Sign in with Google" button (JS callback or `login_uri` POST) | **B. OIDC authorization code + PKCE (server side)** |
| --- | --- | --- |
| Google script in the research-data origin | Yes: `https://accounts.google.com/gsi/client` runs in the page | **No**: the app page loads no third-party code |
| CSP / headers to relax | script-src, frame-src, connect-src and style-src for `accounts.google.com/gsi/`; COOP `same-origin-allow-popups` when FedCM is off; Referrer-Policy at least `strict-origin-when-cross-origin` on the page | **None** on app pages. Only the callback is a cross-site top-level GET |
| Credential delivery | JS callback: the token reaches page script, then is POSTed same-origin. `login_uri` redirect mode: Google makes a **cross-site POST** with a `g_csrf_token` double-submit cookie, which our Origin/Fetch Metadata rules refuse by design | Google redirects the browser with a one-time `code`; the host exchanges it server-to-server |
| Client secret | Not needed | **Needed** (web clients are "private clients" that store a secret); kept host-local |
| CSRF / login-CSRF / replay | Nonce plus our CSRF header | `state` bound to a host-only login cookie, `nonce` in the ID token, PKCE `S256` verifier, single-use and 10-minute expiry |
| Safari / third-party cookie and FedCM behaviour | Depends on Google's iframe/popup and FedCM support per browser | Plain top-level redirects, the most widely compatible web pattern |

**Recommendation: B, authorization code + PKCE**, confidential web client. The deciding reason is that it keeps Google's JavaScript out of the origin that holds research records and keeps the existing CSP and headers unchanged. The cost is one host-local client secret. The ID-token checks (#178) are the same for both flows, so switching to A later only changes the transport adapter, not the verifier, directory or sessions.

**This is a recommendation, not yet the verified choice.** #177 asks for the choice to be based on a working test. That test needs the owner's Google client (checklist step 6). If B fails on a target browser, record what failed and re-evaluate A.

Notes from Google's documentation that the owner's test still has to confirm:
- Google's pages don't say whether PKCE removes the need for `client_secret` for web clients. The implementation sends both. Google's discovery document advertises `S256`.
- Google's pages say nothing about Safari, ITP or third-party cookie behaviour. Record real results from iPhone Safari rather than assuming.

## Google Cloud configuration (owner)

Use the owner's own Google account. Don't reuse a project that has other OAuth clients or APIs. Values in angle brackets are placeholders. Never paste real client secrets into GitHub, issues, chat or screenshots.

1. **Project:** create a dedicated Google Cloud project, for example `tracing-guatemala-live`. No billing account or APIs are needed for sign-in.
2. **Google Auth Platform → Branding:**
   - App name `Tracing Guatemala`; user support email = an owner-controlled address.
   - App home page `https://krunchymonkey.dev/tracing-guatemala/`.
   - Privacy policy `https://krunchymonkey.dev/tracing-guatemala/privacy/`.
   - Authorized domain `krunchymonkey.dev`. Add authorized domains before adding origins or redirect URIs.
   - Developer contact email = an owner-controlled address.
   - Logo optional. Google says that without brand verification "only your application domain will be visible to users" on the consent screen.
3. **Domain verification:** verify `krunchymonkey.dev` in Google Search Console with a DNS TXT record in Cloudflare. Google requires the homepage to be "hosted on a verified domain you own" for external production apps and brand verification.
4. **Audience:** user type **External**. Publishing status can stay **Testing** for the household pilot. Google: for `openid`, `userinfo.email` and `userinfo.profile` only, users "do not need to be in the trusted user list, they will not see a warning message, and their authorizations will not expire after 7 days". Switch to **In production** only when the owner wants the app name/logo shown (brand verification). App verification is "not mandatory" for non-sensitive scopes only.
5. **Data access (scopes):** add only `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
6. **Clients → Create client → Web application**, name `tg-live-https`:
   - Authorized JavaScript origins: none needed for flow B. Add `https://tg.krunchymonkey.dev` only if flow A is tested.
   - Authorized redirect URI: **`https://tg.krunchymonkey.dev/api/v1/auth/google/callback`**, exactly as written: scheme, case and trailing slash must match. Google requires HTTPS, no raw IP and a public-suffix TLD; `tg.krunchymonkey.dev` meets all three.
   - Do **not** add `localhost`, IP or `http://` redirect URIs to this client. Loopback Live keeps using the launch link, not Google.
   - Download the client JSON. It contains `client_id` and `client_secret`.
7. **Store the client JSON on the host only.** Keep it in a folder outside the repository that only the owner's OS account can read, for example `C:\Users\<owner>\tg-https\google\google-client.json`. Restrict it the same way as the Cloudflare token folder (owner-only ACL). Never commit it, upload it, paste it, print it or put it in screenshots. The repository ignores `google-client*.json` and `client_secret*.json` as a safety net.
8. **Working test (after #180 lands):** start the fictional HTTPS profile with the Google client flag documented in #180, then sign in from Windows (two browsers) and iPhone Safari. Record the browser, version, outcome and any limitation in #177. Use fictional users only.

The file the host expects has Google's download format; only these fields are read:

```json
{
  "web": {
    "client_id": "<numbers>-<id>.apps.googleusercontent.com",
    "client_secret": "<secret: host-local only>",
    "redirect_uris": ["https://tg.krunchymonkey.dev/api/v1/auth/google/callback"]
  }
}
```

A non-secret sample with placeholder values is in [`deploy/google/google-client.example.json`](../../deploy/google/google-client.example.json).

### Rotation, rollback and loss

- **Secret leaked or suspected:** in the Google Cloud console, add a new client secret, update the host-local file, restart Live, then disable and delete the old secret. Existing app sessions are host-issued and keep working until they expire or are revoked.
- **Turn Google off:** start Live without the Google client flag. HTTPS sign-in then fails closed (no fallback to pairing on a production profile, #180). The host's loopback launch link keeps working for recovery.
- **Remove entirely:** delete the OAuth client (or the project) in Google Cloud. Nothing in Google holds research data.

## Outage and offline behaviour (design for #178/#180)

- **New sign-ins need internet** on both the browser and the host: the browser to reach `accounts.google.com`, the host to reach `oauth2.googleapis.com` and `www.googleapis.com/oauth2/v3/certs`. If either fails, sign-in fails closed with a "Google can't be reached" message. No local bypass exists.
- **Existing app sessions keep working without internet**, because they are host-issued and checked against the local user directory, never against Google.
- **Host recovery never needs Google:** the launch link on the host computer reaches Settings → Users to re-enable or promote accounts.

## Same-site note for #180

`krunchymonkey.dev` and `www` are served by GitHub Pages, so they are the **same site** as `tg.krunchymonkey.dev`. That means:
- `SameSite` cookies don't protect against requests from those pages.
- A page there could try cookie tossing with `Domain=krunchymonkey.dev` cookies.

#180 must use a `__Host-` prefixed, host-only `Secure` session cookie and keep the exact-Origin and `Sec-Fetch-Site: same-origin` checks, which treat `https://krunchymonkey.dev` as a different origin. #180 must also test that pages on the apex and `www` can't use or plant a session. Nothing on the public site may run scripts that talk to `tg`.

## Public information and privacy page (owner review)

Google requires the homepage and privacy policy on an authorized, verified domain. The public site repository (`krunchymonkey-site`) already has `/tracing-guatemala/` and a **draft** `/tracing-guatemala/privacy/`. Its draft must be updated to match what is actually built before Google sign-in goes live for anyone. The draft text below is accurate for the Phase 2.7 design. The owner still has to:
- add a working privacy contact address;
- confirm retention;
- publish it through the site repository's own review.

Publishing it is a public-site change, so the owner approves it; engineering doesn't self-merge it.

> **Tracing Guatemala — privacy notice (draft for owner review)**
>
> **What it is.** Tracing Guatemala is a private family-history research workspace. It runs on a computer in the operator's home and is reachable only from that home network. This public page and the rest of krunchymonkey.dev don't host the application or its data.
>
> **Google Sign-In.** People the operator has approved can sign in with their Google account. The app asks Google only for basic identity: a stable account identifier, email address, whether the email is verified, and name. It does not request access to Gmail, Google Drive, contacts or any other Google data, and it does not keep Google access or refresh tokens. Signing in with Google does not by itself grant access. The operator must have approved that specific Google account.
>
> **What is stored.** For each approved person, the app stores, on the home computer:
> - the Google account identifier;
> - the email address and name from the last sign-in;
> - their role (owner or researcher) and account status;
> - when the account was created, changed and last used.
>
> If someone who is not approved tries to sign in, the app keeps a short-lived request so the operator can decide whether to approve it. Requests are deleted after 14 days or when the operator dismisses them, and at most 20 are kept. Signed-in sessions use a secure, HttpOnly cookie that expires and can be revoked by the operator at any time.
>
> **Research records.** Genealogy and client research stays on the home computer and its backups. It is never sent to Google or to this website.
>
> **Sharing.** The app does not sell or share identity information. Google processes the sign-in under [Google's Privacy Policy](https://policies.google.com/privacy).
>
> **Your choices.** You can ask the operator to disable your account and delete your identity details. You can also remove the app's access in your Google Account under Security → Third-party connections. Backups made before a deletion keep the old details until they are replaced. Contact: `<privacy contact address — owner to provide>`.
>
> *Last updated: `<date of publication>`.*

## Google identity verification (#178)

Transport-independent modules under `src/server/auth/`; no routes, sessions or database yet.

- `identity.ts`: the provider-neutral port (`IdentityProvider`, `VerifiedIdentity`, `IdentityFailure`) and `signIn(provider, gate, loginId, params)`. The `AccountGate` only looks up an existing account: unknown, pending and disabled accounts are denied; it never registers anyone or grants a role.
- `google-provider.ts`: authorization code + PKCE (`S256`), scopes exactly `openid email profile`, `prompt=select_account`, no `access_type`. Random `state`, `nonce` and verifier per login; pending logins are in memory (10 min, at most 50, single use), with limits on begins (30/min) and failed completions (20/10 min). Only `id_token` is read from the token response; the access token is discarded.
- `google-id-token.ts`: RS256 only, `kid` lookup, signature, `iss`, `aud` (exactly the client id), `azp`, `exp`/`iat` with 60 s skew, `nonce`, `sub`, `email_verified === true`. `emailAuthoritative` is true for Gmail addresses or a non-empty `hd`. Results carry only a failure code, never the token or claims.
- `google-keys.ts`: JWKS cache honouring `Cache-Control: max-age` (5 min to 24 h), one refetch per minute on unknown `kid`, 5 s timeout, fails closed as `provider-unavailable`.
- `google-config.ts`: reads Google's `{ web: {...} }` client file and derives the redirect URI from the HTTPS name; errors never include file content.
- `fake-provider.ts`: deterministic fake for tests only.

Routes, sessions, the account gate and the fake-provider gate landed in #180 (next section).

## Sessions and authorization (#180)

**Turning it on.** `--google-client <path to the Google client JSON>` together with `--https-host <name>` (and the existing fictional-profile gate; #168/#169 are untouched). Without `--https-host` the flag is refused and nothing starts; an unreadable or mismatching client file prints a fixed message (never file content) and nothing starts. With it, the HTTPS proxy listener signs people in with Google and uses app sessions; **device pairing and `tg_lan_*` cookies do not exist on it** (`/api/v1/lan/enroll` is 404, a device cookie is ignored). Without `--google-client`, `--https-host` keeps fictional pairing, and `--lan-host` (plain HTTP) is pairing only, never Google. The loopback launch-link session is unchanged and is the operator/recovery path. **Rollback:** restart without `--google-client`.

**Test hook.** Only with both `TG_TEST_HOOKS=1` and `TG_TEST_FAKE_IDENTITY=1` does the CLI use a fake provider (sign in with `code=alex`, `code=bea` or the unapproved `code=cara`); it prints a loud warning. Never set them outside automated tests.

**Routes (proxy listener, Google mode).** All keep the exact Host check; `Forwarded`/`X-Forwarded-*` are never read.

| Route | Rule |
|---|---|
| `GET /api/v1/session` | `{ authenticated, csrfToken, remote: true, auth: 'google', user }` |
| `GET /api/v1/auth/google/start` | top-level navigation from the sign-in **link** (#181): `Sec-Fetch-Site` must be `same-origin` (or `none`, a typed address), `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` when sent, and any `Origin` must equal `https://<name>`; a browser that sends no Fetch Metadata can't start a sign-in. 303 to Google with the login cookie. POST is 405 |
| `GET /api/v1/auth/google/callback` | GET only; `Sec-Fetch-Mode` (if sent) `navigate`, `Sec-Fetch-Dest` (if sent) `document`; query at most 4 KiB; verified via the login cookie, state, nonce and PKCE (#178); 303 to `/` or `/?signin=<reason>` |
| `POST /api/v1/auth/logout` | exact Origin and CSRF; deletes the session |
| `POST /api/v1/call/:name` | exact Origin, `Sec-Fetch-Site` same-origin or absent, session, CSRF, then the policy below |
| backups upload/download | always 403 `host-only` |

`/?signin=` values: `not-approved`, `disabled`, `unavailable`, `expired`, `cancelled`, `busy`, `failed`. A stranger who completes Google sign-in gets no session and no account; one pending request is recorded for the owner (`recordSignInRequest`). Codes, tokens, emails and cookies are never logged; logs hold method, route template and status.

**Cookies.** Session: `__Host-tg_session=<id>; Path=/; Secure; HttpOnly; SameSite=Strict`. Login state: `__Host-tg_login=<id>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` (Lax because Google's redirect back is a cross-site top-level GET). No `Domain`, no port in the name. A cookie name that appears twice in a request is treated as absent (cookie tossing). Each sign-in issues a new session and ends any session the browser already held (rotation).

**Session lifetime.** 32-byte random id, in memory. Idle 8 hours, absolute 7 days, at most 10 per user and 200 in total (oldest evicted). **A host restart ends every session** (fail closed; people sign in again). Turning LAN access off and restoring a backup also end every session.

**Revocation semantics.** A session holds only `userId` and the `auth_version` it was created at. **Every request** re-reads `status`, `role` and `auth_version` from the user directory and requires `active` and an equal version; otherwise the session is deleted and the answer is 401 `not-signed-in`. Role change, disable, re-enable and "revoke sessions" all bump `auth_version`, so they take effect on the very next request. The role always comes from the database, never from the session, so this also holds on a second host sharing the database. After a user-admin call the server also drops that user's sessions.

**Authorization (server side, `src/server/auth/policy.ts`).**

| Call group | host (loopback) | paired device | researcher | owner |
|---|---|---|---|---|
| Clients, cases, notebook, tasks, time, studio, `getAppInfo` | yes | yes | yes | yes |
| User directory (8 calls: `listUsers` ... `revokeUserSessions`) | yes | no (`host-only`) | no (`forbidden`) | yes (actor = own user id) |
| Backups, restore, `getBackupStatus`, device admin, pairing code, `getLanStatus`, `disableLan` | yes | no | no | **no** (`host-only`) |
| `getMyAccount` | null | no | yes | yes |
| `revokeMySessions` (sign out everywhere) | no | no | yes | yes |

Unknown call names are 404 for users. Backups, restore, device administration and LAN/network actions are never available to any remote principal, including an owner; they stay with the loopback host session.

**Same-site defences.** The public apex and `www` (`krunchymonkey.dev`) are the same site as `tg` but a different origin: their `Origin` fails the exact check, `Sec-Fetch-Site: same-site` is refused, the `__Host-` prefix stops a sibling from planting or shadowing a cookie, and the session cookie is `SameSite=Strict`. Nothing on the public site may run scripts that talk to `tg`.

**Phase 2.8 seam (#187).** Sessions sit behind `UserSessionStore` (`src/server/auth/user-sessions.ts`), injectable into `createLiveHost`/`startLiveServer`. It is synchronous because the only implementation is in memory; a store shared by several backend nodes will need an async variant of the same interface. The per-request database check above is what makes role revocation correct across nodes, so keep it when the store changes. Do not route a second node until a shared store exists and revocation across nodes has been tested.

## Sign-in, Account and Users screens (#181)

**Sign-in page** (HTTPS Google mode only; Demo never shows it and has no link into it). A light "Sign in with Google" button with the standard multicolour "G" is a plain same-origin link to `/api/v1/auth/google/start` (see "Why a link and not a form" below): no Google script, no token in the browser. The host's `?signin=<reason>` redirect is read once and removed from the address bar. Messages: not approved ("the owner can approve it from Users"; nothing says the owner was notified, because nothing is sent), turned off, Google unavailable, timed out, cancelled, too many attempts, failed, and "Your session ended. Sign in again." when a session is lost mid-use. Offline shows "No network connection" and disables the button. No message says whether an address exists in the directory.

**Account** (Settings, every signed-in person): name, email, role badge, "Sign out", and "Sign out on all devices" (asks first, then returns to sign-in). The banner shows "Signed in as <name> (<role>)". The old HTTP device-pairing pilot keeps its own labels.

**Users** (Settings, host session and remote owners; never researchers or paired devices; the host shows it only while the HTTPS listener is on). People list (name, email, role, status, last sign-in), sign-in requests (approve as new user, link to an existing pending person, dismiss), add a pending person, change role, turn off / back on, sign out everywhere. Role changes, turning someone off and sign-out-everywhere ask first. The last active owner can't be removed. Hiding the section is cosmetic: the host enforces every call (see the table above).

**Bootstrap (first owner).**
1. The future owner opens the HTTPS address and tries Sign in with Google: "not approved yet". This leaves a sign-in request.
2. On the host computer, open the private launch link, then Settings, Users.
3. Under Sign-in requests, "Approve as new user" on your own request, set Role to Owner, Approve.
4. Sign in again on the HTTPS address. Add researchers the same way (they try to sign in, you approve them as Researcher), or use "Add person" first and "Link to existing person" when their request arrives.

**Recovery.** The loopback host session always reaches Users, so a lost owner account, a demoted owner or a disabled owner is repaired there (make or re-enable an owner, or approve a new request as Owner) without any Google access.

**Browser E2E harness.** `tests/web/live-google.spec.ts` starts the built host with `--https-host tg.example.test --google-client <unused path> --init-lan-test-profile` and `TG_TEST_HOOKS=1 TG_TEST_FAKE_IDENTITY=1` (fake provider with fictional Alex, Bea, Cara; it verifies nothing). `tests/web/https-front.ts` generates a throwaway self-signed certificate with `openssl` at test time (deleted afterwards, never committed; the spec skips without `openssl`) and runs an HTTP CONNECT proxy that terminates TLS for `tg.example.test` (forwarded to the HTTPS listener, Host and Origin intact) and `fake-google.test` (a consent page with "Continue as alex/bea/cara" and "Cancel"). Playwright uses that proxy with `ignoreHTTPSErrors`, so the `__Host-` Secure cookie and exact-Origin checks run for real.

**Why a link and not a form (decided in #181).** The E2E found that a form POST can't work with the host's existing headers: the page CSP has `form-action 'none'` (which also covers the redirect to Google), and `Referrer-Policy: no-referrer` makes browsers send `Origin: null` on form posts. Rather than relax either, the sign-in button is a same-origin link and the start route is a Fetch-Metadata-checked GET. Neither header changes. Starting a sign-in from another site, the public apex or `www`, `fetch()` or an iframe is refused. Forging a start gives an attacker nothing anyway, because the login is bound to the `__Host-tg_login` cookie, its `state` and its nonce.

## Owner checklist (#177)

- [ ] Google Cloud project, Branding and Audience configured as above (Testing status is fine for the pilot).
- [ ] `krunchymonkey.dev` verified in Search Console and added as the authorized domain.
- [ ] Web client created with only the exact redirect URI. Client JSON stored host-local with an owner-only ACL, never in GitHub.
- [ ] Privacy contact address chosen. The public site's privacy page updated from the draft above and published through its own review. The overview page's "Google Sign-In is being evaluated" wording updated.
- [ ] After #180: working sign-in test on Windows (two browsers) and iPhone Safari with fictional users, results recorded in #177. Flow B confirmed, or the failure documented and flow A re-evaluated.
- [ ] Confirmed no Cloudflare proxy/tunnel or router forwarding was added. `tg` stays DNS-only to the private address.

Sources (read 2026-11-05):
- [OAuth 2.0 for web server apps](https://developers.google.com/identity/protocols/oauth2/web-server)
- [OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Verify the Google ID token](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [GIS setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)
- Google Cloud Help: [App verification](https://support.google.com/cloud/answer/13463073), [Manage app audience](https://support.google.com/cloud/answer/15549945), [Branding](https://support.google.com/cloud/answer/15549049), [OAuth clients](https://support.google.com/cloud/answer/15549257)
