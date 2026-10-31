# Research notebook architecture

Status: contracts and ports (#146) storage (#147: migration 8, `NotebookRepository`, host API, demo adapter), the notebook screens with the Tiptap editor (#148, see "Notebook screens and the Tiptap adapter"), and resilient autosave, history and the case workflow bridge (#149, see "Autosave, conflicts, history and the case bridge"). Product scope is in [phase-3-research-notebook-spec.md](../phase-3-research-notebook-spec.md).

The aim: the page content the researcher writes is owned by this app, in a small versioned format, and any editor or canvas library is a replaceable part that only renders and edits it.

## Domain model

Types and rules live in `src/shared/notebook.ts` (no Node imports, so the host and the browser share them).

- A **notebook** belongs to exactly one research case. The case owns client isolation: every section, page and revision carries its `caseId`, and the host checks it against the case before any read or write.
- A notebook has ordered **sections**; a section has ordered **pages** (`position`, see `compareByPosition` and `moveItem`). Sections and pages carry an `archivedAt` timestamp for archiving.
- A **page** has a `title`, a `version` (increments on each saved change, to detect stale writes) and `content`, which is always `NoteContent`.
- A **page revision** is a saved earlier state of a page (`autosave`, `restore-point`, `restored`).
- Titles: `checkNotebookTitle` (trimmed, required, 80 characters for sections, 120 for pages, no control characters). Issues carry a field and a code, never the submitted text.

## Storage and host API (#147)

- Migration 8 (`research_notebooks`, forward-only, STRICT): `case_notebooks` (one per case, created by the first section), `notebook_sections`, `notebook_pages` (with `version`, `content` JSON up to 1 MiB and `content_version`) and `notebook_page_revisions` (append-only). Triggers keep every row in its case and client (a page can only move between sections of its case), forbid deletes and key changes, and make revisions append-only.
- `src/main/database/notebook-repository.ts` documents the rules. Writes run in one `BEGIN IMMEDIATE` transaction with the check order: case not found, case or client archived (`wrong-status`), target belongs to the case (`not-found`), archived target (`wrong-status`), input (`invalid`). Reads work on archived cases. Archived sections and pages are read-only until unarchived. Limits: 100 sections per notebook, 500 pages per section (`invalid` with a `too-many` issue).
- Saves carry the `baseVersion` they started from. A stale one is refused with `conflict` and the current page; identical content is a no-op. An `autosave` revision is kept when a page has none or its newest is at least 5 minutes old (`shouldSnapshot`). `restoreRevision` keeps a `restore-point` of the current content, then writes the old content as a new version with a `restored` revision. Renaming and moving never change the version.
- Calls (`caseContracts`, remote-callable like the journal): `getNotebook`, `create/rename/move/archive/unarchiveNotebookSection`, `create/get/rename/move/archive/unarchiveNotebookPage`, `saveNotebookPage`, `listPageRevisions`, `getPageRevision`, `restorePageRevision`. The zod schema of `NoteContent` is structural with raw bounds; `checkNoteContent` stays authoritative. The Live host's JSON body limit is 1 MiB for a full page.
- The browser demo (`demoNotebook.ts`) follows the same rules in memory; `tests/unit/demo-notebook.test.ts` runs one script against both and compares the answers.

## tg-note/1: page content

`src/shared/note-content.ts`. A document is `{ format: 'tg-note', version: 1, blocks: [...] }`.

- Blocks: `paragraph`, `heading` (level 1-3), `bullet`, `numbered`, `check`, `divider`, and `reference`. Every block has a lowercase UUID `id`. List-like blocks and paragraphs have an `indent` of 0-6. Nesting is by indent number, not by a tree, so every block is independently addressable (the canvas relies on that).
- A `reference` block links to an existing case record (`journal`, `task` or `time` plus its id). It is a link, never a copy: the record stays the single source of truth.
- Text is a list of runs: `{ text, marks?, href? }`. Marks are `bold`, `italic`, `underline`, `strike`, `code`. A link is `http:`, `https:` or `mailto:` only. Text may contain `\n` (hard break) and `\t`; any other control character is invalid.
- Limits: 5,000 blocks; 500 runs and 20,000 characters per block; 200,000 characters per page; 2,048 characters per link.
- **Canonical form**: marks deduplicated and in a fixed order, no empty `marks` or `href`, adjacent runs with the same marks and link merged, empty runs dropped. `checkNoteContent` returns a canonical copy; `serializeNoteContent` writes keys in a fixed order, so equal content gives equal JSON.
- `checkNoteContent(raw)` is the strict check for untrusted input (the host, imports). It rejects unknown keys, unknown block types, a wrong format or version, bad or duplicate ids, unsafe links and anything over the limits. Issues carry `{ code, blockIndex? }` only.
- `normalizeNoteContent(content, newId)` is for editors: it repairs ids (the first occurrence keeps its id) and canonicalizes runs, without enforcing limits.
- Export: `noteContentToMarkdown` and `noteContentToPlainText` (references print as `[Journal entry]`, `[Task]`, `[Research hours entry]` or the label from `describe()`). Markdown text is escaped, so HTML-looking text stays text.

**HTML is never stored or rendered from note content.** No field holds markup, adapters put text in with `textContent`/`value` (or their library's text APIs), and export escapes. A link is the only thing that reaches an attribute, and only after the scheme check.

## tg-canvas/1: canvas scene (Release B)

`src/shared/notebook-canvas.ts`. Contract and validation only; no canvas is built yet.

A `CanvasScene` (`{ format: 'tg-canvas', version: 1, id, pageId, elements, edges, ink }`) arranges **references** to canonical blocks: a `CanvasElementRef` holds a `blockId` and a position, size and `z`, never a text copy. `CanvasEdge` connects two element ids. `InkLayer`s hold `InkStroke`s (pen or highlighter, `#rrggbb`, width, `[x, y, pressure]` points) in an app-owned model. `checkCanvasScene` checks finite numbers and bounds, unique ids, that edge ends exist, and limits.

If a canvas library ever needs its own scene state for full fidelity, that goes in a separately versioned adapter payload (with its own provider name and schema version, migration and portable export), next to this scene and never instead of it.

## Ports

`src/renderer/src/notebook/ports.ts`. Screens depend only on these and on `shared/` types.

- `RichTextEditorAdapter.create(options)` returns a `RichTextEditorSession`. Options: the mount `element`, the `NoteContent`, `editable`, an accessible `label`, `newId`, `onChange` (every user edit; the app debounces and saves), `onStateChange`, `describeReference`.
- Session: `getContent()` (always normalized, valid), `setContent()` (replaces content, clears undo, does not call `onChange`), `setEditable`, `focus`, `run(command)`, `getState`, `refreshReferences()` (asks `describeReference` again for every reference block; no `onChange`), `destroy`. An optional `onReferenceActivate(ref)` option reports a click or Enter on a reference block.
- `EditorCommand`s: `toggleMark`, `setBlock`, `indent`, `outdent`, `setLink`, `insertDivider`, `insertReference`, `undo`, `redo`. `run` returns `true` when honored and `false` when the adapter cannot do it or the editor is read-only; it never throws for that.
- `CanvasSurfaceAdapter` / `CanvasSurfaceSession`: the same shape for a canvas (`scene`, `resolveBlock`, `onChange`; `getScene`, `setScene`, `setEditable`, `destroy`).

No port type mentions a vendor document, node or instance.

## Composition root and injection

- `notebook/NotebookAdapters.tsx`: `NotebookAdapters { editor, canvas | null }`, `NotebookAdaptersProvider` and `useNotebookAdapters()`.
- `notebook/adapters/index.ts`: the composition root, exporting `defaultNotebookAdapters`. It is the only place that names concrete adapters. Today: the Tiptap editor (`adapters/tiptap`) and no canvas. The plain-text editor stays as a fallback and test double.
- `App` takes an optional `notebookAdapters` prop (default `defaultNotebookAdapters`) and wraps its tree in the provider, so tests and entries can inject replacements.

## ESLint boundary

`eslint.config.mjs` enforces two rules.

1. Editor and canvas packages (`@tiptap/*`, `prosemirror-*`, `@excalidraw/*`, `excalidraw`, `lexical`, `@lexical/*`, `tldraw`, `@tldraw/*`, `slate`, `slate-*`, `quill`, `quill-*`) may only be imported under `src/renderer/src/notebook/adapters/**`. This covers `src/main`, `src/server`, `src/shared`, `src/preload` and the rest of the renderer.
2. A concrete adapter folder (`adapters/<provider>/**`) may only be imported from within `adapters/**`. Everything else goes through the composition root (`adapters/index.ts`). Tests may import adapters directly.

`tests/unit/notebook-boundary.test.ts` lints sample code with the real config to prove both. Dynamic `import()` and `require` of a vendor package are not covered by the rule; do not use them.

## Content migration

- Every stored document carries `format` and `version`. The page table also records the version in a column, so a migration can find old rows without parsing every document.
- Upgrades are **forward-only** and happen **on read**: `parseStoredNoteContent` reads `format` and `version`, runs `upgraders[version]` repeatedly until the version is current (each upgrader returns a document of a higher version), then validates with `checkNoteContent`. Unreadable content throws `NoteContentError('unreadable')`, content from a newer app throws `'too-new'` (the app must not open or overwrite it), and content that fails validation throws `'invalid'`. Messages never contain the content.
- To add v2: bump `NOTE_VERSION`, update the types and `checkNoteContent`, and add `upgraders[1] = (doc) => ...` in `note-content.ts`. Keep a fixture of a v1 document in the tests.
- An old page is rewritten as the current version on its next save (or by an optional host migration that also sets the column). SQLite schema migrations stay forward-only as in the rest of the app.
- `tg-canvas` follows the same rules (`parseStoredCanvasScene`).

## Adding or replacing an editor or canvas provider

1. Create `src/renderer/src/notebook/adapters/<provider>/` and implement `RichTextEditorAdapter` (or `CanvasSurfaceAdapter`) there. Import the library only inside this folder. Map the library's document to and from `NoteContent`; never leak its types through the ports, and never store its native document.
2. Render text only as text. Run any `href` through `isSafeHref`; render `describeReference` labels as text.
3. Run the contract against it: add a test next to `tests/renderer/notebook/EditorAdapters.test.tsx` calling `describeEditorAdapterContract('<provider>', () => adapter, driver)`, where `driver` says how to simulate typing in that library and whether marks are supported.
4. Change `defaultNotebookAdapters` in `adapters/index.ts` (the only line that names the provider).
5. Check that existing pages still load and export (round trip through `serializeNoteContent`/`parseStoredNoteContent`).

Test doubles: `tests/renderer/notebook/fakeEditorAdapter.ts` and `fakeCanvasAdapter.ts` implement the full contract in memory and let a test simulate a user edit.

## Notebook screens and the Tiptap adapter (#148)

- **Routes** (only where the runtime has cases): `cases/:caseId/notebook` and `cases/:caseId/notebook/:pageId`; the case page has a "Research notebook" card (`notebook/NotebookCard.tsx`) that links in. `NotebookScreen` loads the outline; `NotebookNav` lists sections (collapsible) and pages and offers create, rename, move up/down, move to another section, archive (with confirmation) and restore from an "Archived" disclosure. Moves are translated from the visible (active) order to the host's index among all siblings (`notebookModel.stepIndex`). Under 1024px the list becomes a "Pages" panel; an archived case or client makes everything read-only.
- **Page editor** (`PageEditor.tsx`, `EditorToolbar.tsx`): the editor is created once and fed pages through `setContent`; the toolbar only knows `EditorCommand` and `EditorState`. Saving, recovery and conflicts are covered in the next section (#149).
- **Tiptap adapter** (`adapters/tiptap/`): vanilla `@tiptap/core`, exact-pinned 3.31.4 packages listed one by one (no starter kit, no `@tiptap/react`). `mapping.ts` converts the flat block list to nested ProseMirror lists and back (pure, unit-tested): list runs nest by `indent`, a skipped indent comes back one level at a time, extra paragraphs in a list item flatten to paragraph blocks, headings are levels 1-3, trailing empty paragraphs are dropped. `extensions.ts` holds the app's own parts: a `blockId` attribute (`data-block-id`) with a plugin that gives a new id to any node whose id is missing or repeated (the first holder keeps it), paragraph indent as the class `note-indent-N`, the `noteReference` block (its label, from `describeReference`, is set with `textContent`), and a checklist item without inline styles.
- **CSP**: production is `style-src 'self'` and `script-src 'self'`. The editor is created with `injectCSS: false`; its base rules and the notebook look are in `styles.css`. No extension renders a `style` attribute (Tiptap's stock task item sets one through CSSOM, so `NoteTaskItem` replaces it). `tests/web/live-notebook.spec.ts` fails on any CSP report.
- **Paste**: the schema is the defence: unknown elements and attributes are dropped, and images, scripts, frames and styles cannot be represented. A link keeps only an `href` that passes `isSafeHref` (http, https, mailto), does not open on a plain click (Ctrl/Cmd+click opens a new tab with `noopener`), and carries `rel="noopener noreferrer nofollow"`. `quietPastedHtml` removes active markup from the clipboard HTML first, because even parsing `<img onerror>` or `style=` in a detached document makes the browser report a CSP violation. Pasting never applies markdown (typing `**x**` formats, pasting it does not).
- **Tests**: the adapter runs `describeEditorAdapterContract` under jsdom (`tests/renderer/notebook/TiptapAdapter.test.tsx`, with a test-only `TiptapAdapterHooks` for selection and typing); the screens run against the fake adapter injected through `App`'s `notebookAdapters` prop (`tests/renderer/Notebook.test.tsx`); `tests/web/live-notebook.spec.ts` and `tests/demo/notebook.spec.ts` drive the real editor.

## Autosave, conflicts, history and the case bridge (#149)

### Drafts and autosave

- **One draft store per browser tab** (`notebook/draftStore.ts`, provided above the router by `DraftStoreContext.tsx`). Unsaved text lives there, not in the editor or in a screen, so it survives leaving the notebook, opening another case and coming back; saving carries on in the background while the app is open.
- **Drafts are in memory only.** Decision: real client notes are never written to `localStorage`, `sessionStorage`, IndexedDB or cookies, so there is no second copy of private research on the device outside the host's database. The cost is that closing or reloading the tab loses text that was not saved yet, so `beforeunload` asks first, but only while some page is unsaved or saving (and a failed save keeps retrying so that window is short).
- **Rules.** Saved 800 ms after the last edit, or at once when leaving the page. One save per page is in flight; edits made meanwhile are saved afterwards on the version the previous save returned. The host's answer decides the state:
  - network error, host error or a thrown call: the draft is kept, status "Not saved — retrying", retried after 1 s, 2 s, 5 s, 10 s, then every 30 s, plus a manual "Retry now";
  - `invalid`: "Couldn't save: …" with the issue code mapped to plain words (never the code, never the text); not retried until the text changes or the person presses "Try saving again";
  - `wrong-status` / `not-found`: the page turns read-only with a notice; the text stays on screen and can be copied;
  - `conflict`: autosave for that page pauses (below).
- **Status line** (`aria-live`): "Saving…", "Saved at 14:05" (local time), "Not saved — retrying". When other pages still hold unsaved text, the sidebar shows "N pages not saved yet" (a link to the first one). Returning to a page that has a draft shows the draft and its status, not the server copy.

### Conflicts

A save carries the `baseVersion` it started from. If another tab or device saved first the host answers `conflict` with its current page. The page then goes read-only and shows "This page was changed in another window." with three actions; nothing is overwritten without a choice:

- **Keep my version** re-saves the draft on top of the host's current version with `keepPrevious: true`: when that save changes the content, the repository (and the demo) first append a `restore-point` revision holding the other window's content, so it stays in the history. The flag is kept until a keep-mine save succeeds.
- **Use the saved version** drops the draft and shows the host's page.
- **Copy my text** copies `noteContentToPlainText` of the draft to the clipboard; available before choosing.

`PageSave` gained the optional strict boolean `keepPrevious`; identical content is still a no-op and creates no revision.

### History

The page header's **History** button opens a dialog listing `listPageRevisions` (local date and time, "Autosave", "Before restore" or "Restored", version). Choosing one previews it in `NoteContentView`, a read-only renderer made only of React elements (no `innerHTML`; links only for safe addresses, with `rel="noopener noreferrer nofollow"`; references show the same labels as the editor). "Restore this version" asks first, then calls `restorePageRevision` with the page's current base version and the editor shows the restored content. It is disabled while the page has unsaved text (explained in the dialog) and on archived pages. If the page changed elsewhere meanwhile, nothing is restored: the dialog says so and the page shows the host's current version (there is no local draft to keep when restoring is allowed).

### Workflow bridge: links, never copies

- **Link record** (toolbar) lists this case's journal entries, tasks and research-hours entries with a filter and inserts `insertReference`. The screen loads those records (`useCaseRecords`) to label references: "Task · Order microfilm (pending)", "Journal · 12 Oct 2026 · Archive search", "Hours · 1 h 30 m on 12 Oct 2026", or "Linked record not available". Labels that arrive after a block was shown are pushed with the session's `refreshReferences()`. Adapters render labels as text only. Activating a reference (click or Enter; `onReferenceActivate` option) opens the case screen and scrolls to the record (cards carry ids `task-<id>`, `journal-<id>`, `time-<id>`).
- **Create task from selection** and **Add to journal from selection** open a dialog prefilled with the selected text (the same limits as the task and journal forms: `checkCaseTask`, `checkJournalEntry`; the journal time defaults to now). Nothing is created until the person presses Create task / Add to journal; then a reference to the new record is inserted after the selection and a confirmation is shown. Notes are never converted automatically.
- **Research hours**: a compact control in the notebook header over the existing `TimerContext` (start, pause, resume; stopping opens the existing "Save this time?" dialog). No timer logic is duplicated.
- An archived case or client hides all bridge actions and the timer control.
- `insertReference` inserts after the block holding the selection's end (an empty paragraph under the caret is used up), so selected text is never replaced or split.

## Releases

- **Release A** (#146-#149): this contract, then storage (#147), the rich-text scratchpad and navigation (#148), and autosave with the case workflow bridge (#149). The plain-text adapter is the fallback; Tiptap (#148) is the default; a richer or different provider is added as `adapters/<provider>/` and switched in the composition root once it passes the contract.
- **Release B** (#150-#152): the linked canvas, pen and touch ink, and focus interactions, built on `tg-canvas/1` and a `CanvasSurfaceAdapter` (element references to blocks, edges, app-owned ink).
- **Release C** (#153-#155): the deterministic recap engine, its review and export, and notebook search. These read `NoteContent` (for example through `noteContentToPlainText`), never an editor's document.
- **Release D** (#156-#157): backup, security and regression tests, and the researcher pilot. No handwritten-text recognition is claimed.
