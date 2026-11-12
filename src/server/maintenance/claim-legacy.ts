import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { hashFile } from '../../main/database/backup-file'
import { configureConnection } from '../../main/database/connection'
import { getSchemaVersion, migrations } from '../../main/database/migrations'
import {
  claimConfirmationPhrase,
  OwnershipRepository,
  type BackupEvidence,
  type ClaimPreview
} from '../../main/database/ownership-repository'
import { inspectProfile, walSize } from '../../main/database/schema-preflight'
import { computeManifest, manifestsEqual, type Manifest } from './manifest'
import {
  assertNoOtherConnections,
  closeQuietly,
  isHealthy,
  liveFileOf,
  MaintenanceError,
  maintenanceDirOf,
  stamped,
  tidySideFiles,
  withLockedProfile
} from './profile-lock'

// The operator's offline command that assigns existing, unclaimed legacy clients to one
// existing approved account (#245, first slice). It never starts the server and has no
// HTTP route. It runs under the data-folder lock with the exclusive in-use probe, takes a
// verified snapshot, then claims each listed client in its own transaction, stopping at
// the first failure. Ownership is immutable: recovery from a wrong target is restoring
// the snapshot. See docs/operations/ownership-reconciliation.md.
//
// Output and reports hold ids, counts, hashes and relative names only: never an absolute
// path, SQLite error text, an email, a Google subject or record content.

const ID_PATTERN = /^[0-9a-fA-F-]{36}$/
const OPERATOR_PATTERN = /^[A-Za-z0-9._-]{1,30}$/
export const DEFAULT_OPERATOR = 'host'

/** Test-only fault seam. `before-client-<k>` is 1-based over the pending clients, in the order given. */
export type ClaimFaultPoint = 'after-snapshot' | `before-client-${number}`

export interface ClaimDeps {
  /** Called at each point; a test throws from it to simulate a failure. Never wired to the environment. */
  fault?: (point: ClaimFaultPoint) => void
  now?: () => Date
}

export interface ClaimOptions {
  /** The profile folder (the same folder the web host takes with --data-dir). */
  dataDir: string
  targetUserId: string
  clientIds: readonly string[]
  operator?: string
}

export interface PlanClient {
  id: string
  displayName: string
  /** done: already claimed to this target; pending: would be claimed. */
  status: 'done' | 'pending'
  clientStatus?: 'active' | 'archived'
  counts?: { cases: number; notebookPages: number; tasks: number; journalEntries: number; timeEntries: number }
}

export interface ClaimPlan {
  target: { id: string; displayName: string; role: string; identityProviders: string[] }
  clients: PlanClient[]
  pending: number
  /** Empty when nothing is pending. */
  fingerprint: string
  phrase: string
}

export interface ClaimReport {
  nothingToDo: boolean
  batchId: string | null
  /** Relative to the data folder; null when nothing was written. */
  folder: string | null
  claimed: string[]
  done: string[]
  remaining: string[]
  /** Set when the batch stopped early: the first failure's reason code. */
  failure: string | null
}

interface Planned {
  plan: ClaimPlan
  pendingPreviews: ClaimPreview[]
}

interface Normalized {
  targetUserId: string
  clientIds: string[]
  operator: string
}

function normalize(options: ClaimOptions): Normalized {
  const operator = options.operator ?? DEFAULT_OPERATOR
  const clientIds = [...new Set(options.clientIds)]
  if (
    typeof options.targetUserId !== 'string' ||
    !ID_PATTERN.test(options.targetUserId) ||
    clientIds.length === 0 ||
    !clientIds.every((id) => typeof id === 'string' && ID_PATTERN.test(id)) ||
    !OPERATOR_PATTERN.test(operator)
  ) {
    throw new MaintenanceError('claim-input-invalid')
  }
  return { targetUserId: options.targetUserId, clientIds, operator }
}

export const claimActor = (operator: string): string => `cli:${operator}`

export const batchPhrase = (count: number, targetUserId: string, fingerprint: string): string =>
  `CLAIM ${count} CLIENTS FOR ${targetUserId} ${fingerprint}`

