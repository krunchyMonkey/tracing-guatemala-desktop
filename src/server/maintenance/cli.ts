import { resolve } from 'node:path'
import type { Migration } from '../../main/database/migrations'
import { DataDirInUseError } from '../data-dir'
import { applyClaim, formatPlan, planClaim, type ClaimDeps } from './claim-legacy'
import {
  confirmationPhrase,
  MaintenanceError,
  migrateProfile,
  planMigration,
  planRevert,
  revertMigration,
  revertPhrase
} from './migrate-database'

// Command line for the operator's migration maintenance (#248): --migrate-database and
// --revert-migration in src/server/main.ts. Nothing here reads the environment: no
// variable can confirm, choose migrations or bypass a check. Output is versions,
// row counts and names relative to the data folder: never an absolute path or content.

export interface MaintenanceArgs {
  migrate: boolean
  revert: boolean
  dataDir: string | undefined
  expectFrom: string | undefined
  expectTo: string | undefined
  confirm: string | undefined
  /** db:claim-legacy (#245). */
  claim?: boolean
  targetUser?: string | undefined
  clients?: readonly string[] | undefined
  operator?: string | undefined
  preview?: boolean | undefined
  /** Adds display names to the plan output, only in an interactive terminal. */
  showNames?: boolean | undefined
}

export interface MaintenanceIo {
  /** stdin is a terminal: prompting is possible. */
  isTTY: boolean
  /** stdout is a terminal (#245): names are never printed into a pipe or a redirected file. */
  outputIsTTY?: boolean
  log(message: string): void
  error(message: string): void
  prompt(question: string): Promise<string>
}

/** In-code seams for tests; the real command passes none. */
export interface MaintenanceDeps {
  claim?: ClaimDeps
  migrations?: readonly Migration[]
  now?: () => Date
}

function wholeNumber(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null
}

