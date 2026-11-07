# Database migration and recovery runbook

Status: engineering reference for issue #248. **Merging this to source is not production authorization.** Issue #211 owns the real cutover; nothing here may be run against real data without the owner's go-ahead there.

## Why startup refuses

A newer build used to upgrade any existing profile silently when it started. It no longer does. On start, before anything is created or opened for writing, the app looks at the profile (plain file reads only: the database header and, if there is a non-empty `-wal`, the log's own frames; SQLite is never opened at this point and no `-shm` is created) and decides:

| Profile | What start does |
|---|---|
| New (see "First start versus missing data") | Creates the database at the latest schema. No snapshot is needed. |
| Same schema as this build | Opens it (SQLite recovers a committed log). |
| Older schema | Refuses: "This data is at schema vX; this version needs vY. Nothing was changed." |
| Newer schema | Refuses with the existing "saved by a newer version" message. |
| Leftovers or damage | Refuses and names the reason (below). Nothing is created, so a missing database can never be replaced by an empty one. |

Refusals never print a path or any stored content, and they change nothing.

## Which version a write-ahead log means

If the database has a non-empty `-wal`, the version is not the main file's header: the log can hold a newer copy of page 1. The preflight reads the log itself (frame salts and checksums, only up to the last valid commit frame) and uses the last committed page 1, else the main file's. Equal to this build's version: it opens and SQLite recovers the log. Lower: it needs the maintenance command (which still refuses any non-empty log: start and stop the version that wrote it once). Higher: refused as newer.

**`wal-unreadable`** means a non-empty `-wal` whose header is invalid, unknown or truncated, or a `-wal` beside an empty main file (SQLite would throw that log away). Nothing was changed. Do not delete the `-wal`: it may hold committed rows. Stop every copy of the app, copy the whole data folder somewhere safe, then ask for help or restore a verified backup. A log may be removed only by an operator who has checked that a restore-verified copy holds everything needed.

## First start versus missing data

A profile is new (the app creates the database) **only** when all of these hold: the database file is absent (or 0 bytes with no `-wal`), there is no `profile-initialized.json` in the profile folder, `data/` is absent or empty, and `backups/` and `uploads/` beside `data/` are absent or empty. Other files in the profile folder (Electron's `Local State`, `Preferences`, `web-host.lock`, the test marker) are ignored. Anything else with no database is refused as *missing database*, and nothing is created.

`profile-initialized.json` (`{ "format": 1, "application": "tracing-guatemala", "createdAt": ... }`) is written next to `data/` when a new database is created, when a current profile opens without it, and after a successful migration. Deleting `data/` therefore does not turn the profile back into a new one. No flag or environment variable bypasses this.

The marker is written durably and fails closed: a fresh temporary file is written, flushed to disk, renamed into place and read back to check its exact fields (the folder is flushed too where the OS allows it). An existing marker file is never rewritten. For an existing database without a marker, the marker is written **before** the database is opened for writing; for a new database, right after its schema is created and verified. If the marker cannot be written (folder read-only, disk full, something that is not a file sitting at the marker path), startup refuses with "could not record that this data folder is in use" (`profile-marker-unwritable`) and serves nothing; a new database file that was already created stays, and the next start retries the marker. Nothing in your research was changed. Recovery: make the profile folder writable (free space, fix permissions, remove only a stray *folder* named `profile-initialized.json` or `profile-initialized.json.tmp` if one is there) and start again. Never delete `data/` to "fix" this.

Recovery: for a genuinely new profile, use a new empty folder. For missing data, put a restore-verified backup file back as `data/tracing-guatemala.sqlite` (then migrate if it is older).

## Fresh development and test profiles

A new folder is initialized by simply starting the app on it (`--data-dir <new folder>`); there is nothing to migrate. Automated tests build their own throwaway folders with fictional rows.

**Test hooks.** `TG_TEST_HOOKS=1` is accepted only when all of these hold: the data folder (symlinks and junctions resolved) is inside the system temporary folder; it contains a file `tg-synthetic-test-profile` with exactly the fixed content written by the test harness (`markSyntheticTestProfile`); and it is not the default Live or desktop folder. Otherwise the host refuses to start, without naming a path. A real profile cannot qualify, because its folder is not in the temp folder and has no marker. `--init-lan-test-profile` still works on a folder that holds only that marker.

## Upgrading an existing profile (maintenance procedure)

Replace `<folder>` with the profile folder (the `--data-dir` the web host uses). The command always needs an explicit `--data-dir`; it has no default, and no environment variable can confirm, select migrations or skip a check.

1. **Build the new version in a separate checkout.** Do not rebuild the checkout the running host uses.
2. **Stop the old host.** The command takes the same folder lock the host holds and refuses (the folder is in use) while a host runs. It then asks SQLite for exclusive use of the file without waiting; if anything else has the file open it refuses with *in-use* ("Another program has this data open") and changes nothing.
3. **Start and stop the old version once** if it was ever killed or crashed. A non-empty `-wal` file next to the database means it was not closed cleanly, and the command refuses ("start and stop the current app version once"). Read "Hard #211 human cutover gate" below before any real migration.
4. **Take your own copy off this computer** of the whole data folder, and check you can open it. This is your independent safety net; the command's snapshot lives in the same folder.
5. **Run the command from the new build:**
   ```sh
   npm run db:migrate -- --data-dir <folder> --expect-from <old schema> --expect-to <new schema>
   ```
   On a terminal it prints the plan (versions and a row count per table, nothing else) and asks you to type the phrase `MIGRATE v<old> TO v<new>`. In a script pass `--confirm "MIGRATE v<old> TO v<new>"`; without a terminal and without `--confirm` it refuses.
6. **What it does.** It checks the data's integrity (`integrity_check`, `foreign_key_check`), fingerprints every table (column list, row count, SHA-256 of the rows in a fixed order), and writes a marker `data/maintenance/migration-in-progress.json`. It then writes a snapshot (`maintenance/<stamp>/snapshot-v<old>.sqlite`) and verifies it reads back identical, upgrades a copy of the snapshot (`staging.sqlite`), and checks every existing table still has exactly the same content in its old columns. Just before the swap it asks for exclusive use again and checks the live file is unchanged since the first look (same size and modification time, no `-wal`, same fingerprints); if not it stops with *changed-during-migration* and the live data is untouched. Only then does it move the live file to `maintenance/<stamp>/original-v<old>.sqlite` and put the upgraded copy in its place. It verifies the result (including that the moved original is still exactly what was swapped out, with no `-wal`; and, by content, that it opens read-only, passes the integrity check and has the same fingerprints as the source read in step 5. If either check fails it keeps the in-progress marker so startup refuses with *verify-failed*, and renames back, repairs and deletes nothing: the original, the snapshot and the migrated file all stay for the recovery steps below), makes sure the profile marker exists (*marker-unwritable* if it cannot be written, see above), writes `migration.json` (local only: it holds fingerprints, which are digests and counts, not content) and removes the marker.
7. **Check, then start the new host.** The folder now opens with the new build. Keep `maintenance/<stamp>/` until you are satisfied; it is never deleted automatically.

If any check fails before the swap the live file is byte-for-byte what it was, the snapshot is kept, and the marker is removed. Read the message; it carries a code, not a path.

### Reverting

```sh
npm run db:revert-migration -- --data-dir <folder>
```

It shows the plan and asks for `REVERT v<new> TO v<old>` (or pass `--confirm`). It moves the migrated database to `maintenance/<stamp>/reverted-v<new>.sqlite`, copies the preserved original back (keeping it), and checks the result equals the fingerprints taken before the migration. **Use the previous app version afterwards:** the new build refuses the reverted data until it is migrated again.

A revert is **refused** (`changed-since-migration`) if anything was written to the migrated data after the migration: reverting would lose those changes. In that case do not force it. Stop, keep both files, and decide with the owner which data is wanted; a restore from a backup is the supported way to move data between versions.

## Recovery: an upgrade was interrupted

Start refuses with "A database upgrade was interrupted" when `data/maintenance/migration-in-progress.json` exists. This means the command (or the machine) stopped between taking the marker and finishing. Nothing was deleted.

1. Stop every copy of the app. Copy the whole data folder somewhere safe first.
2. Open `data/maintenance/<stamp>/` (the stamp is inside the marker). Look for `original-v<old>.sqlite`.
3. If `original-v<old>.sqlite` exists, the live file may be the half-finished new one or missing. Move any file named `tracing-guatemala.sqlite*` out of `data/` into a safe place, copy `original-v<old>.sqlite` to `data/tracing-guatemala.sqlite`, delete `migration-in-progress.json`, and start the **old** version. Then run the procedure again.
4. If there is no `original-v...` but `snapshot-v<old>.sqlite` exists, the live file was never swapped. Check that `data/tracing-guatemala.sqlite` is present and opens with the old version, then delete the marker.
5. If unsure, do not delete anything. Restore from your off-host copy.

## Recovery: a restore was interrupted

A restore moves the live file to `tracing-guatemala.sqlite.replaced-<id>` before putting the restored copy in place, and deletes it only after the restore is verified. Start refuses with "A restore was interrupted" if a `.replaced-*` file remains, whether or not a live file exists.

1. Stop every copy of the app and copy the whole data folder somewhere safe.
2. If `tracing-guatemala.sqlite` is **missing**: rename the `.replaced-<id>` file to `tracing-guatemala.sqlite`. That is the data from before the restore. Delete `tracing-guatemala.sqlite-wal` / `-shm` if present beside the missing file.
3. If `tracing-guatemala.sqlite` **exists**, decide which one you want. The restored one is the live file; the `.replaced-<id>` file is the data from before the restore (a verified copy is also in `data/pre-restore/`). Move the one you do not want out of the folder; do not leave a `.replaced-*` file in `data/`.
4. Start the app.

Other refusals: *missing database* (no database file, but the folder was used before or holds other data: see "First start versus missing data"), *not an app database*, *unreadable* (check permissions), and *wal-unreadable* (see above).

## Restoring a backup from an older version

Restore still works for an older backup. The backup file and the live file are never migrated in place: the backup is copied to a staging file in the data folder, the staging copy is upgraded, and only the verified staging copy is swapped in. The existing safety copy in `pre-restore/` is kept as before.

## Hard #211 human cutover gate

The folder lock and the SQLite exclusive-use probe are **evidence, not proof**. The lock is a PID file; the probe sees only connections that hold a lock at that moment. Neither can show that no other program has the file. Before migrating real data (only under #211, with the owner's go-ahead):

1. Stop the old host and **every other app or tool** that uses the folder (including a second host, a database browser, a sync or backup agent).
2. Confirm that no process has the database open. On Windows: Resource Monitor, CPU tab, Associated Handles, search for `tracing-guatemala.sqlite`. On macOS or Linux: `lsof` on the file.
3. Confirm that there is no `tracing-guatemala.sqlite-wal` file next to the database.
4. Never run the old and the new host at the same time.
5. Keep an **independently restore-verified copy off this computer** (restored somewhere else and opened). The snapshot under `maintenance/` is on the same disk and does not replace that copy.
6. `--confirm` is a typed phrase, **not the owner's approval**. The owner's approval is given in #211, separately.

Without all of these, nothing here may be described as a zero-loss or atomic cutover.

## Limits

- The folder lock is advisory and is only taken by web hosts and this command using this code. It does not stop another program, an older build or the Electron app from opening the same file. Electron uses a separate profile and never shares the web profile.
- The exclusive-use probe and the pre-swap re-check catch most overlapping use, but they are not proof: a program that opens the file only after the check, or that holds no lock at that instant (a rollback-journal connection between transactions), is not seen. On Windows the swap itself fails if another SQLite connection still holds the file; on macOS and Linux a rename succeeds while a file is open, which is why the moved original is checked afterwards.
- Startup reads a write-ahead log itself (never through SQLite) to learn the version, and fails closed if it cannot. The maintenance command opens the database read-only (only after refusing a non-empty `-wal`), which can create an empty `-shm`; it removes empty leftovers it created while holding the lock, and never when another connection holds the file.
- The command's snapshot, original and records are in the same folder as the data. They protect against a bad upgrade, not against losing the disk.
- A migration that changes existing columns (not just adds tables or columns) is refused by the content check. Such a migration needs its own reviewed procedure.