function fingerprintOf(targetUserId: string, pending: ClaimPreview[]): string {
  const pairs = pending.map((p): [string, string] => [p.clientId, p.scopeToken]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return createHash('sha256').update(JSON.stringify({ target: targetUserId, clients: pairs })).digest('hex').slice(0, 12)
}

interface TargetRows {
  user: unknown
  identities: unknown[]
}

function readTarget(db: DatabaseSync, targetUserId: string): TargetRows {
  return {
    user: db.prepare('SELECT * FROM app_users WHERE id = ?').get(targetUserId) ?? null,
    identities: db.prepare('SELECT * FROM user_identities WHERE user_id = ? ORDER BY provider, subject').all(targetUserId)
  }
}

/** The profile must be current at the latest schema; everything else is a refusal that wrote nothing. */
function requireCurrent(dataDir: string): void {
  const latest = migrations.length
  const state = inspectProfile(dataDir, latest)
  const wal = walSize(liveFileOf(dataDir)) > 0
  if (wal && (state.kind === 'migration-required' || (state.kind === 'unsafe' && state.reason === 'wal-unreadable'))) {
    throw new MaintenanceError('not-cleanly-closed')
  }
  if (state.kind === 'unsafe') throw new MaintenanceError(`unsafe:${state.reason}`)
  if (state.kind === 'too-new') throw new MaintenanceError('too-new')
  if (state.kind === 'migration-required') throw new MaintenanceError('migration-required')
  if (state.kind === 'fresh') throw new MaintenanceError('unsafe:missing-database')
}

function buildPlan(db: DatabaseSync, input: Normalized): Planned {
  const target = db.prepare('SELECT id, display_name, role, status FROM app_users WHERE id = ?').get(input.targetUserId) as
    | { id: string; display_name: string; role: string; status: string }
    | undefined
  if (!target) throw new MaintenanceError('target-not-found')
  if (target.status !== 'active' || (target.role !== 'owner' && target.role !== 'researcher')) throw new MaintenanceError('target-inactive')
  const identities = db.prepare('SELECT provider FROM user_identities WHERE user_id = ? ORDER BY provider').all(target.id) as { provider: string }[]
  if (identities.length === 0) throw new MaintenanceError('target-unbound')

  const repo = new OwnershipRepository(db)
  const clients: PlanClient[] = []
  const pendingPreviews: ClaimPreview[] = []
  for (const clientId of input.clientIds) {
    const row = db.prepare('SELECT display_name FROM clients WHERE id = ?').get(clientId) as { display_name: string } | undefined
    if (!row) throw new MaintenanceError('client-not-found')
    const result = repo.previewClaim(clientId)
    if (!result.ok) {
      if (result.reason === 'not-found') throw new MaintenanceError('client-not-found')
      if (repo.getClientOwner(clientId)?.ownerUserId !== target.id) throw new MaintenanceError('ownership-conflict')
      clients.push({ id: clientId, displayName: row.display_name, status: 'done' })
      continue
    }
    const c = result.preview.counts
    pendingPreviews.push(result.preview)
    clients.push({
      id: clientId,
      displayName: row.display_name,
      status: 'pending',
      clientStatus: result.preview.clientStatus,
      counts: {
        cases: c.researchCases,
        notebookPages: c.notebookPages,
        tasks: c.caseTasks,
        journalEntries: c.caseJournalEntries,
        timeEntries: c.caseTimeEntries
      }
    })
  }
  const fingerprint = pendingPreviews.length === 0 ? '' : fingerprintOf(target.id, pendingPreviews)
  return {
    pendingPreviews,
    plan: {
      target: { id: target.id, displayName: target.display_name, role: target.role, identityProviders: identities.map((i) => i.provider) },
      clients,
      pending: pendingPreviews.length,
      fingerprint,
      phrase: pendingPreviews.length === 0 ? '' : batchPhrase(pendingPreviews.length, target.id, fingerprint)
    }
  }
}

/** Read-only plan under the lock and the in-use probe. Writes nothing (no folder, no file). */
export function planClaim(options: ClaimOptions): ClaimPlan {
  const input = normalize(options)
  return withLockedProfile(options.dataDir, () => readPlan(options.dataDir, input).plan)
}

function readPlan(dataDir: string, input: Normalized): Planned {
  const live = liveFileOf(dataDir)
  requireCurrent(dataDir)
  assertNoOtherConnections(live)
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(live, { readOnly: true })
    return buildPlan(db, input)
  } catch (error) {
    if (error instanceof MaintenanceError) throw error
    throw new MaintenanceError('source-damaged')
  } finally {
    closeQuietly(db)
    tidySideFiles(live)
  }
}

