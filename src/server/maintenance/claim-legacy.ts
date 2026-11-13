import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { hashFile } from '../../main/database/backup-file'
import { configureConnection } from '../../main/database/connection'
import { getSchemaVersion, migrations } from '../../main/database/migrations'
import {
  claimConfirmationPhrase,
  OwnershipRepository,
  scopeContentDigest,
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
export type ClaimFaultPoint = 'after-snapshot' | 'before-verify' | `before-client-${number}`

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
  // Ids are case-insensitive hex: fold to lower case so "A..." and "a..." are one client.
  const lower = (value: unknown): unknown => (typeof value === 'string' ? value.toLowerCase() : value)
  const clientIds = [...new Set(options.clientIds.map((id) => lower(id) as string))]
  if (
    typeof options.targetUserId !== 'string' ||
    !ID_PATTERN.test(options.targetUserId) ||
    clientIds.length === 0 ||
    !clientIds.every((id) => typeof id === 'string' && ID_PATTERN.test(id)) ||
    !OPERATOR_PATTERN.test(operator)
  ) {
    throw new MaintenanceError('claim-input-invalid')
  }
  return { targetUserId: lower(options.targetUserId) as string, clientIds, operator }
}

export const claimActor = (operator: string): string => `cli:${operator}`

export const batchPhrase = (count: number, targetUserId: string, fingerprint: string): string =>
  `CLAIM ${count} CLIENTS FOR ${targetUserId} ${fingerprint}`

/**
 * Covers the target's version, auth version, role, status and identity pairs, and each pending
 * client's scope token, status and a digest of the full content of its row and record tree, so an
 * edit between preview and apply changes the phrase.
 */
function fingerprintOf(
  target: { id: string; version: number; auth_version: number; role: string; status: string },
  identityDigest: string,
  pending: ClaimPreview[],
  contentDigests: Map<string, string>
): string {
  const triples = pending
    .map((p): [string, string, string, string] => [p.clientId, p.scopeToken, p.clientStatus, contentDigests.get(p.clientId) ?? ''])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return createHash('sha256')
    .update(JSON.stringify({ target: [target.id, target.version, target.auth_version, target.role, target.status, identityDigest], clients: triples }))
    .digest('hex')
    .slice(0, 12)
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
  // A leftover write-ahead log means an unclean close. Refuse before anything opens the file:
  // even the exclusive in-use probe would checkpoint it, and a preview must write nothing.
  const liveFile = liveFileOf(dataDir)
  if (walSize(liveFile) > 0) throw new MaintenanceError('not-cleanly-closed')
  // Any side file at all (even an empty -wal or a -shm) means another program may have the file open or it was
  // not closed cleanly, and our own connections would delete it on close. Refuse so that a preview leaves the
  // folder as it found it: with none present, every side file that appears is ours and tidySideFiles removes
  // only those.
  if (existsSync(`${liveFile}-wal`) || existsSync(`${liveFile}-shm`)) throw new MaintenanceError('side-files-present')
  const state = inspectProfile(dataDir, latest)
  if (state.kind === 'unsafe') throw new MaintenanceError(`unsafe:${state.reason}`)
  if (state.kind === 'too-new') throw new MaintenanceError('too-new')
  if (state.kind === 'migration-required') throw new MaintenanceError('migration-required')
  if (state.kind === 'fresh') throw new MaintenanceError('unsafe:missing-database')
}

