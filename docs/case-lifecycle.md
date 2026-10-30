# Research case lifecycle and intake — provisional spec (#13)

**Version:** `case-lifecycle/v1` (2026-10-29)
**Status:** **Owner-authorized provisional engineering default.** Nothing here has been reviewed or approved by the researcher. Every state name, transition and field below is a reversible default chosen so Phase 2 can be built. Her feedback is collected at the integrated pilot (#21), and changes ship through later migrations. Don't cite this document as researcher approval.
**Inputs:** [Researcher workflow review](./researcher-workflow-review-2026-10-28.md) (confirmed current workflow), [client data model](./client-data-model.md) (`client-model/v1`), [Phase 2 plan](./phase-2-case-management-spec.md).
**Consumers:** #14 (schema and API contract), #15 (storage/API), #16 (screens), #17–#20, #109, #114–#116.

All examples are fictional.

## 1. What a research case is

A **research case** is one piece of genealogy work for one client: usually one Fiverr order or custom offer, with one research objective. A client (`client-model/v1`) is the person; a case is the engagement. One client can have many cases over time (repeat clients), and each case belongs to exactly one client, forever.

A case holds its own intake (title, the client's requested outcome, an optional order reference and due date). Later Phase 2 features attach a research brief (#17), journal (#18), tasks (#19) and hours (#109) to it. Client-level notes and the contact log (Phase 1, #9) stay on the client, and remain the place for communication.

## 2. Evidence vs. assumptions

| Topic | Confirmed (questionnaire, 2026-10-28) | Provisional default here |
| --- | --- | --- |
| How work starts | A Fiverr order arrives with a package, details and a deadline (step 1). | Creating a case is manual; there is no Fiverr import. The order number is an optional plain-text reference. |
| Intake material | Questionnaire, known people, goals, client documents (step 2). | The case keeps the **requested outcome in the client's words**. Known facts, hypotheses and questions arrive with #17; documents with Phase 3. |
| Repeat clients | Personalized Fiverr offers with adjusted package/price. | Each new order/offer is a **new case** under the same client. Price and package are not stored (deferred). |
| Delivery | Drafts and final deliverables are sent through Fiverr (step 10). | `delivered` records that the researcher sent something outside the app. The app never sends anything. |
| Late, cancelled, disputed work | None has happened yet; no process exists (unresolved question 9). | No special states. A case that ends without delivery is `closed`, and a journal entry (#18) can say why. |
| Multiple active orders per client | Unknown (unresolved question 3). | Allowed: any number of open cases per client. |
| Confirmation before actions | "Not sure" (unresolved question 7). | Confirm `delivered`, `closed`, reopening, and archiving a case. No case is ever hard-deleted. |

## 3. Lifecycle states

Progress state (`state`) is one of five values. **Archive is separate** (§5): it hides a case from day-to-day lists without changing its progress.

| State | Meaning (provisional) | Typical moment in the confirmed workflow |
| --- | --- | --- |
| `intake` | Recorded, but research hasn't started: reading the questionnaire, clarifying the objective. **New cases start here.** | Steps 1–3 |
| `active` | Research is in progress. | Steps 4–8 |
| `waiting` | Paused on someone else: client answers, a records request, an archive visit. | Any time after intake |
| `delivered` | The researcher sent a draft or final deliverable outside the app (e.g. through Fiverr). More work may follow (revisions). | Step 10 |
| `closed` | Administrative completion: no further work is expected, whether delivered or not. | After step 10, or when work stops |

"Open" means `intake`, `active` or `waiting`. "Finished" means `delivered` or `closed`. Dashboards (#116) and overdue checks (§6) use these groupings.

### 3.1 Transition matrix

Only the researcher changes state, explicitly; there are **no automatic transitions** (not from due dates, tasks or time). ✓ = allowed, ⚠ = allowed with confirmation, — = not allowed.

| from \ to | intake | active | waiting | delivered | closed |
| --- | --- | --- | --- | --- | --- |
| **intake** | — | ✓ | ✓ | — | ⚠ |
| **active** | — | — | ✓ | ⚠ | ⚠ |
| **waiting** | — | ✓ | — | ⚠ | ⚠ |
| **delivered** | — | ⚠ *(revision / reopen)* | — | — | ⚠ |
| **closed** | — | ⚠ *(reopen)* | — | — | — |

Rules:
- **Nothing returns to `intake`.** Once research starts, the case's history begins. (To be confirmed at #21: whether "back to intake" is ever needed.)
- **`intake → delivered` is not allowed.** A deliverable implies research happened, so the case passes through `active` first.
- **Reopen** means `delivered → active` (revision requested) or `closed → active` (more work on the same objective). Reopening keeps the whole history and asks for confirmation. New work for a *new* objective or order should be a **new case** (§7.3).
- A transition to the current state is rejected (`invalid-transition`), so double clicks are harmless.
- Every accepted change records a timestamped state event (#14 `case_events`), so the case's history shows when it was delivered, reopened or closed.

### 3.2 Meaning of "complete"

A case is **complete** when it is `closed`. `delivered` alone is not complete: revisions are common enough in client work that the researcher closes the case herself once she considers it done. Nothing closes a case automatically.

## 4. Intake fields

| Field | Required | Rule (provisional) | Why |
| --- | --- | --- | --- |
| Client | **Yes** | An existing client. **The client must be active** to create a case (§5.2). | Every case belongs to one client. |
| Title | **Yes** | 1–160 characters, single line. The researcher's label, e.g. "Paternal line — Totonicapán, 1880s". | Lists need a recognizable name. |
| Requested outcome | No | Up to 4,000 characters, multi-line. The client's goal, ideally in their words. | Step 2/3 starts from the client's goal. Keeping it verbatim separates it from the researcher's interpretation (#17). |
| Order reference | No | Up to 100 characters, single line, plain text, e.g. "FO-EXAMPLE-0042". **Never** a password, token or payment detail. | Matching the case to a Fiverr order or custom offer. |
| Due date | No | Calendar date (`YYYY-MM-DD`) with no time and no timezone. | Fiverr orders have deadlines (step 1). |
| State | System | Starts as `intake`. | §3 |

**Deliberately not intake fields (provisional):** price, package/tier, hours allowance and payment status (pricing deferred; hours tracked by #109 without financial math). Contact details stay on the client. Known facts, hypotheses and open questions belong to the research brief (#17), which is edited during the case, not just at intake.

**AI and inference:** no field is filled in or interpreted automatically. Goal summaries, relationship trees and suggested next steps are later, review-gated features (#62, #67).

## 5. Archive

### 5.1 Archiving a case

- Archive is a **reversible flag with a timestamp**, independent of state. A case in any state can be archived, with confirmation, and unarchived later in the **same state**.
- An archived case is **read-only**: no edits, state changes, journal entries or tasks until it is unarchived. Nothing is deleted.
- Archived cases are hidden from default lists and counts but stay findable (an "Archived" filter) and appear on the client's profile under an archived group.
- Archiving records a case event; so does unarchiving.

### 5.2 When the client is archived

- Archiving a client **does not change its cases**: no state change, no archive flag, no deletion. The client's archive dialog warns how many open cases it has.
- While the client is archived, **all of its cases are read-only** (the same rule as archived client profiles in Phase 1), but stay visible and linked.
- **Creating a new case requires an active client.** Restore the client first. This is a safety default against starting work for someone you archived; to be confirmed at #21.
- Restoring the client makes its cases editable again, exactly as they were.

## 6. Due dates and "overdue"

- A due date is a **local calendar date**. It is compared with the researcher's local "today", never converted through UTC, so it never shifts a day near midnight.
- A case is **overdue** when it is open (`intake`/`active`/`waiting`), not archived, and its due date is before local today. Finished or archived cases are never overdue.
- Overdue is only a visual indicator. It sends no reminder and makes no state change.

## 7. Fictional walkthroughs

All names, places and order numbers are invented.

### 7.1 A typical order: intake → active → delivered → closed

1. Fiverr order "FO-EXAMPLE-0042" arrives from existing client **Ana Ejemplo**. The researcher creates the case "Maternal grandparents — Quetzaltenango" with requested outcome *"Find where my grandmother Rosa was born and her parents' names"*, order reference `FO-EXAMPLE-0042`, and due date 2026-11-15. State: `intake`.
2. She reads the questionnaire and moves the case to **`active`**.
3. On 2026-11-12 she sends the report through Fiverr and marks **`delivered`** (confirm). The case shows "Delivered 12 Nov 2026".
4. The client accepts; a week later she marks **`closed`** (confirm). The case leaves the open lists.

### 7.2 Waiting on the client

1. Case "Paternal line — Totonicapán, 1880s" for **Bruno Ficticio** is `active`.
2. She needs the great-grandfather's approximate birth year and asks the client (logged as a contact entry on the client, Phase 1). She moves the case to **`waiting`**.
3. The client answers three days later; she moves it back to **`active`**. Both changes are in the case history.
4. If the due date passes while the case is `waiting`, it shows as **overdue**. Nothing happens automatically.

### 7.3 Repeat client with a custom offer

1. **Ana Ejemplo**'s first case (7.1) is `closed`.
2. Ana asks for more work on her *paternal* line. The researcher sends a personalized offer outside the app; when it's accepted, she creates a **new case** "Paternal line — Huehuetenango" for the same client, with its own order reference and due date.
3. The client profile lists both cases; the old one keeps its history untouched. **No duplicate client** is created.

### 7.4 Revision after delivery (reopen)

1. Case "Baptism search — San Pedro (fictional parish)" is `delivered`.
2. The client asks for one more record to be checked under the same order. She **reopens** it to `active` (confirm), does the work, and marks `delivered` again. The history shows: delivered → reopened → delivered.

### 7.5 Closed, then reopened

1. Case "Immigration records — Cobán" was `closed` in October.
2. In December the client finds a family letter that changes the conclusion. If the work is part of the **same objective and order**, she reopens the closed case to `active` (confirm). If it's a new paid request, she creates a new case (7.3) instead. That choice is the researcher's; the app allows both.

### 7.6 Edge and failure cases

| Situation | Behaviour (provisional) |
| --- | --- |
| Create a case for an archived client | Refused with `client-archived`; the screen offers to open the client to restore it. |
| Edit, change state or add a journal entry to an archived case, or to any case of an archived client | Refused (`wrong-status`); the screen is read-only with an explanation. |
| Mark `intake → delivered` | Not offered; the API refuses `invalid-transition`. |
| Change to the current state (double click) | `invalid-transition`; no event is recorded. |
| Two browser tabs change the same case | The last write wins, and each accepted change records its own event. Conflict detection is out of scope for a single-user app. |
| Due date "2026-02-30" or "next Friday" | `invalid-date` / `invalid-format`. |
| Title of only spaces | Trimmed to empty → `required`. |
| Order reference that looks like a URL with a token | Stored as plain text (no validation can tell), but the field help says never to paste passwords or tokens. |
| Restoring an old (Phase 1, schema v2) backup | No cases, and none are invented. The restore keeps a safety copy of the current data first (#11 behaviour). |
| Client with many open cases is archived | All their cases become read-only; the dialog warns with the open-case count; nothing else changes. |

## 8. Questions for the researcher (collect at #21)

1. Do the five states match how you think about an order? Is anything missing (e.g. "revision requested", "on hold by client") or redundant?
2. Is "closed" the right point to call a case complete, or is it "delivered"?
3. Should a case ever go back to "intake"?
4. When an order is cancelled or refunded, what should the case show? (None has happened yet.)
5. Should a repeat request reopen the old case or always start a new one?
6. Is the order reference useful? Should package/tier or price be recorded on the case?
7. Is one due date per case enough, or do drafts and finals have separate deadlines?
8. Should cases of an archived client be editable?
9. Which actions need confirmation, and which are just annoying?
10. Which intake details do you re-read most often, so they should be visible at the top of a case?

## 9. Hand-off to #14

#14 turns this into the `case-model/v1` schema and typed API contract: states and the transition matrix above, intake field limits, archive semantics, the state event history, and the client-archive rules. Anything #14 changes here must be reflected back in this document with a new version.
