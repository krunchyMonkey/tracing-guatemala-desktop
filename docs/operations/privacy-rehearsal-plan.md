# Phase FIX privacy release: synthetic rehearsal plan (#211)

This is the plan for rehearsing the privacy release from start to finish with **fictional data only**. It is a plan, not an authorization:
- Running it on the real Live host is not allowed.
- Running it with the real database or any copy of it is not allowed.
- Running it with real client data is not allowed.

The real cutover remains a separate owner decision under #211.

Related runbooks: [database-migration.md](database-migration.md) and [ownership-reconciliation.md](ownership-reconciliation.md).

## Where it runs
- **Stage A, automated:** a GitHub-hosted runner (`workflow_dispatch`), or any computer that is **not** the Live host. Every command gets an explicit `--data-dir` under a new temporary folder, and the server listens on a port outside 4190–4192 and 443 (example: `4290`).
- **Stage B, manual:** a separate, isolated computer, such as the #185 MacBook staging host once it is approved. It uses fictional Google test accounts approved by the owner, and its own HTTPS name. It is never the Live host, and it never uses Live's Caddy, DNS name or certificate.
- **Never:** the Live checkout, its data folder or backups, ports 4190–4192 and 443, `npm run check` or web-live Playwright on the Live host, or real names and records in GitHub or CI.

## Fixture: a fictional v9 "legacy" profile
It is built with `tests/unit/helpers/legacy-fixture.ts`, or an equivalent seeding script on an old binary.
- Users:
  - **A**, active, `role=owner`, Google-bound. A is the stand-in for the primary researcher.
  - **B**, active, `role=owner`, bound.
  - **C**, active, `role=researcher`, bound.
  - **D**, `pending`, unbound.
- Research data:
  - **5 clients** with cases, notes, notebook pages with revisions, tasks, journal entries and time entries.
  - **One paused legacy timer.** The singleton `case_active_timer` is mid-session.
- **Record the baseline:** row counts and the content manifest of every table (`tests/unit/helpers/db-manifest.ts`), every primary key, and A's `app_users` and `user_identities` rows.

## Steps and pass criteria
Each step records pass or fail and evidence: commands, exit codes, counts and hashes. Record no content.

| # | Step | Pass when |
|---|---|---|
| 1 | Start the **new** build against the v9 profile | Refuses with `MigrationRequiredError`; profile byte-identical; nothing listens |
| 2 | Take a consistent backup with the old build's backup action; take a second copy off the machine | Both backups pass `inspectBackup` (integrity, `application_id`, version 9) |
| 3 | `npm run db:migrate -- --data-dir <dir>` with the typed phrase | v10; original and snapshot kept and identical to the baseline; content manifest of every pre-existing table equal; marker present |
| 4 | Start the new build | Starts; every client is **unclaimed**; A, B and C each see no research; the host session sees no research |
| 5 | **Rollback rehearsal:** `db:revert-migration` on an unchanged v10, then start the **old** binary | Exact v9 content; old binary serves the baseline. Then migrate again (step 3) |
| 6 | Restore drill: restore backup 1 into a scratch profile through the host-only restore | Counts equal; restored v9 is migrated only as a staging copy; clients unclaimed |
| 7 | #245 `db:claim-legacy` **preview** for target A with 3 explicit client ids | No writes; shows A's role and identity as "will not change" and per-client counts |
| 8 | Claim batch 1 (2 clients), then **interrupt** before client 3 (a test hook or kill) | Claimed clients are complete with audit rows; no partial claim; a rerun claims only the rest and reports `nothing-to-do` for the claimed ones |
| 9 | A signs in | Same `app_users.id`, role, identity and auth version; A administers users, reads and edits every claimed case, notebook and time entry, creates a new client, and has exactly one account |
| 10 | B and C sign in | See none of A's records; guessed ids are answered exactly as missing ids; unclaimed clients 4–5 are invisible to everyone |
| 11 | #247 timers: A and C run timers on their own cases at the same time; the legacy timer goes through the explicit reconciliation | Independent; no cross-user "busy"; legacy elapsed time preserved on the confirmed user |
| 12 | #212 sharing: A shares one case with C as viewer, upgrades to editor, then revokes while C's tab is open | Viewer read-only; editor writes attributed to C; owner stays A; the next request after revoke is denied |
| 13 | #246: disable then re-enable B; D signs in and the host attaches D's sign-in to the existing account D | B's sessions end on disable; D keeps its id and role; nothing is matched by email |
| 14 | Parity check | All baseline primary keys are present; the content manifest of every pre-existing table equals the baseline, except rows changed on purpose in steps 9–12, which are listed |
| 15 | Final backup, then restore it into a new scratch profile | Equal counts and manifests, including the 4 ownership tables |

Steps 11–13 are run once #247, #212 and #246 have landed. Until then they are recorded as "not run".

## Rollback rules
- The migration can be reverted **only while nothing has changed since it**. That is what `db:revert-migration` checks.
- Once research has been written after the cutover, rolling back means restoring a backup taken after the cutover, never the v9 snapshot, because the snapshot would lose that work.

## Output
- A results table with the steps above, the build SHA and the CI run links.
- No content, names, paths, hashes of real rows, or screenshots of real data.

## Exit criteria for the real cutover (still needs the owner)
- Every step passes in Stage A and Stage B.
- The #211 checklist is complete.
- An authorized maintenance window is set, with writes frozen.
- Two verified backups exist, one protected and off the host.
- The real target account is privately confirmed (id, status, bound identity).
- The researcher has consented to each client claim.
- Owner and researcher accept after the cutover.
