# Research ownership and access grants (#209)

**Status:** Source only. This stores ownership and grants and provides a host-only legacy claim. It does **not** enforce privacy: every read and write API still behaves as before. Enforcement is #210.

> **Do not deploy #209 alone.** See [Why #209 must not ship alone](#why-209-must-not-ship-alone).

## What it adds

Migration 10 (`research_ownership`) is purely additive. It adds four STRICT tables and changes no existing table, row, index or trigger. Existing clients, cases, notes, notebooks, revisions, users and audit rows are untouched, and every existing client stays **unclaimed**.

| Table | Purpose |
| --- | --- |
| `client_ownership` | The ownership root. One row per owned client: `client_id` (primary key, FK to `clients`), `owner_user_id` (FK to `app_users`), `origin` (`created` or `legacy-claim`), `assigned_at`, `assigned_by` (a user id, or `host`). **No row = unclaimed.** Never updated, never deleted (triggers). The owner must be an `active` user when the row is inserted. |
| `client_grants` | Viewer/editor access to a whole client for another user. Primary key `(client_id, grantee_user_id)`, so no duplicates. |
| `case_grants` | The same for one case. Primary key `(case_id, grantee_user_id)`. |
| `ownership_events` | Append-only audit: `owned-on-create`, `legacy-claimed`, `grant-created`, `grant-changed`, `grant-revoked`. `detail` is bounded JSON holding ids, counts, hashes and sizes only, never a file path or record content. |

## Derived ownership

Ownership lives on the client only. A case, and everything under it (events, brief, journal, tasks, time entries, active timer, notebook, sections, pages, revisions), is owned by whoever owns `research_cases.client_id`. There is no owner column on any child table, so a client's tree cannot be split between owners. A case created by anyone, including an editor of a shared client, belongs to the client's owner; who created it is a separate matter of attribution.

`OwnershipRepository.getCaseOwner(caseId)` resolves it through the client, so a case added later to a claimed legacy client is owned by the claimant automatically.

## Grant rules

Grants are trusted internal methods on `OwnershipRepository` (`setClientGrant`, `setCaseGrant`, `revokeClientGrant`, `revokeCaseGrant`, `listGrants`). There is **no HTTP call, API contract or UI** for them; the sharing UI is #212.

Each write is one `BEGIN IMMEDIATE` transaction that also appends the audit event, and is validated twice: in code (typed refusals) and by database triggers (so SQL that bypasses the repository is refused too).

- The resource must exist (`not-found`) and be owned (`unclaimed`).
- `grantedBy` must be the resource owner (`not-owner`). The app-level `owner` role is **not** a research owner and gets no automatic grant or ownership anywhere.
- The grantee must exist and be `active` (`invalid-grantee`); disabled and pending users are refused.
- The owner cannot be granted access to their own record (`self-grant`).
- Granting the same person again changes the permission (one row, `grant-changed`) or does nothing if it is the same (`unchanged`). Only `permission` and `updated_at` can change.
- Revoking deletes the grant row (a grant is a permission, not a research record) and appends `grant-revoked`. Revoking is allowed even if the grantee has since been disabled.

How a case grant and a client grant combine is a #210/#212 policy decision, not stored here.

## Creating clients

`ClientRepository.create(input, ownership)` takes a required `ClientCreateOwnership`; there is no default.

- `{ kind: 'user', userId, actor }`: the client, its `client_ownership` row (origin `created`) and an `owned-on-create` event are written in one transaction. `userId` must be an `active` user; otherwise `ClientOwnershipError('owner-unavailable')` is thrown and nothing is written. The Live host builds this variant from the **validated session's** internal user id, never from the request. `actor` is the user id, or `host` for an explicit host-chosen owner (repository/service level only; there is no HTTP way to choose one yet).
- `{ kind: 'unowned' }`: allowed **only while the profile has no `app_users` rows** (single-operator Electron, loopback, fictional pre-identity profiles). The client stays unclaimed. Once any user exists (even a pending one) it is refused with `ClientOwnershipError('owner-required')` and nothing is written. The host or app owner is never assigned silently.

