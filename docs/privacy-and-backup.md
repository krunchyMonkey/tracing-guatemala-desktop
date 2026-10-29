# Local data, privacy and backups (Phase 1)

How Tracing Guatemala Desktop stores client information, what a backup contains, and what the app does not protect against. Written for the project owner and the researcher before any real client information is entered (#11, #12).

## Where the data lives

- All clients, notes and contact entries are in one SQLite database on this computer, in the signed-in user's app data folder:
  - Windows: `%APPDATA%\Tracing Guatemala\data\tracing-guatemala.sqlite`
  - macOS: `~/Library/Application Support/Tracing Guatemala/data/`
  - Linux: `~/.config/Tracing Guatemala/data/`
- The folder belongs to the user's operating-system account. Other people who sign in to the computer with **their own** account cannot read it under normal permissions. Anyone who signs in as the researcher, or has administrator rights, can.
- **The database is not encrypted.** Protect the computer with a strong account password and full-disk encryption (BitLocker on Windows, FileVault on macOS).
- The app never stores data in its install folder or in the source repository.

## What never leaves the computer

- The app makes **no network requests**. A request filter blocks all outgoing traffic, including from the main process, and the security tests check this on every build.
- There is no cloud sync, telemetry, crash reporting, analytics or AI processing.
- No message is ever sent to a client. The contact log is a record that the researcher types by hand.
- Logs and error messages never contain client names, contact details, notes or file paths, only the type of error.

## Backups

- **Settings & Backup → Create backup…** asks where to save, then writes one file, by default `Tracing Guatemala backup YYYY-MM-DD.tgbackup`. It contains every client, note and contact entry.
- Each backup is checked after it is written, and the app reports how many clients and notes it contains.
- **Backups are not encrypted.** Treat a backup file like the client records themselves:
  - Keep it on a drive only the researcher uses.
  - Do not email it, and do not put it in a shared or public folder.
  - If it goes to a cloud drive, that is the researcher's own choice and outside the app.
- Make a backup regularly and before installing a new version.

## Restore

- **Settings & Backup → Restore from backup…** asks for a file, and checks it before anything changes. It must:
  - be a Tracing Guatemala backup (an SQLite file with the app's identifier);
  - be undamaged (SQLite integrity check);
  - come from this app version or an older one. Backups from a newer version are refused.
- The app then shows what the backup contains and asks for confirmation, because **restoring replaces everything currently in the app**.
- Before replacing anything, the app copies the current data to `data/pre-restore/` in the app data folder.
- The backup is restored from a copy, never directly. Older backups are upgraded to the current format first.
- If anything fails after the switch, the previous data is put back automatically and the app says so.

## Safety copies kept by the app

| Folder (inside the app data `data/` folder) | Written when | Purpose |
| --- | --- | --- |
| `pre-migration/` | A new app version upgrades the database format | Undo a failed or unwanted upgrade |
| `pre-restore/` | Just before a restore replaces the data | Undo a restore of the wrong backup |

These copies contain client information too, and they are not cleaned up automatically in Phase 1. To recover from one, ask for help: the app does not yet have a button to restore a safety copy.

## Deleting data

Phase 1 has no in-app deletion: clients are archived, never deleted (see `docs/client-data-model.md`, Q9). To remove all data from a computer, quit the app and delete the app data folder above, including its `pre-migration/` and `pre-restore/` folders, and any backup files made elsewhere. Whether the app needs a "permanently delete a client" feature (for example, when a client asks) is a question for the #12 pilot.

## Not covered in Phase 1

- Encryption of the database or backups.
- Automatic or scheduled backups.
- Restoring a single client from a backup (restore is all-or-nothing).
- Code signing: unsigned installers trigger an operating-system warning (see `docs/architecture/electron-foundation.md`).
