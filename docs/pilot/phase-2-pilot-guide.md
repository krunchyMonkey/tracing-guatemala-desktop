# Phase 2 pilot guide (#21)

**Status:** Prepared. **NOT run.** No researcher feedback or approval has been recorded. The engineering rehearsal at the end of this page is automated evidence only; it is not the researcher's pilot. The sections for results and approval stay empty until the session happens.

**Who uses this:** the project owner runs the session; the researcher uses the app and gives feedback. Allow about 90 minutes: 30 for the fictional demo (Part 1) and 60 for her private Live workspace (Part 2).

**What is being validated:** the working Phase 2 defaults (case states, intake fields, the brief, journal, task deadlines, summary export, research hours, the Studio dashboard and the guided tour). They were chosen by the owner so that building could continue. **The researcher has not reviewed or approved any of them.** This session is where her review happens. The list of provisional defaults is in section 6.

**What is being piloted:** the **web client** running on her own computer (Live, loopback only). It is not a desktop installation pilot. The separate LAN demo uses fictional in-memory data only.

## 1. Before the session (project owner)

### 1.1 Pull requests and merge order

- [ ] Merge the main chain **in this order**, each one after the previous is on `main` (each PR is stacked on the one before it):
  **#118 → #121 → #122 → #123 → #124 → #125 → #126 → #128 → #129 → #130 → #131 → #132**
- [ ] These PRs are **not** in that chain. Each one targets its own base, so merge each separately:
  - **#119** (case lifecycle spec) and **#120** (case data model, stacked on #119): documentation.
  - **#127** (safe Demo/Live switching, stacked on #118).
  - **#113** (locked "Coming soon" navigation entries), based on `main`.
- [ ] On `main` after merging, from the project folder, with Node.js installed (section 2):

  ```sh
  npm ci
  npm run check          # lint, typecheck, unit tests, browser tests: must exit 0
  npm run web:build
  npm run smoke:live     # the Live readiness drill (#117)
  npm run pilot:rehearsal  # this pilot's engineering rehearsal (section 10)
  ```

  Record the exit codes and counts in section 10 if you re-run them.
- [ ] Decide the **pilot computer** (her own computer). Windows 11 is where this was built and drilled. macOS and Linux use the same code but have not been exercised.

### 1.2 Environment prerequisites

- [ ] **Node.js 22.12 or newer** (`engines` in `package.json`). There is no `.nvmrc`. Check with `node -v`.
- [ ] A current desktop browser (Chrome, Edge, Firefox or Safari). Use one browser for the whole session. Live uses a cookie tied to its port, so a private/incognito window works but is signed out when closed.
- [ ] `npm ci` has been run once in the project folder on the pilot computer.

### 1.3 How to start the apps

**Live (her private workspace).** Details and troubleshooting are in [Live readiness](../operations/live-readiness.md).

| OS | Start |
| --- | --- |
| Windows | Double-click **`Start Tracing Guatemala.cmd`** in the project folder |
| macOS / Linux | Run **`./start-tracing-guatemala.sh`** |
| Any | `npm run live` |

The window prints a private link and opens the browser on it. Keep the window open while working; **Ctrl+C** stops it. Restarting signs the browser out: open the new link.

**Fictional demo (Part 1).**

```sh
npm run demo:build
npm run demo:lan                # fictional data, in memory, trusted home network only
npm run demo:lan:feedback       # optional: adds sending feedback to a private GitHub Project
```

It prints a link such as `http://192.168.1.24:4173/#/clients`. Refreshing the page resets the demo. For `--host`/`--port` options and the private-Project setup, see [LAN browser preview](../demo/lan-preview.md). If the Project is not set up, the feedback form only offers **Copy feedback**, which is what Part 1 uses.

### 1.4 Privacy and backup checklist

Read [Local data, privacy and backups](../privacy-and-backup.md) and [Live readiness](../operations/live-readiness.md) together before any real information goes in. In particular:

