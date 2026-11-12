# Legacy ownership reconciliation (#209)

**This procedure has NOT been run against any real data. It requires fresh, explicit owner authorization (under #211) before anyone runs any part of it on a real profile.** Nothing in #209 performs a claim or touches a Live database. Everything here is a plan for a future, separately approved maintenance window. It uses placeholders only; there are no real names, paths or identifiers in it.

Background: [research-ownership.md](../architecture/research-ownership.md). The claim is a host-only library operation. There is no HTTP route, CLI script or UI for it, and one must not be added without a new decision.

## Preconditions (all must hold)

- #209 and #210 are merged and released together, and the owner has authorized the cutover in #211.
- Every researcher who will own records has an **active** account (an approved sign-in, bound identity). A disabled or pending account cannot be a claim target.
- The owner has decided, per historical client, which researcher owns it. No claim is made by guessing, by email, by login order or by role.
- The host is in a maintenance window: remote access is off or blocked and **writes are frozen** (no one is using Live, no timers running), so the record tree cannot change between preview and claim. A change in between is caught (`scope-changed`), but a frozen system makes the procedure predictable.

## Sequence, per client

1. **Two verified backups first.** Take two SQLite-consistent backups (the app's backup function, never a raw copy of a live WAL-mode file), keep one protected and off-host, and verify both restore into a scratch profile and match. The claim does not replace this; it only adds evidence.
2. **List.** `listUnclaimedClients({ limit })` and record the client ids to handle.
3. **Preview.** `previewClaim(clientId)`. Read the counts and ids with the owner: the client, every case (including archived ones), and the notes, briefs, journal, tasks, time, timer, notebooks, sections, pages and revisions. Keep the `scopeToken`. Confirm the existing grant count is 0.
4. **Backup for this claim.** Create a fresh backup *after* the preview and *with writes frozen*. Run `verifyClaimBackup(file, preview)`. It must return evidence (`sha256`, `bytes`, `schemaVersion`, `scopeToken`). Any failure (`damaged`, `client-missing`, `scope-mismatch`, `too-new`) stops the procedure; fix and start again from step 3.
5. **Explicit target and confirmation.** The owner names the target user id. The operator types the exact phrase `claim client <clientId> for user <targetUserId>` (use `claimConfirmationPhrase`). A near miss is refused and changes nothing.
6. **Claim.** `claimLegacyClient({ clientId, targetUserId, scopeToken, backup: evidence, confirmation, actor: 'host' })`. It succeeds or changes nothing. `already-claimed`, `target-unavailable`, `scope-changed` and `confirmation-mismatch` all write nothing.
7. **Verify the audit.** Read the client's events: exactly one `legacy-claimed` event with the expected target, `actor` `host`, and the backup `sha256` and `bytes` matching the evidence. Confirm `getClientOwner` shows the target with origin `legacy-claim`, the cases derive that owner, and the other clients are still unclaimed. Confirm `PRAGMA integrity_check` is `ok` and `PRAGMA foreign_key_check` is empty.
8. Repeat for the next client. Do not batch; each claim has its own preview, backup and confirmation.

## The `db:claim-legacy` command (#245)

An offline, host-only command that does steps 3 to 8 above for a list of clients. It never starts the server, has no HTTP route, and no environment variable can confirm or bypass anything. Stop the web app first and keep your own off-host copy of the data folder.

```
npm run db:claim-legacy -- --data-dir <folder> --target-user <app_users.id> --client <id> [--client <id> ...] [--operator <label>] [--preview] [--confirm "<phrase>"]
```

- `--data-dir`, `--target-user` and at least one `--client` are required. Every client is listed explicitly; there is no "all" option. Duplicate ids are folded. `--operator` (default `host`, characters `A-Z a-z 0-9 . _ -`, at most 30) is recorded as the audit actor `cli:<operator>`.
- The data folder lock and an exclusive in-use probe are taken. The profile must already be at the current schema; an older one is refused and points to `npm run db:migrate`.
- **Target:** an existing account that is active, role Owner or Researcher, with at least one bound sign-in identity. It is never looked up by email or name. The account, its role, status, version and identities are never changed.
- **Preview:** `--preview` writes nothing at all (the profile stays byte-identical and no folder is created). It prints the target, per client the counts of cases, notebook pages, tasks, journal entries and time entries, whether each client is `pending` or `done`, and the typed phrase:
  `CLAIM <n> CLIENTS FOR <targetUserId> <fingerprint>`.
  The fingerprint (12 hex characters) covers the target and each pending client's scope token, so a preview made before any change to those clients cannot be confirmed.
- **Apply:** pass `--confirm "<phrase>"`, or type the phrase when run in a terminal (without a terminal and without `--confirm` it refuses). The plan is recomputed inside the lock; a different phrase is refused as `not-confirmed`. Then, in order: a verified snapshot `maintenance/claim-<stamp>/snapshot-v<N>.sqlite` (`VACUUM INTO`, integrity check, content manifest, `verifyClaimBackup` per client); each client claimed in its own transaction with a shared batch id in the event detail; verification that every table except `client_ownership` and `ownership_events` is unchanged, that exactly the claimed number of ownership rows were added, and that the target's account and identity rows are deep-equal; finally `maintenance/claim-<stamp>/report.json` (batch id, target id, operator, client ids with `claimed`/`done`/`remaining`, counts, snapshot hash and size; no names or content).
- **Resumable:** the first failure stops the batch. Clients before it stay claimed and audited, the failed one and the rest stay unclaimed (unclaimed means invisible), and the command prints which are claimed and which remain, exiting 1. Run the same command again (with the new phrase from a fresh `--preview`): clients already claimed by the same target are reported as `done`. When all are done it prints "Nothing to do" and exits 0.

Refusals, all with zero writes: `claim-input-invalid`, `data-dir-missing`, `data-dir-refused`, `in-use`, `migration-required`, `too-new`, `not-cleanly-closed`, `unsafe:<reason>`, `target-not-found`, `target-inactive`, `target-unbound`, `client-not-found`, `ownership-conflict` (a listed client is claimed by someone else), `not-confirmed`, `snapshot-unverified` (the snapshot is kept; nothing was claimed). `verify-failed` after claiming means the post-checks did not hold: nothing is repaired automatically; the snapshot and `report.json` are kept; stop and ask.

**Recovery:** ownership is immutable. If the wrong target was chosen, restore the snapshot from the batch's folder (the app's restore keeps a safety copy), provided nothing else has been written since; otherwise stop and ask, as in Rollback below. Check the target in the preview carefully.

Fictional example: `npm run db:claim-legacy -- --data-dir ./pilot --target-user 00000000-0000-4000-8000-000000000101 --client 00000000-0000-4000-8000-000000000201 --preview`.

## What the claim changes

Only the new tables: one `client_ownership` row and one `ownership_events` row per claim. No existing research row, id, timestamp, archive flag or relationship is modified.

## Rollback

- **Before any claim:** nothing to undo. The migration to schema 10 alone changes no content.
- **A single claim was wrong, and nothing else has been written since:** restore the verified backup from step 4 (the app's restore, which keeps a safety copy), which removes the ownership row and its event together.
- **Writes have resumed after the claim:** do **not** restore a snapshot blindly; newer records would be lost. Ownership rows cannot be edited or deleted by design, so a wrong owner needs a deliberate, separately authorized correction (a future transfer feature, or restore-and-replay agreed with the owner). Stop and ask.
- **Whole-release rollback** (old build): an old build refuses a schema-10 database. Use the old build with the pre-migration snapshot taken before writes resumed, or a verified backup, and accept the loss of anything written after it. The old-build drill is part of #211.

## Not part of this procedure

Enforcement of who can see what (#210), sharing grants and the sharing UI (#212), and any claim by a script or remote caller. Grants are stored by the repository only and are not created here.