const OWNERSHIP_TABLES = ['client_ownership', 'ownership_events']

function withoutOwnership(manifest: Manifest): Manifest {
  const copy: Manifest = { ...manifest }
  for (const table of OWNERSHIP_TABLES) delete copy[table]
  return copy
}

/** Human-readable preview lines. Names and counts only. */
export function formatPlan(plan: ClaimPlan): string[] {
  const lines = [
    `Target account: ${plan.target.id} (${plan.target.displayName})`,
    `  Role: ${plan.target.role}. The role, identity and account will not change.`,
    `  Sign-in identity bound: yes (${plan.target.identityProviders.join(', ')})`,
    'Clients:'
  ]
  for (const client of plan.clients) {
    if (client.status === 'done' || !client.counts) {
      lines.push(`  ${client.id} ${client.displayName}: done (already claimed by this account)`)
      continue
    }
    const c = client.counts
    lines.push(
      `  ${client.id} ${client.displayName} (${client.clientStatus}): pending; ${c.cases} cases, ${c.notebookPages} notebook pages, ${c.tasks} tasks, ${c.journalEntries} journal entries, ${c.timeEntries} time entries`
    )
  }
  if (plan.pending === 0) lines.push('Nothing to do: every listed client is already claimed by this account.')
  else lines.push('Ownership cannot be changed afterwards except by restoring the snapshot.', `Confirmation phrase: ${plan.phrase}`)
  return lines
}

interface ReportFile {
  batchId: string
  targetUserId: string
  operator: string
  completedAt: string
  clients: { id: string; status: 'claimed' | 'done' | 'remaining' }[]
  counts: { claimed: number; done: number; remaining: number }
  failure: string | null
  verified: boolean
  snapshot: { file: string; sha256: string; bytes: number }
}

export interface ApplyOptions extends ClaimOptions {
  confirm: string
}

