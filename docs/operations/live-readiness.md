# Live readiness: daily launch, backup and recovery (#117)

How to start, stop, back up and recover the Live web app on the researcher's computer, what is protected and what is not, and what must be true before real client information goes in. Nothing here is approval from the researcher: the **Real-use release gate** at the end is for the project owner and the researcher (#21) to tick.

> **Pilot operating system:** still to be confirmed with the researcher (#12 / #21). Windows 11 is where this was built and drilled; macOS is supported by the same code and scripts but has **not** been exercised on a Mac yet. Linux works the same way and is not a pilot target.

## Start and stop

Requires Node.js 22.12 or newer on the computer. The first start builds the app (about a minute; `npm install` must have been run once in the project folder).

| OS | Start | What happens |
| --- | --- | --- |
| Windows | Double-click **`Start Tracing Guatemala.cmd`** in the project folder | Checks Node.js, builds the app only if it has never been built, starts the host and opens your browser on the private link. A window stays open. |
| macOS / Linux | Run **`./start-tracing-guatemala.sh`** (or double-click it in a file manager set to run scripts) | Same. The file has the executable bit set. |
| Any | `npm run live` (extra options pass through: `npm run live -- --port 4200`) | Same, from a terminal. |
| Any | `npm run web:local` | Starts the host without opening the browser; copy the printed link yourself. |

**Stop:** press **Ctrl+C** in the window, or close the window. Ctrl+C stops the host cleanly ("Tracing Guatemala stopped. Your data is saved."). On Windows, `cmd` may then ask "Terminate batch job (Y/N)?": answer Y. Closing the window ends the host at once; that is safe, because every change is committed to the database when it is saved. The next start notices the leftover lock file from a program that is no longer running and replaces it.

While the window is open, the private link signs in any browser **on this computer**. Restarting the host signs every browser out; the page says so and nothing is lost. Open the new link printed in the window.

If it does not start, the window explains why and stays open:

- *Already running with this data*: use the window that is already open, or stop it first.
- *Port 4180 is in use*: stop the other program or start with `--port <n>`.
- *Saved by a newer version of Tracing Guatemala*: nothing was changed; use the newer version.

The browser is opened only after a successful start. If it cannot be opened, the link printed in the window still works.

`--open` is what the launchers add to `web:local`. It runs the operating system's own "open this link" command (`rundll32 url.dll,FileProtocolHandler` on Windows, `open` on macOS, `xdg-open` on Linux) without a shell, and only for a link beginning `http://127.0.0.1:` that the host itself made.

## Where the data lives

| Item | Windows | macOS |
| --- | --- | --- |
| Data folder | `%APPDATA%\Tracing Guatemala Web\` | `~/Library/Application Support/Tracing Guatemala Web/` |
| Database | `data\tracing-guatemala.sqlite` (plus `-wal`/`-shm` while running) | `data/tracing-guatemala.sqlite` |
| Safety copies | `data\pre-migration\`, `data\pre-restore\` | same |
| Backups made by the app | `backups\` | `backups/` |
| Backup status | `backup-status.json` | `backup-status.json` |
| Other | `uploads\` (temporary, emptied at start), `web-host.lock` | same |

Override with `--data-dir <folder>` or `TG_WEB_DATA_DIR`. The desktop app's folder (`Tracing Guatemala`, without "Web") is refused.

**Permissions.** On macOS and Linux the host sets the data folder, `backups/` and `uploads/` to mode `0700` (owner only), also when they already exist. On Windows it changes nothing: the folder is inside the signed-in user's AppData, whose inherited permissions already limit it to that user and administrators. A `--data-dir` outside AppData (for example a shared or synced folder) does not get that protection on Windows; do not use one for real data.

## Backups

- **Settings & Backup → Create backup…** makes a backup, **checks it**, keeps a copy in the app's `backups\` folder and downloads another through the browser. Files are named `Tracing Guatemala backup YYYY-MM-DD HH-MM-SS.tgbackup` in local time.
- Only after the backup has been written and verified does the host record it in `backup-status.json` (written to a temporary file, then renamed, so it is never half-written). A failed backup leaves the previous status alone, and an unreadable status file just means "unknown". The screen then says "No backup made yet" or "Backup status is unavailable"; it never says a backup exists when the host cannot show one.
- Settings shows **Last backup: <date and time> (N days ago)**, or "No backup made yet", and how many backups are in the `backups\` folder. The count follows the folder; the date is when the last verified backup was made, even if you later removed that file.
- **Reminder:** the Live Home screen shows a short note, not a pop-up, when there is no backup or the last one is more than 7 days old, linking to Settings & Backup. The demo and the desktop app never show it.
- The status describes backups **made**. A restore does not change it, and the status file sits outside the database folder, so a restore cannot replace it.
- Backups made in the desktop app (`.tgbackup`) can be restored into Live; older versions are migrated forward on restore (tested from schema version 2, the first with notes).

### Your data is not encrypted

The database, every backup and the safety copies are plain files. Anyone who can open them can read them.

- Keep the computer's disk encrypted: **BitLocker** on Windows (Pro/Enterprise; "Device encryption" on some Home PCs), **FileVault** on macOS. Use a strong sign-in password.
- Keep a copy of backups **off this computer**, on an encrypted drive that only the researcher uses. Never email backups or put them in a shared or public folder.
- The app does not encrypt files and does not upload anything.

### Retention (proposal, to confirm in #21)

**Nothing is ever deleted automatically**: not backups, not `pre-migration/`, not `pre-restore/`. Suggested habit: when there are newer backups, keep the **last 5 plus one per month**, and delete the rest yourself (including their off-computer copies). Safety copies in `data\pre-migration\` and `data\pre-restore\` can go once the upgrade or restore they protect has been confirmed good. Disk space is the only reason to prune; a client's request to erase their information is a separate question for the pilot (see `docs/privacy-and-backup.md`).

## Recovery drill: restore a backup

Do this once before real data goes in, and again after any big change to the app.

1. Start the app and note what is in it (how many clients; open one case).
2. **Settings & Backup → Create backup…** and wait for "Backup … made". Check "Last backup" now says today.
3. Change something (add a fictional client, edit a case).
4. **Restore from backup…** and choose the downloaded file (or the same file from `backups\`). The dialog shows its date and counts; read it.
5. Confirm **Replace with backup**. The app says the previous data was kept as a safety copy.
6. Check that the client list and the case match step 1 and that the change from step 3 is gone.
7. If it was the wrong backup: the data from just before the restore is in `data\pre-restore\` (a SQLite file named with the time). There is no button for it yet: ask for help rather than moving files by hand while the app is running.

If anything fails after the files are swapped, the app puts the previous data back and says so. A bad file (not a backup, damaged, or from a newer version) is refused before anything changes.

## Local session and access assumptions

- The host listens on **127.0.0.1 only**; there is no option for another address. Another device on the network cannot reach it.
- A browser is signed in only through the private launch link printed in the host's window. The link works for as long as that host runs.
- **Same-OS-user caveat:** loopback is not isolation between programs. Anything running as the same operating-system user can read the data folder, the window's output and the browser history (which includes the launch link until the host restarts). That is the same exposure as the desktop app. Use a separate OS account for any other person, and lock the screen.
- Plain HTTP on loopback is fine because nothing leaves the computer. Remote access is deliberately not supported (see `docs/architecture/web-first-runtime.md`).

## The desktop database is never opened

The Live host uses its own folder and refuses the desktop app's. To bring desktop data across, make a backup in the desktop app and restore it in Live; the desktop database is only ever read by the desktop app itself, and stays as it was.

## Readiness drill: `npm run smoke:live`

```sh
npm run web:build
npm run smoke:live
```

Runs against the **built** host with a throwaway data folder and a free port, entirely through HTTP, as a browser would: signs in through the launch link; creates two fictional clients with a case, brief, journal entry and task each; stops and restarts the host and checks nothing changed; checks that a second host on the same data refuses to start and does not open a browser; creates and downloads a backup and checks `getBackupStatus`; adds a third client and edits a case; uploads and restores the backup; checks the original state came back exactly (counts and every record) and that each case lists only its own journal and tasks; checks the status is unchanged and a safety copy of the pre-restore data exists; restarts once more. It exits non-zero on the first failure and deletes its folder. It never touches your real data folder.

**Latest result** (2026-10-30, Windows 11, Node 25.0.0, built from this branch):

```text
PASS  host started on 127.0.0.1 and the private launch link signs in
PASS  two clients created, each with a case, brief, journal entry and task; records stay with their own case
PASS  getBackupStatus says no backup has been made yet
PASS  after stopping and restarting the host, every client, case and record is exactly as it was
PASS  a second host on the same data refuses to start and does not open a browser
PASS  backup created and downloaded (102400 bytes), and a copy kept in the app backups folder
PASS  getBackupStatus reports this backup: recent date, its file name, count 1, no path
PASS  a third client was added and a case edited after the backup
PASS  the backup was uploaded and checked without changing any data
PASS  after the restore, counts and every record match the original state exactly; later changes are gone
PASS  after the restore, each case still lists only its own journal entries, tasks and brief
PASS  restoring did not change the backup status (it describes backups made)
PASS  the data from just before the restore was kept as a safety copy (Carla Ficticia is in it)
PASS  after one more restart, the restored data and the backup status are still there
```

On this machine the host was stopped with a hard kill (as closing the window does), so the restart steps also exercise stale-lock recovery. Not yet run on macOS.

## Real-use release gate (#21)

Real client information must not be entered until the researcher has confirmed each of these. These boxes are deliberately **unchecked**: nothing in this repository is the researcher's approval.

- [ ] The researcher's operating system is confirmed (Windows or macOS), and the launcher for it was tried on her computer.
- [ ] She started and stopped the app herself from the launcher, twice, including after a restart of the computer.
- [ ] She understands the window must stay open while she works, and that closing it is safe.
- [ ] The computer's disk is encrypted (BitLocker or FileVault), the account has a strong password, and the screen locks.
- [ ] She made a backup, saw "Last backup" show today, and found the file in the `backups` folder.
- [ ] She keeps a copy of backups off this computer on an encrypted drive that only she uses, and knows never to email them.
- [ ] She did the recovery drill above on fictional data and the restored data matched.
- [ ] She agreed (or changed) the retention habit: last 5 plus one per month, deleted by hand.
- [ ] `npm run smoke:live` passes on her computer.
- [ ] The Home reminder appeared when there was no backup, and went away after one.
- [ ] She knows who to ask for help if a restore or a start fails, and not to move files in the data folder while the app runs.
- [ ] She has read "Your data is not encrypted" in Settings & Backup and the same-OS-user caveat above, and accepts them.
- [ ] Open questions from the pilot (#12) about data deletion and encryption are answered or consciously deferred.
