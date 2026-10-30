# Case data model: research hours (case-time/v1, #109)

Scope of this page: the tables and rules added for case research hours. Activity types are
provisional until the researcher review (#21). There is no billing, rate or external time tracker.

## Migration 7: `case_time`

Forward-only; a pre-migration copy of the database is written first like every other upgrade.

### `case_time_entries`

| Column | Notes |
| --- | --- |
| `id` | UUID, immutable |
| `case_id` | FK to `research_cases`, immutable |
| `client_id` | FK to `clients`, immutable; denormalized for scoping. A trigger refuses a row whose client is not the case's client |
| `work_date` | `YYYY-MM-DD` local calendar date, no time zone |
| `duration_minutes` | integer, 1 to 720 (12 hours) |
| `activity_type` | nullable: `research`, `correspondence`, `analysis`, `writing`, `other` (provisional) |
| `note` | nullable, 1 to 500 characters |
| `source` | `timer` or `manual`, immutable |
| `created_at`, `updated_at` | ISO timestamps |

Entries can be edited and deleted (the browser asks for confirmation first). Writes are refused
(`wrong-status`) when the case or its client is archived; history stays readable. Every query
is scoped by case id and client id; totals (total, ISO week, calendar month) are computed from one
case's entries only.

### `case_active_timer`

At most one row (`id INTEGER PRIMARY KEY CHECK (id = 1)`): `case_id`, `client_id`, `state`
(`running` or `paused`), `accumulated_seconds`, `segment_started_at` (null exactly when paused),
`last_heartbeat_at`, `started_at`, `version`.

## Timer rules

- The host is the source of truth; the timer survives refresh, browser close and host restart.
- Every mutation carries the expected `version`. A stale version returns `conflict` with the current
  timer, so repeated clicks never act twice. The version bumps on start, pause and resume; a heartbeat does
  not change it.
- Stop and save inserts the entry and deletes the timer in one transaction. Seconds are rounded to
  the nearest minute; under 30 seconds cannot be saved (discard instead).
- One timer at a time. Starting on another case returns `other-case-timer`; the UI asks, then stops
  and saves the first and starts the second.
- The open page sends a heartbeat every 30 seconds. A running timer is flagged `needsReview` when the
  last heartbeat is over 5 minutes old, the wall clock moved backwards, or it passed 12 hours. The
  suggestion counts only time up to the last heartbeat. Nothing is saved automatically; pause,
  resume and a plain stop are blocked until the person saves reviewed minutes or discards. A
  heartbeat never refreshes a flagged timer.
- Backup and restore copy the whole database, so both tables are included; restoring a version 6
  backup upgrades it with empty hours and no timer.
