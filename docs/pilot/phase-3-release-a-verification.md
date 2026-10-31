# Phase 3 Release A: integrated verification (#145)

This is **engineering verification**. It shows that the Release A research notebook (#146 to #149) works end to end in the built Live web app, with fictional data only. It is **not researcher acceptance**: whether the notebook is comfortable and useful for real research is judged by the researcher in the pilot (#157), which is the acceptance gate.

Run it:

```
npm run web:build
npx playwright test --project=web-live live-notebook-release-a     # the journey
npx vitest run tests/renderer/NotebookReleaseA.test.tsx            # the editor replacement
npm run check                                                      # everything
```

Screenshots (fictional data, opt-in): `CAPTURE_SCREENSHOTS=1 npx playwright test --project=web-live live-notebook-release-a` writes to `docs/screenshots/release-a/` (notebook, history, case screen at 1280 and 768, and the Pages drawer at 768).

## Scenarios and the tests that cover them

The journey is one serial Playwright test, `Release A: one realistic journey from first notebook to backup, archive and the separate demo`, in `tests/web/live-notebook-release-a.spec.ts`. Each scenario is a named `test.step` in it. It runs its own Live host on port 4202 (`WEB_E2E_RELEASE_A_PORT`; the demo is on 4203) with two fictional clients, "Fictional Client Alpha" and "Fictional Client Beta", one case each.

| # | Scenario | Automated test (file, step) |
|---|----------|------------------------------|
| 1 | Create a notebook from the case screen; 3 sections and 6 pages | `live-notebook-release-a.spec.ts`, step "1. create a notebook with 3 sections and 6 pages from the case screen" |
| 2 | Write and format in the real editor (heading, bold, italic, nested bullets, numbered list, ticked checklist item, link to https://example.org, divider) | same file, step "2. write and format notes in the real editor" |
| 3 | Reorder pages and sections, move a page to another section, rename, reopen and compare | same file, step "3. reorder pages and sections, move a page to another section, rename; reopen and compare" |
| 4 | Reload the browser and restart the host: outline, order and formatting intact | same file, step "4. reload the browser and restart the host: outline, order and formatting survive" |
| 5 | Revision recovery: History, restore an earlier version, the pre-restore version is in the history | same file, step "5. history: restore an earlier version; the pre-restore version is itself in the history" (see the note below) |
| 6 | Save failure: "Not saved", text kept across page switches, "Saved at" after unblocking, reload confirms | same file, step "6. a failed save keeps the text, says "Not saved", and recovers by itself" |
| 7 | Second tab edits the same page: conflict banner, Keep my version, the other version is in the history | same file, step "7. a second tab edits the same page: conflict banner, Keep my version, the other version is in the history" |
| 8 | Bridge: link a journal entry and a task, create a task from a selection (explicit confirm), each record once on the case screen, labels follow edits (a link, not a copy) | same file, step "8. bridge: link a journal entry and a task, create a task from a selection; records are never copied" |
| 9 | Isolation: Beta's notebook is separate; Alpha's page ids are not found through Beta, in the app and through the HTTP API, and nothing changes | same file, step "9. isolation: Beta has its own notebook; Alpha page ids are not reachable through Beta" |
| 10 | Backup, change the notebook, restore: content matches the backup | same file, step "10. backup, change the notebook, restore: the notebook matches the backup" |
| 11 | Archived case: notebook read-only (also at the API); unarchive: editable again | same file, step "11. an archived case makes the notebook read-only; unarchiving makes it editable again" |
| 12 | Demo separation: the Live-linked demo shows only its seeded notebook; the demo build has no Live API path | same file, step "12. the fictional demo shows only its own seeded notebook, and its build has no Live API path" |
| 13 | Regression smoke: clients, client profile, cases list, case screen (brief, journal, next steps, hours, notebook cards), Settings & Backup, notebook; no sideways scrolling at 1280 and 768 | same file, step "13. regression smoke: clients, profile, cases, case screen, Settings & Backup at 1280 and 768" |
| 14 | No CSP violations or uncaught page errors in the whole journey | same file, step "14. no content security policy violations or page errors in the whole journey" |
| 15 | A replacement editor works with no domain or database change | `tests/renderer/NotebookReleaseA.test.tsx`: `the same notebook journey with the in-memory fake editor ...`, `... with the plain-text editor ...` and `replacing the editor > stores identical content, outline and history whichever editor wrote it` |

Note on scenario 5: the host keeps an automatic snapshot at most every 5 minutes (`shouldSnapshot`), which an end-to-end test cannot wait for. The journey therefore spans the snapshot every page gets on its first save and the "Before restore" and "Restored" entries that a restore creates (and, in scenario 7, the "Before restore" entry that Keep my version creates). The 5 minute rule itself is covered by the unit tests (`tests/unit/notebook.test.ts` and the host/demo parity test `tests/unit/demo-notebook.test.ts`).

Deeper coverage of the same areas lives in the Release A feature tests: `tests/web/live-notebook.spec.ts`, `tests/web/live-notebook-autosave.spec.ts`, `tests/web/live-mode-switch.spec.ts`, `tests/demo/notebook.spec.ts`, `tests/renderer/Notebook.test.tsx`, `tests/renderer/NotebookAutosave.test.tsx` and `tests/renderer/notebook/*`.

## Owner and researcher manual checklist

Automation cannot judge these. Every line is **NOT RUN**. Run them on real hardware, with a fictional case first, before the researcher pilot (#157).

| # | Check | Status |
|---|-------|--------|
| M1 | Writing comfort: write a page of notes (headings, lists, a checklist) at normal typing speed. Nothing lags, jumps or surprises; the toolbar is where you expect it. | NOT RUN |
| M2 | OneNote familiarity: does the section and page list feel like a OneNote notebook to someone who knows OneNote? Are the words ("Research notes", "Pages", "History") clear without explanation? | NOT RUN |
| M3 | Tablet touch feel, on a real tablet: the Pages drawer opens and closes easily, toolbar buttons are easy to hit with a finger, the on-screen keyboard does not hide the text being typed, scrolling the page does not move the text by accident. | NOT RUN |
| M4 | Recovery confidence: after restoring an older version in History, would you trust that nothing was lost? Is the "Before restore" entry easy to find? | NOT RUN |
| M5 | Not-saved clarity: with the Wi-Fi or the host turned off for a minute, is "Not saved, retrying" noticeable and calming, and does the text come back to "Saved" when it returns? | NOT RUN |
| M6 | Linking records: does "Link record" and "Create task from selection" match how you think about tasks and journal entries? Is it clear that nothing is created until you confirm? | NOT RUN |
| M7 | Two windows: open the same page on two devices and edit both. Is the "changed in another window" message understandable, and do you know which button to press? | NOT RUN |
| M8 | Demo: the fictional demo is clearly not your real data and its notebook is not confused with the Live one. | NOT RUN |

Record findings as issues. Passing the automated journey above, or all of this list, does not replace the researcher's acceptance in #157.
