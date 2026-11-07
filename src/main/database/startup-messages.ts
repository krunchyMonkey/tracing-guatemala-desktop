import { DataProfileUnsafeError, MigrationRequiredError, type UnsafeReason } from './schema-preflight'

// Path-free, actionable startup messages for a profile that was deliberately not
// opened (#248). Shared by the Electron app and the web host. Nothing was changed
// in any of these cases.

const RUNBOOK = 'docs/operations/database-migration.md'

const UNSAFE_MESSAGES: Record<UnsafeReason, string> = {
  'restore-interrupted': `A restore was interrupted. Nothing was changed. See the recovery steps in ${RUNBOOK}.`,
  'migration-interrupted': `A database upgrade was interrupted. Nothing was changed. See the recovery steps in ${RUNBOOK}.`,
  'missing-database': `The database file is missing but the data folder has other saved data. Nothing was changed. See the recovery steps in ${RUNBOOK}.`,
  'not-an-app-database': `The data file is not a Tracing Guatemala database. Nothing was changed. See ${RUNBOOK}.`,
  unreadable: `The data folder could not be read. Nothing was changed. Check the folder's permissions, then see ${RUNBOOK}.`,
  'wal-pending': `The data was not closed cleanly. Nothing was changed. Start and stop the previous version once, then see ${RUNBOOK}.`
}

/** The message for a deliberate refusal, or null if `error` is something else. */
export function startupProblemMessage(error: unknown): string | null {
  if (error instanceof MigrationRequiredError) {
    return `This data is at schema v${error.from}; this version needs v${error.to}. Nothing was changed. Stop, take the maintenance steps in ${RUNBOOK}, or run the previous version.`
  }
  if (error instanceof DataProfileUnsafeError) return UNSAFE_MESSAGES[error.reason]
  return null
}