export function applyClaim(options: ApplyOptions, deps: ClaimDeps = {}): ClaimReport {
  const input = normalize(options)
  const now = deps.now ?? (() => new Date())
  const fault = (point: ClaimFaultPoint): void => deps.fault?.(point)
  const { dataDir } = options

  return withLockedProfile(dataDir, () => {
    const live = liveFileOf(dataDir)
    const { plan, pendingPreviews } = readPlan(dataDir, input)
    const done = plan.clients.filter((c) => c.status === 'done').map((c) => c.id)
    if (plan.pending === 0) {
      return { nothingToDo: true, batchId: null, folder: null, claimed: [], done, remaining: [], failure: null }
    }
    if (options.confirm !== plan.phrase) throw new MaintenanceError('not-confirmed')
    assertNoOtherConnections(live)

    // a-b. Snapshot from a read-only connection, prove it, then record the manifest.
    const maintenanceDir = maintenanceDirOf(dataDir)
    mkdirSync(maintenanceDir, { recursive: true })
    const base = `claim-${stamped(now())}`
    let folderName = base
    for (let n = 2; existsSync(join(maintenanceDir, folderName)); n += 1) folderName = `${base}-${n}`
    const stampDir = join(maintenanceDir, folderName)
    mkdirSync(stampDir)
    const version = migrations.length
    const snapshotName = `snapshot-v${version}.sqlite`
    const snapshot = join(stampDir, snapshotName)

    let before: Manifest
    let targetBefore: TargetRows
    let evidence: BackupEvidence[]
    let source: DatabaseSync | null = null
    try {
      source = new DatabaseSync(live, { readOnly: true })
      if (!isHealthy(source)) throw new MaintenanceError('source-damaged')
      before = computeManifest(source)
      targetBefore = readTarget(source, input.targetUserId)
      source.prepare('VACUUM INTO ?').run(snapshot)
      const snap = new DatabaseSync(snapshot)
      try {
        snap.exec('PRAGMA journal_mode = DELETE')
      } finally {
        snap.close()
      }
      let verified = false
      let check: DatabaseSync | null = null
      try {
        check = new DatabaseSync(snapshot, { readOnly: true })
        verified = isHealthy(check) && getSchemaVersion(check) === version && manifestsEqual(computeManifest(check), before)
      } catch {
        verified = false
      } finally {
        closeQuietly(check)
      }
      if (!verified) throw new MaintenanceError('snapshot-unverified')
      const repo = new OwnershipRepository(source)
      evidence = pendingPreviews.map((preview) => {
        const result = repo.verifyClaimBackup(snapshot, preview)
        if (!result.ok) throw new MaintenanceError('snapshot-unverified')
        return result.evidence
      })
    } catch (error) {
      if (error instanceof MaintenanceError) throw error
      throw new MaintenanceError('source-damaged')
    } finally {
      closeQuietly(source)
      tidySideFiles(live)
    }
    fault('after-snapshot')
    const snapshotFile = hashFile(snapshot)

    // c. One transaction per client, stopping at the first failure.
    const batchId = randomUUID()
    const actor = claimActor(input.operator)
    const claimed: string[] = []
    let failure: string | null = null
    let writer: DatabaseSync | null = null
    try {
      writer = new DatabaseSync(live)
      configureConnection(writer)
      const repo = new OwnershipRepository(writer, { now, newId: () => randomUUID() })
      for (const [index, preview] of pendingPreviews.entries()) {
        try {
          fault(`before-client-${index + 1}`)
          const result = repo.claimLegacyClient({
            clientId: preview.clientId,
            targetUserId: input.targetUserId,
            scopeToken: preview.scopeToken,
            backup: evidence[index]!,
            confirmation: claimConfirmationPhrase(preview.clientId, input.targetUserId),
            actor,
            batchId
          })
          if (!result.ok) {
            failure = result.reason
            break
          }
          claimed.push(preview.clientId)
        } catch (error) {
          // The transaction rolled back: this client stays unclaimed. Only the error name is kept.
          failure = error instanceof Error && error.name.length <= 40 ? `error:${error.name}` : 'error'
          break
        }
      }
    } catch {
      failure ??= 'error'
    } finally {
      closeQuietly(writer)
      tidySideFiles(live)
    }

    // d. Nothing but the ownership tables may differ; the target's rows must be exactly as before.
    let verified: boolean
    let after: DatabaseSync | null = null
    try {
      after = new DatabaseSync(live, { readOnly: true })
      const manifest = computeManifest(after)
      verified =
        manifestsEqual(withoutOwnership(manifest), withoutOwnership(before)) &&
        manifest['client_ownership']?.rows === (before['client_ownership']?.rows ?? 0) + claimed.length &&
        manifest['ownership_events']?.rows === (before['ownership_events']?.rows ?? 0) + claimed.length &&
        JSON.stringify(readTarget(after, input.targetUserId)) === JSON.stringify(targetBefore) &&
        isHealthy(after)
    } catch {
      verified = false
    } finally {
      closeQuietly(after)
      tidySideFiles(live)
    }

    // e. The report: ids, counts and the snapshot's hash. No names, no content.
    const claimedSet = new Set(claimed)
    const doneSet = new Set(done)
    const remaining = input.clientIds.filter((id) => !claimedSet.has(id) && !doneSet.has(id))
    const report: ReportFile = {
      batchId,
      targetUserId: input.targetUserId,
      operator: input.operator,
      completedAt: now().toISOString(),
      clients: input.clientIds.map((id) => ({ id, status: claimedSet.has(id) ? 'claimed' : doneSet.has(id) ? 'done' : 'remaining' })),
      counts: { claimed: claimed.length, done: done.length, remaining: remaining.length },
      failure,
      verified,
      snapshot: { file: snapshotName, sha256: snapshotFile.sha256, bytes: snapshotFile.bytes }
    }
    writeFileSync(join(stampDir, 'report.json'), JSON.stringify(report, null, 2))
    if (!verified) throw new MaintenanceError('verify-failed')
    return { nothingToDo: false, batchId, folder: `maintenance/${folderName}`, claimed, done, remaining, failure }
  })
}