/** Runs one maintenance command and returns the process exit code (0 done, 1 refused or failed). */
export async function runMaintenanceCommand(args: MaintenanceArgs, io: MaintenanceIo, deps: MaintenanceDeps = {}): Promise<number> {
  if ([args.migrate, args.revert, args.claim === true].filter(Boolean).length > 1) {
    io.error('Use only one of --migrate-database, --revert-migration and --claim-legacy. Nothing was changed.')
    return 1
  }
  if (args.dataDir === undefined) {
    io.error('This command needs an explicit --data-dir <folder>. There is no default. Nothing was changed.')
    return 1
  }
  const dataDir = resolve(args.dataDir)

  try {
    if (args.claim === true) {
      if (args.targetUser === undefined || (args.clients ?? []).length === 0) {
        io.error('--claim-legacy needs --target-user <id> and at least one --client <id>. Nothing was changed.')
        return 1
      }
      const options = {
        dataDir,
        targetUserId: args.targetUser,
        clientIds: args.clients ?? [],
        ...(args.operator !== undefined ? { operator: args.operator } : {})
      }
      const plan = planClaim(options)
      const interactive = io.isTTY && io.outputIsTTY === true
      const showNames = args.showNames === true && interactive
      if (args.showNames === true && !interactive) io.log('--show-names is ignored: input and output must both be an interactive terminal. Ids and counts only.')
      if (args.preview === true) {
        for (const line of formatPlan(plan, showNames)) io.log(line)
        io.log('Preview only. Nothing was changed.')
        return 0
      }
      if (plan.pending === 0) {
        for (const line of formatPlan(plan, showNames)) io.log(line)
        return 0
      }
      let confirm = args.confirm
      if (confirm === undefined) {
        if (!io.isTTY) {
          io.error('Not an interactive terminal: pass --confirm "<phrase>". Nothing was changed.')
          return 1
        }
        for (const line of formatPlan(plan, showNames)) io.log(line)
        io.log('Stop the web app first and keep your own off-host copy of the data folder.')
        io.log('Confirm the researcher has agreed to each listed client.')
        confirm = await io.prompt(`Type ${plan.phrase} to continue: `)
      }
      const report = applyClaim({ ...options, confirm }, deps.claim ?? {})
      if (report.nothingToDo) {
        io.log('Nothing to do: every listed client is already claimed by this account.')
        return 0
      }
      io.log(`Batch ${report.batchId}: claimed ${report.claimed.length}, already done ${report.done.length}, remaining ${report.remaining.length}.`)
      for (const id of report.claimed) io.log(`  claimed ${id}`)
      for (const id of report.done) io.log(`  done ${id}`)
      for (const id of report.remaining) io.log(`  remaining ${id}`)
      io.log(`The snapshot and report are kept in ${report.folder}/.`)
      if (report.failure !== null) {
        io.error(`The batch stopped (${report.failure}). Run --preview again and confirm with its new phrase to claim what remains.`)
        return 1
      }
      return 0
    }

    if (args.migrate) {
      const expectFrom = wholeNumber(args.expectFrom)
      const expectTo = wholeNumber(args.expectTo)
      if (expectFrom === null || expectTo === null) {
        io.error('--migrate-database needs --expect-from <n> and --expect-to <n>. Nothing was changed.')
        return 1
      }
      let confirm = args.confirm
      if (confirm === undefined) {
        if (!io.isTTY) {
          io.error('Not an interactive terminal: pass --confirm "<phrase>". Nothing was changed.')
          return 1
        }
        const plan = planMigration({ dataDir, ...(deps.migrations ? { migrations: deps.migrations } : {}) })
        io.log(`The data is at schema v${plan.from}; this build needs v${plan.to}.`)
        for (const { table, rows } of plan.tables) io.log(`  ${table}: ${rows}`)
        io.log('Stop the web app first and keep your own off-host copy of the data folder.')
        confirm = await io.prompt(`Type ${confirmationPhrase(plan.from, plan.to)} to continue: `)
      }
      const report = migrateProfile({
        dataDir,
        expectFrom,
        expectTo,
        confirm,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.migrations ? { migrations: deps.migrations } : {})
      })
      io.log(`Migrated the data from schema v${report.from} to v${report.to}.`)
      for (const { table, rows } of report.tables) io.log(`  ${table}: ${rows} rows, unchanged`)
      io.log(`The original and a verified snapshot are kept in ${report.folder}/. Start the new version now.`)
      return 0
    }

    if (args.revert) {
      let confirm = args.confirm
      if (confirm === undefined) {
        if (!io.isTTY) {
          io.error('Not an interactive terminal: pass --confirm "<phrase>". Nothing was changed.')
          return 1
        }
        const plan = planRevert({ dataDir })
        io.log(`This puts the data back at schema v${plan.from} (migrated copy of v${plan.to} is kept in maintenance/${plan.stamp}/).`)
        confirm = await io.prompt(`Type ${revertPhrase(plan.from, plan.to)} to continue: `)
      }
      const report = revertMigration({ dataDir, confirm, ...(deps.now ? { now: deps.now } : {}) })
      io.log(`Reverted the data from schema v${report.to} to v${report.from}. Details are in ${report.folder}/.`)
      io.log(report.note)
      return 0
    }
  } catch (error) {
    if (error instanceof MaintenanceError) {
      const detail = error.detail
      if (detail) {
        io.log(`Batch ${detail.batchId}: claimed ${detail.claimed.length}, already done ${detail.done.length}, remaining ${detail.remaining.length}.`)
        for (const id of detail.claimed) io.log(`  claimed ${id}`)
        for (const id of detail.done) io.log(`  done ${id}`)
        for (const id of detail.remaining) io.log(`  remaining ${id}`)
        io.log(`The snapshot and report are kept in ${detail.folder}/.`)
      }
      io.error(error.message)
    }
    else if (error instanceof DataDirInUseError) io.error('Tracing Guatemala is running with this data. Stop it first. Nothing was changed.')
    // Only the error name: SQLite messages can quote stored values.
    else io.error(`The maintenance command failed: ${error instanceof Error ? error.name : 'unknown error'}. See docs/operations/database-migration.md.`)
    return 1
  }
  io.error('No maintenance command given. Nothing was changed.')
  return 1
}
