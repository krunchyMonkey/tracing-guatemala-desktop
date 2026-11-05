# Phase 2.7 identity validation and operator runbook (#182)

Validation record for Google Sign-In and basic user management ([#176](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/176)), plus the runbook for the person who runs the host. Design and configuration are in [google-identity.md](../operations/google-identity.md).

**Status (2026-11-05):**
- **Engineering:** complete and merged (#196–#200 plus this PR). Every automated check below ran on fictional data with a **fake identity provider**.
- **Owner acceptance:** NOT RUN. Nothing here has been run against real Google, on an iPhone, or by the researcher or owner.
- **Real records:** this pilot does **not** approve real records over the home network. #168, #169 and #139 stay open and are separate gates. Google sign-in alone never authorizes real data.

## Automated evidence

The local gate is lint, typecheck, `npx vitest run --maxWorkers=4` and `npm run test:e2e`. The repository has no CI yet (#190), so these are local results only.

| #182 requirement | Where it is tested | Result |
| --- | --- | --- |
| Forged ID token, wrong audience/issuer, expired, future `iat`, nonce, unverified email, `alg` none/HS256, unknown `kid`, malformed/oversized | `tests/unit/google-identity.test.ts` | pass |
| JWKS outage and token-endpoint outage fail closed; bogus callbacks can't lock sign-in out | `google-identity.test.ts` | pass |
| Login CSRF (missing or other login cookie), replayed callback, non-navigation callback, cancel at Google | `tests/unit/live-google-sessions.test.ts` | pass |
| Start of sign-in from another site, the same-site public apex/`www`, `fetch()`, an iframe, or without Fetch Metadata | `live-google-sessions.test.ts` | pass |
| CSRF token and exact Origin on every write, including from `https://krunchymonkey.dev` | `live-google-sessions.test.ts` | pass |
| Cookie tossing (a look-alike or duplicated cookie) | `live-google-sessions.test.ts` | pass |
| Cookie flags `__Host-`, Secure, HttpOnly, SameSite=Strict, host-only, in a real browser over HTTPS | `tests/web/live-google.spec.ts` | pass |
| Unknown and unapproved person: no session, no account, one request recorded | unit + browser E2E | pass |
| Disabled person, role downgrade, revoke, sign out on all devices: effective on the very next request | unit + browser E2E | pass |
| Researcher refused the user directory; owner and researcher both refused backups, devices and network | `live-google-sessions.test.ts` (pinned table covering every call) | pass |
| Last-owner guard (API and UI) | `tests/unit/users.test.ts`, browser E2E | pass |
| Restart, LAN turn-off and backup restore end every session; idle and absolute expiry | `live-google-sessions.test.ts` | pass |
| Google session can't be used on loopback, on HTTP LAN or pairing-mode HTTPS, on the demo, or on a second host | `tests/unit/identity-bypass.test.ts` | pass |
| Shared workspace with two identities; recorded concurrency behaviour (below) | `identity-bypass.test.ts` | pass |
| Migration 8→9, users kept after reopen, backup round trip, restore of a v8 backup | `users.test.ts`, `backup.test.ts`, `database.test.ts` | pass |
| No codes, tokens, emails, names or cookies in logs | `google-identity.test.ts`, `live-google-sessions.test.ts` | pass |

**Gate on this PR:** see the PR description for the exact counts. Known flakes under full-suite load, which pass on rerun: `live-lan.spec.ts:245` (also fails on the code from before Phase 2.7), plus intermittent `CaseHours`, `notebook-boundary`, `live-host` and `live-lan-security` timing failures in full-parallel Vitest.

### Shared workspace: recorded behaviour

Phase 2.7 has **no per-user partitioning**. Every approved person, owner or researcher, works in the same shared research workspace. `identity-bypass.test.ts` records what actually happens with two signed-in people:

- There is no per-user partitioning: every signed-in person sees all clients and cases.
- A researcher can edit a client that the owner created.
- **Client edits are last-write-wins.** `updateClient` carries no version, so a second edit made from a stale view silently replaces the first. Two edits sent at the same moment both succeed, and exactly one of the two names remains.
- **Notebook pages are protected.** A save made against an old page version by the other person is refused with `conflict` and the current page, so nothing is overwritten.
- **There is one timer for the whole workspace.** `getActiveTimer` returns the same running timer to everyone, and nobody else can start a timer on another case while it runs (`other-case-timer`).
- A role change ends the person's existing session at once (401), and they sign in again with the new role.
- Each role change is logged with the acting owner's id as the actor, never the affected person.

**Accepted risk, not fixed in Phase 2.7:** with two people working at once, an edit can be silently lost when both change the same record from stale screens. This was tested for clients. `updateCase`, `saveCaseBrief`, `updateJournalEntry`, `updateCaseTask` and `updateTimeEntry` carry no version argument either, so by construction they are last-write-wins too (not separately tested). Notebook pages are protected by version checks. Adding version checks to the other records is a separate change and wasn't part of #176. Raise it with the owner if two people will edit the same records.

### Not tested (be honest about these)

- **Real Google:** the OAuth client, consent screen, real ID tokens and the token endpoint. This needs the owner's configuration in #177.
- **Browsers:** iPhone Safari, Safari on macOS, Firefox and Edge, and any real household device. The browser E2E runs in Playwright's Chromium through a test-only TLS front end, not through Caddy and the real certificate.
- **Older browsers:** ones that send no Fetch Metadata, such as Safari before 16.4, can't start a sign-in. This was not checked on a device.
- **Accessibility:** a human keyboard-only pass and a screen-reader pass. Automated tests only check roles and labels.
- **Network conditions:** real internet loss and a Google outage on the host. Both are simulated in unit tests.
- **Persistence and scale:** sessions surviving a restart (deliberately not supported in v1) and multi-host sessions (Phase 2.8, #187).

## Owner acceptance checklist (NOT RUN)

Use a **fictional profile** (`--init-lan-test-profile`) and fictional records only. Record the browser, its version, the device and the outcome for each line in #182. Don't paste addresses, cookies, codes or screenshots showing them into GitHub.

**Prerequisites:** the #177 Google Cloud steps are done, the client JSON is stored host-local, and Caddy is serving `tg.krunchymonkey.dev` (see [https-lan.md](../operations/https-lan.md)).

1. [ ] **Start:** start Live with `--https-host tg.krunchymonkey.dev --google-client <host-local path> --data-dir <fictional profile>`. The window shows the HTTPS address and says Google sign-in is on.
2. [ ] **Bootstrap:**
   - Sign in on `https://tg.krunchymonkey.dev` from the owner's Google account. It should say the account isn't approved.
   - Open the launch link on the host, go to Settings → Users, and approve the request as **Owner**.
   - Sign in again over HTTPS. It should work, and Settings should show Account (Owner) and Users.
3. [ ] **Researcher:**
   - A second Google account tries to sign in and is refused.
   - The owner approves it as Researcher.
   - The researcher signs in, sees the shared clients and cases, and has **no** Users section.
4. [ ] **Browsers:** steps 2–3 work on Windows in two browsers and on **iPhone Safari**. Record what didn't work.
5. [ ] **Shared work:** owner and researcher each create and edit fictional clients, cases and notebook pages, and each sees the other's changes.
6. [ ] **Turn off:**
   - The owner turns the researcher off. The researcher's next action ends on "Your session ended", and signing in again says the account is turned off.
   - The owner turns the researcher back on.
7. [ ] **Revoke:** "Sign out everywhere" (by the owner) and "Sign out on all devices" (by the person) both end every session of that person.
8. [ ] **Last owner:** making the only owner a researcher, or turning them off, is refused with a clear message.
9. [ ] **Restart:** stop and restart the host. Everyone has to sign in again, and users and roles are unchanged.
10. [ ] **No internet (host):**
    - Disconnect the host from the internet. A new sign-in says Google can't be reached, while an existing session keeps working.
    - Reconnect, and sign-in works again.
11. [ ] **Unknown and stranger accounts:** an unapproved account never sees any data. Its request appears in Users, and dismissing it removes it.
12. [ ] **Public site:** while signed in, open `https://krunchymonkey.dev`. Nothing there shows or uses the Live session. (Engineering tests cover the attacks; this is a sanity check.)
13. [ ] **Mobile data:** with Wi-Fi off on the phone, `tg.krunchymonkey.dev` does not load. It is LAN-only.
14. [ ] **Keyboard and phone:** the sign-in page and Users work with keyboard only on desktop and at phone size.
15. [ ] **Backups:**
    - On the host, make a backup. Change a user's role.
    - With HTTPS off, restore the backup. Everyone is signed out, and the role is back to what the backup had.
16. [ ] **Rollback:** restart without `--google-client`. The HTTPS listener goes back to fictional device pairing, and nothing about users is lost.
17. [ ] **Approval:** the owner and the researcher approve, or reject, the sign-in and Users experience. Record the decision in #182.

## Operator runbook

### Start and stop

- **Start:**
  ```
  npm run live -- --https-host tg.krunchymonkey.dev --google-client C:\Users\<owner>\tg-https\google\google-client.json --data-dir <fictional profile>
  ```
  Caddy must forward to `127.0.0.1:<port + 2>`.
- **Stop:** press Ctrl+C. Stopping ends every session; people sign in again after the next start.
- **No Google:** start without `--google-client` to go back to fictional device pairing. The loopback launch link always works on the host computer.

### People

- **First owner:** follow checklist step 2. The first person to sign in is **never** made owner automatically.
- **Add someone:** they try to sign in, which creates a request. In Users, you then either approve it as a new user, or use "Add person" first and "Link to existing person" when the request arrives.
- **Check before approving:** compare the request's email with the person. Where Users warns that Google does not manage the address, confirm it with them first. Access is tied to the Google account (`sub`), not to the email.
- **Remove someone:** turn them off. Users are never deleted, so the audit log keeps who did what.
- **Lost, demoted or disabled owner:** open the launch link on the host. The host session always reaches Users. Make or re-enable an owner, or approve a new request as Owner.

### Backups, migrations and rollback

- **Backups** include users, identities and the audit log. Making and restoring backups is host-only, and restore is refused while the home-network listener is on.
- **Restoring** brings back the users exactly as they were in the backup, which can re-enable someone you turned off afterwards. Every session is ended by a restore. Check Users straight after restoring.
- **Migration 9** (users) runs automatically on first start. Before upgrading, the app writes a copy of the old database to `<data dir>\data\pre-migration\`.
- **Downgrading:** an older app version refuses to open a version-9 database ("saved by a newer version"). To go back, restore the pre-migration copy with the older version. Anything changed since the upgrade is lost.

### Google client secret

- **Rotate** (leak or routine): in Google Cloud, add a new secret, update the host-local JSON, restart, then delete the old secret. Existing app sessions end with the restart.
- **Rules:** never commit, paste, print or screenshot the JSON. The repository ignores `google-client*.json` and `client_secret*.json` as a safety net only.

### Outage

- **Google or internet down:** new sign-ins fail closed with "Google sign-in is not available right now". Existing sessions keep working until they expire (8 hours idle, 7 days absolute) or the host restarts.
- **Recovery** never needs Google: the host's launch link always works.

### What stays host-only, even for owners

Remote owners can never reach backups (create, restore, upload, download), device pairing and the device list, home-network status and turn-off, or the launch link. Remote owners can manage users. Everything else is the shared workspace.