The Live host maps `owner-required` to HTTP 409 `owner-required` and `owner-unavailable` to 403 `forbidden`. The client input schema is strict, so a body that carries `ownerUserId` (or any other extra key) fails with 400 `invalid-arguments` before anything runs.

## Legacy claim workflow (library only)

Historical clients stay unclaimed until a human authorizes an owner. The claim exists as library methods only: **no route, no script, no UI.** It must be run from a host-local context that holds the database.

1. `listUnclaimedClients({ limit })`: bounded (default 100, max 500): id, name, status, created date, case count.
2. `previewClaim(clientId)`: the exact scope: counts **and ids** of notes, cases (archived included), case events, briefs, journal entries, tasks, time entries, active timer, notebooks, sections, pages and revisions, plus existing grant count (0 for an unclaimed client) and a `scopeToken` (SHA-256 of the canonical client id and sorted ids per table).
3. Take a SQLite-consistent backup (`createBackup`), then `verifyClaimBackup(file, preview)`: opens it read-only, requires `integrity_check` ok, the app's `application_id`, a supported schema version, the client present, and the same per-table counts for that client's tree. Returns `BackupEvidence { sha256, bytes, schemaVersion, scopeToken }` (SHA-256 of the file bytes) or a typed failure (`not-a-backup`, `damaged`, `too-new`, `client-missing`, `scope-mismatch`).
4. `claimLegacyClient({ clientId, targetUserId, scopeToken, backup, confirmation, actor })`. `confirmation` must equal `claimConfirmationPhrase(clientId, targetUserId)`, i.e. `claim client <clientId> for user <targetUserId>`. In one `BEGIN IMMEDIATE` transaction: the target must be `active`, the client must exist and be unclaimed, and the recomputed scope token must equal both the previewed token and the backup's token (otherwise `scope-changed`). Then it inserts the `client_ownership` row (origin `legacy-claim`) and appends a `legacy-claimed` event holding the backup hash, byte size, schema version, scope token and counts. Any error rolls everything back.

Only the single root row is written, so a partially assigned family tree is impossible by construction: the root row exists (the whole tree is owned) or it does not (none of it is). Two competing claims serialize on the write lock; the second sees the owner and gets `already-claimed`. Nothing in the existing research tables is modified.

## What #209 does not do

- **No enforcement.** Listing, reading and writing records is unchanged for every principal. That is #210.
- **No sharing UI or sharing API.** That is #212.
- **No Live cutover, claim or deployment.** That is #211, with fresh owner authorization.
- No ownership transfer, no automatic claim by Google subject, email, login, role or "first user".
- The demo (in-memory) and Electron behavior are unchanged; Electron creates explicitly unowned clients.

## Why #209 must not ship alone

- **The Live profile migrates on open.** Starting a build that contains migration 10 against a Live profile upgrades it to schema 10 at once. A pre-migration snapshot is taken first, but writes can resume immediately after.
- **An older build then refuses the database** (`DatabaseTooNewError`, fail closed; it cannot corrupt it). Rollback is therefore "old build plus the pre-migration snapshot taken before writes resumed". Anything written after the upgrade is not in that snapshot, so rollback after writes resume loses those writes. It cannot be done blindly.
- **Host creates are refused in a profile with users** until #210/#212 provide owner selection, so the host loopback session can no longer create clients in the Live profile as it exists today.
- **Nothing is protected.** Records created by users are owned, but every approved user can still read and write every record until #210 lands.

#209, #210 and the #211 cutover must be released together, in a separately owner-approved step.

## Tests

Fictional fixtures only. `tests/unit/helpers/legacy-fixture.ts` builds v9 (and v7/v8) databases from the real migration list prefix plus raw SQL; `tests/unit/helpers/db-manifest.ts` hashes every table, index and trigger. `ownership-migration.test.ts` proves nothing existing changes, failure rolls back, the old build fails closed and a pre-migration snapshot recovers, and backups restore. `ownership.test.ts` covers creation rules, grants, trigger enforcement and the claim workflow including a two-connection race and an interrupted claim.