- [ ] Live data lives only on this computer and the host listens on **127.0.0.1 only**. Nothing is uploaded and there is no analytics.
- [ ] The database, every backup and every safety copy are **not encrypted**. Turn on BitLocker (Windows) or FileVault (macOS) and use a strong sign-in password.
- [ ] Do the recovery drill once: create a backup, change something, restore it ([Live readiness: recovery drill](../operations/live-readiness.md)). Keep a copy of backups **off this computer** on an encrypted drive that only she uses. Never email backups.
- [ ] Settings & Backup shows "Last backup". Home shows a reminder when there is no backup or the last one is over 7 days old.
- [ ] The data folder is the default (`%APPDATA%\Tracing Guatemala Web\`), not a shared or synced folder.
- [ ] **Fictional first.** Real client information goes in only after the owner and the researcher have both confirmed the backup and security checks above and tick the real-use gate in Live readiness.
- [ ] The demo never receives real data, on any network. Feedback pasted anywhere public must be fictional.

## 2. Part 1: fictional demo walkthrough (researcher)

Start `npm run demo:lan` and open the link on the researcher's phone, tablet or computer. The page shows a "Demo Mode — Fictional Data Only" banner and starts with 48 made-up clients. Ask her to think aloud. Note where she hesitates, what she expects to happen, and anything she looks for and can't find. The owner should not explain a screen unless she is stuck for more than a minute.

| # | Task | What it checks |
| --- | --- | --- |
| 1 | Open **Home**. Say in your own words what the Studio dashboard tells you. What would you look at first each morning? | Dashboard usefulness, summary |
| 2 | Choose **Take a tour** and follow it to the end. Then restart it and leave it halfway. | Tour usefulness, wording |
| 3 | Open **Clients**. Find a client by part of their name, then filter. Open a profile. | Directory, profile, case list on the profile |
| 4 | From that client, open one of their cases. Read the overview and history. | Case model, state names, navigation |
| 5 | Read the **Brief**: objective, known facts, people, hypotheses, questions. Edit one section. | Brief sections, hypotheses kept apart from facts |
| 6 | Add a **journal** entry dated yesterday. Add one for today. | Journal, dates, newest-first order |
| 7 | Add two **tasks**, one with a deadline. Complete one. | Tasks and date-only deadlines |
| 8 | Move the case to the next state and back where allowed. Try to move it somewhere the app refuses. | State names, confirmations |
| 9 | Archive the case, find it again, reopen it. | Archive vs finished, visibility |
| 10 | Open **Research hours**. Add 1 hour 30 minutes by hand. Start the timer, pause, resume, stop and save. | Hours, activity types |
| 11 | **Export** the case summary. Open the downloaded file. Does it contain only this case and this client? | Summary and export |
| 12 | Choose **Send feedback**, write a short fictional comment and choose **Copy feedback**. Paste it into a text file. | Feedback path (copy only unless the private Project is set up) |
| 13 | Which locked sections in the sidebar (later phases) would you actually use first? | Navigation, roadmap |

The demo resets on refresh, so nothing she does here is kept. Backups, restarts and the real timer reconciliation are not available in the demo; those are Part 2.

## 3. Part 2: her private Live workspace (researcher)

Start Live (section 1.3). **Use fictional clients first.** Only after the owner confirms the backup and security checks (section 1.4) may she continue with a real client of her choice, and only if she agrees.

| # | Task | What it checks |
| --- | --- | --- |
| 1 | Add two new fictional clients, as if from Fiverr. | Client create (Phase 1) |
| 2 | Under one client, add **two cases**: give each a title, the requested outcome, an order reference and a due date. | Case intake fields, one client with many cases |
| 3 | Open the first case. Fill the **brief**: objective, facts, people, hypotheses, questions. | Brief |
| 4 | Add **journal entries** with different dates (back-dated two days, today). | Journal |
| 5 | Create three **tasks** (one overdue, one due this week, one with no date). Complete one, reopen it, complete it again. | Tasks, deadlines |
| 6 | Move the first case through the states, ending with it back at *Active*. Say what each name means to you. | State vocabulary, confirmations |
| 7 | **Archive** the second case. Look at Home and the client's profile: where did it go? **Reopen** it. | Archive and visibility |
| 8 | Add a **manual research-hours entry**. Start the **timer** on the first case, pause it, resume it, stop and save with an activity type and a note. | Research hours, activity types |
| 9 | Open the second client's case. Confirm nothing from the first client appears there (brief, journal, tasks, hours). | Isolation |
| 10 | **Export** the first case. Open the file. Is anything in it that should not be? Is anything missing that you would send a client? | Export |
| 11 | Open **Home**. Do the counts and lists match what you just did? | Studio summary |
| 12 | Settings & Backup: **create a backup**. Make one more change. **Restore** the backup. | Backup and restore |
| 13 | Close the Live window completely, start it again, and find your cases. | Persistence |
| 14 | Think about your last three Fiverr orders. Could you have run each one in this app? What would not fit? | Fit with real engagements |

### Timer suspend / restart check

The rehearsal (section 10) simulates "the host was away" by editing the saved heartbeat while the host is stopped. A real sleep cannot be simulated, so this check is **MANUAL**:

1. Start the timer on a fictional case and leave the page open.
2. Close the laptop lid (or put the computer to sleep) for at least 10 minutes. Alternatively close the Live window and start it again after 10 minutes.
3. Wake the computer and open the case. Expected: a "Review the time before saving" dialog saying nothing has been saved, offering only the time observed before the gap, and a timer pill reading *Needs review*. The gap is not counted unless she types it in.
4. Save a reviewed number of minutes (or discard). The timer disappears and one entry exists.

## 4. Questions to ask after the tasks

Use her own words where possible. Ask each question about the fictional case first, then about her real work.

| Area | Ask |
| --- | --- |
| **Model terminology** | Are *client*, *case*, *brief*, *journal*, *task* the words you would use? What do you call a client's order or project? |
| **Intake and closure states** | Are *Intake, Active, Waiting, Delivered, Closed* the states you move through? When is a case "done"? Is *Delivered* the same as *Closed*? What do you do when a client comes back? |
| **Visibility** | Where would you expect an archived or closed case to appear? Should closed cases hide from Home? Should an archived client's cases be visible? |
| **Navigation** | Could you find clients, cases, tasks and hours without help? What did you look for and not find? Are the locked later-phase entries helpful or distracting? |
| **Brief** | Do objective, known facts, people, hypotheses and questions match how you think about a case? Is anything missing? Is it clear a hypothesis is not an established fact? |
| **Journal** | Is a dated plain-text entry enough? Do you want activity labels? Is it separate enough from client messages? |
| **Deadlines** | Is a date-only deadline right (no time)? Do you want reminders? Case due date vs task due date: which do you use? |
| **Summary and export** | Is Markdown a useful format? What would you send a client? Do you need hours, a PDF, a different layout? Is the isolation (only this case and client) what you expect? |
| **Research hours** | Do you track hours today? Which activity types matter (the current five are research, correspondence, analysis, writing, other)? Is the timer or manual entry more useful? Is the 12-hour entry limit sensible? Do you need package or allowance tracking? |
| **Dashboard usefulness** | What do you look at first on Home? Is the right information there? Are the week and month hours useful? What is missing? |
| **Tour usefulness** | Did the tour help or interrupt? Would a new user need it? Which steps were unclear? |
| **Real Fiverr engagements** | Take your last three engagements. Which could you record end to end? Which workflow broke (revisions, delivery messages, multiple deliverables, packages, extras, refunds)? Record each unresolved workflow. |
| **Data safety** | Do the backup steps feel manageable? How often would you back up, and where to? Does the reminder help? Do you accept that data is not encrypted? |

## 5. Capturing feedback privately

- Capture feedback in **local notes** on her computer, or in the owner's **private GitHub Project** (the opt-in `npm run demo:lan:feedback` path adds draft items to a private Project, never repository issues).
- **Never** put feedback in public GitHub issues, pull requests or this repository if it could identify a client or contains real information.
- The only things that go in the public repository are **fictional summaries** and anonymised must-fix issues that describe the problem without client details.
- Link each must-fix or should-fix item to a new GitHub issue (fictional wording only) and fill in section 7.

## 6. Provisional defaults awaiting her decision

None of these are approved by the researcher. They are working defaults so building could continue.

| Default | Value | Source |
| --- | --- | --- |
| Case states | Intake, Active, Waiting, Delivered, Closed. Reopen goes to Active. "Delivered" means a result was sent. | `src/shared/case-model.ts` (`CASE_STATES`, `CASE_TRANSITIONS`); [Phase 2 spec](../phase-2-case-management-spec.md) |
| Allowed moves | intake to active, waiting or closed; active to waiting, delivered or closed; waiting to active, delivered or closed; delivered to active or closed; closed to active | `src/shared/case-model.ts` (`CASE_TRANSITIONS`) |
| Moves that ask first | intake to closed, active to delivered or closed, waiting to delivered or closed, delivered to active or closed, closed to active | `src/shared/case-model.ts` (`CONFIRMED_TRANSITIONS`) |
| Archive | Separate from progress; reversible; case is read-only while archived; a client must be restored before a new case is added | [Phase 2 spec](../phase-2-case-management-spec.md); `src/shared/case-model.ts` |
| Intake fields | Required: title. Optional: requested outcome (4,000 characters), order reference (100), due date. Title up to 160 characters | `src/shared/case-model.ts` (`CASE_TITLE_MAX`, `CASE_GOAL_MAX`, `ORDER_REFERENCE_MAX`) |
| Brief | Five sections: objective (4,000), known facts, people, hypotheses, questions (10,000 each) | `src/shared/case-brief.ts` |
| Journal | Date/time plus plain text up to 10,000 characters; newest first; future dates refused; optional activity label | `src/shared/case-journal.ts` |
| Task deadlines | Date only (no time), local calendar date; title 160, description 2,000 characters; no reminders | `src/shared/case-tasks.ts`; [Phase 2 spec](../phase-2-case-management-spec.md) |
| Activity types | research, correspondence, analysis, writing, other (optional per entry) | `src/shared/case-time.ts` (`ACTIVITY_TYPES`); [case-research-hours.md](../case-research-hours.md) |
| Entry size | 1 to 720 minutes (12 hours) per entry; notes up to 500 characters | `src/shared/case-time.ts` (`TIME_MIN_MINUTES`, `TIME_MAX_MINUTES`, `TIME_NOTE_MAX`) |
| Timer cap | A timer past 12 hours is flagged for review | `src/shared/case-time.ts` (`TIMER_MAX_SECONDS`) |
| Heartbeat | The open page reports every 30 seconds; a heartbeat older than 5 minutes flags the timer for review, and only the observed time is suggested | `src/shared/case-time.ts` (`HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_STALE_MS`) |
| Timer minimum | Under 30 seconds cannot be saved (discard instead); seconds round to the nearest minute; one timer at a time | `src/shared/case-time.ts` (`TIMER_MIN_SECONDS`); [case-research-hours.md](../case-research-hours.md) |
| Billing | No rates, allowances or revenue in Phase 2 | [case-research-hours.md](../case-research-hours.md) |
| Export | Markdown summary of one case, downloaded by the browser; hours are not in it | `src/shared/case-summary.ts`; PR #129 follow-ups |
| Dashboard | Up to 6 active cases, 8 tasks and 8 recent activities; "due soon" is today plus 7 days; archived clients and cases are excluded | `src/shared/studio-summary.ts` (`STUDIO_*` constants) |
| Backup reminder | Shown on Live Home when there is no backup or the last is over 7 days old | `src/renderer/src/runtime/useBackupStatus.ts` (`BACKUP_REMINDER_DAYS`) |
| Backup retention | Nothing is deleted automatically; suggested habit is last 5 plus one per month | [Live readiness: Retention](../operations/live-readiness.md) |
| Request size | A single request body is limited to 256 KB; uploaded backups to 512 MB. Users only meet this with very large pasted text | `src/server/live-host.ts` (`MAX_JSON_BYTES`); [web-first runtime](../architecture/web-first-runtime.md) |
| Real-data rule | No real client information until backup and security checks are confirmed | [Live readiness](../operations/live-readiness.md) |

Phase 1 client defaults (statuses, duplicate matching, note editing) are tracked separately in [client-data-model.md](../client-data-model.md).

## 7. Known limitations and follow-ups

Collected from the pull request descriptions. None of these block the pilot, but ask whether any matter to her.

- **Electron is frozen.** Cases, hours, the dashboard and export work only in the web client (Live) and the demo; the desktop app has no case screens or IPC for them (#19, #109).
- **Hours:** future work dates are not rejected. Archiving a case does not check for a running timer: the timer can still be discarded, but saving it returns *wrong-status*. Week and month totals are computed in the browser. Hours are not in the case summary export (the spec marks that optional). (#129)
- **Journal:** the case page's "Last updated" date refreshes on reload rather than right after a journal or brief save. The saved data is correct. (#124)
- **Dashboard:** the Active cases list does not mark a case whose own due date has passed. The metric tiles are not links and there is no filtered "overdue tasks" view. No automated contrast (axe) check yet. (#131)
- **Demo:** Settings still says backups exist "only in the desktop app". Only about half of the 48 fictional clients have notes and none have contact-log entries. (#127, #128, #130)
- **Tour and feedback:** the private Project is checked for privacy only at startup, not before each submission. No real GitHub submission has ever been made; the owner setup is in the LAN preview doc and marked "not yet performed". Optional screenshots for the tour were not captured. (#132)
- **Unencrypted data.** The database and backups are plain files; disk encryption is the protection (section 1.4).
- **Not exercised:** macOS and Linux, a real second-device check of the LAN demo, and a real laptop sleep with a running timer (section 3).
- **The researcher's definitions are unknown:** case state vocabulary, required intake fields, when a case is complete, which activities count as research time, export format and journal naming (section 6).

## 8. Feedback record

*Fill in during or right after the session. Link each must-fix or should-fix item to a new GitHub issue. Fictional data only in issues: describe problems without real client details.*

| # | Observation (her words where possible) | Task / question | Severity (must-fix / should-fix / later) | Issue |
| --- | --- | --- | --- | --- |
| | | | | |

Must-fix items are fixed and re-checked with her before sign-off.

### Results of the session

*Leave blank until the session happens.*

- Date of session:
- Computer, OS and browser used:
- Part 1 (fictional demo) completed: ☐ yes ☐ partly
- Part 2 (private Live workspace) completed: ☐ yes ☐ partly
- Timer suspend / restart check result:
- Unresolved Fiverr workflows:

## 9. Approval record

*Leave blank until the researcher has used the app and decided. Do not fill in on her behalf.*

- Real client information approved for entry: ☐ yes ☐ not yet
- Researcher's decision: ☐ Approved for Phase 2 ☐ Approved after the must-fix issues listed above ☐ Not approved (blockers below)
- Remaining blockers, if any:
- Recorded by:

> **Do not close #21 until** the researcher has actually completed both parts, her feedback is recorded privately, every must-fix issue is filed and resolved, and her approval or rejection is written above. Documentation and the engineering rehearsal below are not acceptance.

## 10. Rehearsal results (engineering, 2026-10-30)

This is **engineering evidence only**, produced by `npm run pilot:rehearsal` ([`scripts/pilot-rehearsal.mjs`](../../scripts/pilot-rehearsal.mjs)). It drives the built Live host over HTTP in the same way the browser does (launch link, session cookie, CSRF token), with fictional data in throwaway folders. It is **not** the researcher's pilot and says nothing about whether she accepts the model, wording or screens.

Run on the branch `docs/21-pilot-kit` (stacked on the Phase 2 chain up to #102), Windows 11, Node 25.0.0:

- **23 passed, 0 failed, 3 manual.** Exit code 0.
- Covered automatically: two clients and three cases (two under one client); brief; dated journal; tasks created, completed, reopened; state moves and a refused move; archive and reopen with the Studio count and read-only checks; manual hours and invalid entries refused; timer start, pause, resume, stop and save across a host restart; timer reconciliation after the host was away (comes back *needs review*, only the observed 3 minutes suggested, nothing saved before review); the data a case export reads contains only that case and its client; cross-client isolation of brief, journal, tasks and hours; Studio summary counts and hours match what was created; backup, a change, restore, restart; a version 2 (clients and notes only) database upgraded with clients intact, case tables present and a pre-migration copy kept; security probes (foreign Origin gives 403; non-loopback Host headers give 421; missing or wrong CSRF token gives 403; no LAN address answers).
- Note on Host: Live answers only to `127.0.0.1:<port>` (`src/server/access.ts`). `localhost:<port>` is refused too, because `localhost` is the fictional demo's site (#114) and cookies are not scoped by port. A LAN IP, another name or another port is refused.
- **Marked MANUAL (not automated):** the browser walkthrough of the scenario (Part 2); opening the LAN demo from a second device; the timer with a real computer sleep (section 3).
- Not checked by the script: the Markdown text of the export itself (covered by `tests/unit/case-summary.test.ts` and `tests/web/live-case-export.spec.ts`); only the data it reads is checked for scope.
- No product bugs were found by the rehearsal.
