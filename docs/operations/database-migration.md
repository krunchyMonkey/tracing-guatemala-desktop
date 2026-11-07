# Database migration and recovery runbook

Status: engineering reference for issue #248. **Merging this to source is not production authorization.** Issue #211 owns the real cutover; nothing here may be run against real data without the owner's go-ahead there.

## Why startup refuses

A newer build used to upgrade any existing profile silently when it started. It no longer does. On start, before anything is created or opened for writing, the app looks at the profile (a plain read of the first 100 bytes of the database file; a write-ahead log is never opened at this point) and decides:

| Profile | What start does |
|---|---|
| New (no data folder, or an empty database file and no other data) | Creates the database at the latest schema. No snapshot is needed. |
| Same schema as this build | Opens it. |
| Older schema | Refuses: "This data is at schema vX; this version needs vY. Nothing was changed." |
| Newer schema | Refuses with the existing "saved by a newer version" message. |
| Leftovers or damage | Refuses and names the reason (below). Nothing is created, so a missing database can never be replaced by an empty one. |

Refusals never print a path or any stored content, and they change nothing.

## Fresh development and test profiles

A new folder is initialized by simply starting the app on it (`--data-dir <new folder>`); there is nothing to migrate. Automated tests build their own throwaway folders with fictional rows. When `TG_TEST_HOOKS=1` is set the web host additionally refuses to start on the default Live folder or the desktop folder (compared with and without following links). That check only ever refuses.

## Upgrading an existing profile (maintenance procedure)

Replace `<folder>` with the profile folder (the `--data-dir` the web host uses). The command always needs an explicit `--data-dir`; it has no default, and no environment variable can confirm, select migrations or skip a check.

1. **Build the new version in a separate checkout.** Do not rebuild the checkout the running host uses.
2. **Stop the old host.** The command takes the same folder lock the host holds and refuses (the folder is in use) while a host runs.
3. **Start and stop the old version once** if it was ever killed or crashed. A non-empty `-wal` file next to the database means it was not closed cleanly, and the command refuses ("start and stop the current app version once").
4. **Take your own copy off this computer** of the whole data folder, and check you can open it. This is your independent safety net; the command's snapshot lives in the same folder.
5. **Run the command from the new build:**
   ```sh
   npm run db:migrate -- --data-dir <folder> --expect-from <old schema> --expect-to <new schema>
   ```
   On a terminal it prints the plan (versions and a row count per table, nothing else) and asks you to type the phrase `MIGRATE v<old> TO v<new>`. In a script pass `--confirm "MIGRATE v<old> TO v<new>"`; without a terminal and without `--confirm` it refuses.
6. **What it does.** It checks the data's integrity (`integrity_check`, `foreign_key_check`), fingerprints every table (column list, row count, SHA-256 of the rows in a fixed order), and writes a marker `data/maintenance/migration-in-progress.json`. It then writes a snapshot (`maintenance/<stamp>/snapshot-v<old>.sqlite`) and verifies it reads back identical, upgrades a copy of the snapshot (`staging.sqlite`), and checks every existing table still has exactly the same content in its old columns. Only then does it move the live file to `maintenance/<stamp>/original-v<old>.sqlite` and put the upgraded copy in its place. It verifies the result, writes `migration.json` (local only: it holds fingerprints, which are digests and counts, not content) and removes the marker.
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

Other refusals: *missing database* (the folder has `pre-restore/`, `maintenance/` or other `.sqlite` files but no database file: find the right file in those folders or restore from a backup), *not an app database*, *unreadable* (check permissions), and *not closed cleanly* (a write-ahead log exists and the database header is too short to tell the version: start and stop the version that wrote it once).

## Restoring a backup from an older version

Restore still works for an older backup. The backup file and the live file are never migrated in place: the backup is copied to a staging file in the data folder, the staging copy is upgraded, and only the verified staging copy is swapped in. The existing safety copy in `pre-restore/` is kept as before.

## Limits

- The folder lock is advisory and is only taken by web hosts and this command using this code. It does not stop another program, an older build or the Electron app from opening the same file. Electron uses a separate profile and never shares the web profile.
- Startup never opens a write-ahead log to read the version; it relies on the header as a lower bound. The maintenance command opens the database read-only (only after refusing a non-empty `-wal`), which can create an empty `-shm`; it removes empty leftovers it created while holding the lock.
- The command's snapshot, original and records are in the same folder as the data. They protect against a bad upgrade, not against losing the disk.
- A migration that changes existing columns (not just adds tables or columns) is refused by the content check. Such a migration needs its own reviewed procedure.