function buildPlan(db: DatabaseSync, input: Normalized): Planned {
  const target = db.prepare('SELECT id, display_name, role, status, version, auth_version FROM app_users WHERE id = ?').get(input.targetUserId) as
    | { id: string; display_name: string; role: string; status: string; version: number; auth_version: number }
    | undefined
  if (!target) throw new MaintenanceError('target-not-found')
  if (target.status !== 'active' || (target.role !== 'owner' && target.role !== 'researcher')) throw new MaintenanceError('target-inactive')
  const identities = db.prepare('SELECT provider, subject FROM user_identities WHERE user_id = ? ORDER BY provider, subject').all(target.id) as {
    provider: string
    subject: string
  }[]
  if (identities.length === 0) throw new MaintenanceError('target-unbound')
  const identityDigest = createHash('sha256').update(JSON.stringify(identities.map((i) => [i.provider, i.subject]))).digest('hex')

  const repo = new OwnershipRepository(db)
  const clients: PlanClient[] = []
  const pendingPreviews: ClaimPreview[] = []
  const contentDigests = new Map<string, string>()
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
    contentDigests.set(clientId, scopeContentDigest(db, clientId))
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
  const fingerprint = pendingPreviews.length === 0 ? '' : fingerprintOf(target, identityDigest, pendingPreviews, contentDigests)
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

function fsyncFile(file: string): void {
  const fd = openSync(file, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Windows cannot open or sync a folder; that is the only failure tolerated. */
function fsyncFolderBestEffort(folder: string): void {
  try {
    const fd = openSync(folder, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (!['EPERM', 'EISDIR', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
}

function isBusyError(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode
  return (typeof code === 'number' && [5, 6].includes(code & 0xff)) || /locked|busy/i.test((error as Error).message ?? '')
}

const OWNERSHIP_TABLES = ['client_ownership', 'ownership_events']

function withoutOwnership(manifest: Manifest): Manifest {
  const copy: Manifest = { ...manifest }
  for (const table of OWNERSHIP_TABLES) delete copy[table]
  return copy
}

/** Human-readable preview lines: ids, status and counts. Display names only when `showNames` (an interactive terminal asked for them). */
export function formatPlan(plan: ClaimPlan, showNames = false): string[] {
  const named = (name: string): string => (showNames ? ` (${name})` : '')
  const lines = [
    `Target account: ${plan.target.id}${named(plan.target.displayName)}`,
    `  Role: ${plan.target.role}. The role, identity and account will not change.`,
    `  Sign-in identity bound: yes (${plan.target.identityProviders.join(', ')})`,
    'Clients:'
  ]
  for (const client of plan.clients) {
    if (client.status === 'done' || !client.counts) {
      lines.push(`  ${client.id}${named(client.displayName)}: done (already claimed by this account)`)
      continue
    }
    const c = client.counts
    lines.push(
      `  ${client.id}${named(client.displayName)} (${client.clientStatus}): pending; ${c.cases} cases, ${c.notebookPages} notebook pages, ${c.tasks} tasks, ${c.journalEntries} journal entries, ${c.timeEntries} time entries`
    )
  }
  if (plan.pending === 0) lines.push('Nothing to do: every listed client is already claimed by this account.')
  else {
    lines.push(
      'Ownership cannot be changed afterwards except by restoring the snapshot.',
      'Confirm the researcher has agreed to each listed client.',
      `Confirmation phrase: ${plan.phrase}`
    )
  }
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

    // a-b. One read-write connection holds the exclusive lock from before the snapshot until
    // the last claim, so nothing else can write in between.
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

    const batchId = randomUUID()
    const actor = claimActor(input.operator)
    const claimed: string[] = []
    let failure: string | null = null
    let before: Manifest
    let targetBefore: TargetRows
    let snapshotFile: { sha256: string; bytes: number }
    let writer: DatabaseSync | null = null
    try {
      let evidence: BackupEvidence[]
      try {
        writer = new DatabaseSync(live)
        writer.exec('PRAGMA locking_mode = EXCLUSIVE')
        configureConnection(writer)
        writer.exec('BEGIN EXCLUSIVE')
        writer.exec('COMMIT')
        if (!isHealthy(writer)) throw new MaintenanceError('source-damaged')
        // Nothing can have changed since the plan, but the fingerprint is cheap to re-check under the exclusive lock.
        if (buildPlan(writer, input).plan.fingerprint !== plan.fingerprint) throw new MaintenanceError('not-confirmed')
        before = computeManifest(writer)
        targetBefore = readTarget(writer, input.targetUserId)
        writer.prepare('VACUUM INTO ?').run(snapshot)
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
        const verifier = new OwnershipRepository(writer)
        evidence = pendingPreviews.map((preview) => {
          const result = verifier.verifyClaimBackup(snapshot, preview)
          if (!result.ok) throw new MaintenanceError('snapshot-unverified')
          return result.evidence
        })
        // Make the snapshot durable before any claim: the file, then (best effort) its folder.
        fsyncFile(snapshot)
        fsyncFolderBestEffort(stampDir)
        snapshotFile = hashFile(snapshot)
      } catch (error) {
        if (error instanceof MaintenanceError) throw error
        if (isBusyError(error)) throw new MaintenanceError('in-use')
        throw new MaintenanceError('source-damaged')
      }
      fault('after-snapshot')

      // c. One transaction per client on the same connection, stopping at the first failure.
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
    } finally {
      closeQuietly(writer)
      tidySideFiles(live)
    }

    // d. Nothing but the ownership tables may differ; the target's rows must be exactly as before.
    // Read from a separate read-only connection after the writer closed.
    fault('before-verify')
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
    if (!verified) {
      throw new MaintenanceError('claim-verify-failed', { batchId, folder: `maintenance/${folderName}`, claimed, done, remaining })
    }
    return { nothingToDo: false, batchId, folder: `maintenance/${folderName}`, claimed, done, remaining, failure }
  })
}
