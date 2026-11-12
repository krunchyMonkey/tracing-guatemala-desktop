import { SCOPE_ALL } from '../../src/main/database/research-access'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppData } from '../../src/main/database/app-data'
import { configureConnection, dataDirectory, openAppDatabase, PROFILE_MARKER_FILE_NAME } from '../../src/main/database/connection'
import { MigrationRequiredError } from '../../src/main/database/schema-preflight'
import { confirmationPhrase, MaintenanceError, migrateProfile, revertMigration, revertPhrase } from '../../src/server/maintenance/migrate-database'
import { DatabaseTooNewError, getSchemaVersion, MigrationFailedError, migrate, migrations } from '../../src/main/database/migrations'
import {
  diffManifests,
  foreignKeyViolations,
  integrityOk,
  manifestOf,
  OWNERSHIP_TABLES,
  relationshipCounts,
  relationshipCountsExcluding,
  type DbManifest
} from './helpers/db-manifest'
import { buildLegacyBackupFile, buildLegacyDatabase, buildLegacyProfile, LEGACY_COUNTS, migrateLegacyProfileForTest } from './helpers/legacy-fixture'
import { activeUser, newCase, newClient } from './helpers/ownership-helpers'

// Migration 10 (#209) is purely additive. These tests prove it on fictional v9 and older
// databases: nothing pre-existing changes, every client stays unclaimed, a failed or repeated
// migration is safe, and the documented recovery paths work. Under #248 an existing profile is
// upgraded only by the operator's maintenance command; a normal open refuses it unchanged.
// All databases are temporary.

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-ownership-migration-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const NEW_TABLES = [...OWNERSHIP_TABLES]
const count = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  configureConnection(db)
  return db
}

/** Manifest of a database file, read through a normal connection (a WAL file can't be opened read-only reliably). */
function manifestOfFile(file: string): DbManifest {
  const db = new DatabaseSync(file)
  try {
    return manifestOf(db)
  } finally {
    db.close()
  }
}

function expectUpgradedSafely(db: DatabaseSync, before: DbManifest, relationshipsBefore: ReturnType<typeof relationshipCounts>, clients: number): void {
  expect(getSchemaVersion(db)).toBe(10)
  const after = manifestOf(db)
  // Every pre-existing table, row, hash, CREATE statement, index and trigger is identical.
  expect(diffManifests(before, after, NEW_TABLES)).toEqual([])
  // The new tables exist, are empty, and nothing else appeared.
  expect(Object.keys(after.tables).sort()).toEqual([...Object.keys(before.tables), ...NEW_TABLES].sort())
  for (const table of NEW_TABLES) expect(after.tables[table]?.rowCount, table).toBe(0)
  // Every client is unclaimed.
  expect(count(db, 'SELECT count(*) AS n FROM clients c WHERE NOT EXISTS (SELECT 1 FROM client_ownership o WHERE o.client_id = c.id)')).toBe(clients)
  expect(integrityOk(db)).toBe(true)
  expect(foreignKeyViolations(db)).toEqual([])
  // Parent-child links are unchanged: same number of linked rows, no orphans.
  expect(relationshipCountsExcluding(db, NEW_TABLES)).toEqual(relationshipsBefore)
  for (const [link, c] of Object.entries(relationshipsBefore)) expect(c.orphaned, link).toBe(0)
}

describe('migration 10 on a v9 fixture', () => {
  it('is numbered next and named research_ownership', () => {
    expect(migrations).toHaveLength(10)
    expect(migrations[9]?.name).toBe('research_ownership')
  })

  it('leaves every existing table byte-for-byte equivalent and every client unclaimed', () => {
    const db = memoryDb()
    buildLegacyDatabase(db, 9)
    expect(getSchemaVersion(db)).toBe(9)
    const before = manifestOf(db)
    const links = relationshipCounts(db)
    // Sanity: the fixture really is populated.
    expect(before.tables['clients']?.rowCount).toBe(LEGACY_COUNTS.clients)
    expect(before.tables['research_cases']?.rowCount).toBe(LEGACY_COUNTS.cases)
    expect(before.tables['app_users']?.rowCount).toBe(LEGACY_COUNTS.users)
    for (const table of ['client_notes', 'case_events', 'case_briefs', 'case_journal_entries', 'case_tasks', 'case_time_entries', 'case_active_timer', 'case_notebooks', 'notebook_sections', 'notebook_pages', 'notebook_page_revisions', 'user_identities', 'sign_in_requests', 'user_events']) {
      expect(before.tables[table]?.rowCount, table).toBeGreaterThan(0)
    }
    expect(count(db, 'SELECT count(*) AS n FROM notebook_page_revisions WHERE page_id = (SELECT id FROM notebook_pages WHERE title = \'Fictional main page\' ORDER BY id LIMIT 1)')).toBeGreaterThanOrEqual(3)

    expect(migrate(db)).toEqual({ from: 9, to: 10 })
    expectUpgradedSafely(db, before, links, LEGACY_COUNTS.clients)
    db.close()
  })

  it.each([7, 8] as const)('also upgrades a version %i fixture without changing it', (version) => {
    const db = memoryDb()
    buildLegacyDatabase(db, version)
    expect(getSchemaVersion(db)).toBe(version)
    const before = manifestOf(db)
    const links = relationshipCounts(db)
    expect(migrate(db)).toEqual({ from: version, to: 10 })
    // Tables from migrations 8 and 9 are new to a v7 database too; they must be empty, and the rest identical.
    const created: string[] =
      version === 7
        ? [...NEW_TABLES, 'case_notebooks', 'notebook_sections', 'notebook_pages', 'notebook_page_revisions', 'app_users', 'user_identities', 'sign_in_requests', 'user_events']
        : [...NEW_TABLES, 'app_users', 'user_identities', 'sign_in_requests', 'user_events']
    expect(getSchemaVersion(db)).toBe(10)
    const after = manifestOf(db)
    expect(diffManifests(before, after, created)).toEqual([])
    for (const table of created) expect(after.tables[table]?.rowCount, table).toBe(0)
    expect(count(db, 'SELECT count(*) AS n FROM clients c WHERE NOT EXISTS (SELECT 1 FROM client_ownership o WHERE o.client_id = c.id)')).toBe(LEGACY_COUNTS.clients)
    expect(integrityOk(db)).toBe(true)
    expect(foreignKeyViolations(db)).toEqual([])
    expect(relationshipCountsExcluding(db, created)).toEqual(Object.fromEntries(Object.entries(links).filter(([k]) => !created.includes(k.split('.')[0]!))))
    db.close()
  })
})

describe('migration 10 on a profile on disk (operator maintenance only, #248)', () => {
  const now = () => new Date('2026-11-06T09:00:00.000Z')
  const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
  const tree = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((e) => join(e.parentPath, e.name).slice(dir.length))
      .sort()
  let measured = 0
  /** Manifest and links of a byte copy outside the profile, so measuring never opens the profile's own file. */
  function measureCopy(file: string): { manifest: DbManifest; links: ReturnType<typeof relationshipCounts> } {
    const copy = join(measureDir, `measure-${(measured += 1)}.sqlite`)
    copyFileSync(file, copy)
    const db = new DatabaseSync(copy)
    try {
      return { manifest: manifestOf(db), links: relationshipCounts(db) }
    } finally {
      db.close()
    }
  }
  let measureDir: string
  beforeEach(() => {
    measureDir = mkdtempSync(join(tmpdir(), 'tg-ownership-measure-'))
  })
  afterEach(() => {
    rmSync(measureDir, { recursive: true, force: true })
  })

  function maintenanceCode(run: () => unknown): string {
    try {
      run()
    } catch (error) {
      if (error instanceof MaintenanceError) return error.code
      throw error
    }
    throw new Error('expected a MaintenanceError')
  }

  function expectRefusedUntouched(file: string, hash: string, files: string[]): void {
    expect(() => openAppDatabase(root, now)).toThrow(MigrationRequiredError)
    expect(() => new AppData(root, now)).toThrow(MigrationRequiredError)
    expect(sha256(file)).toBe(hash)
    expect(tree(root)).toEqual(files) // no -wal/-shm, no profile marker, no snapshot: nothing created
  }

  it('refuses to open a v9 profile without changing it, upgrades it only through db:migrate, and is idempotent', () => {
    const { file } = buildLegacyProfile(root, 9)
    const hash = sha256(file)
    const files = tree(root)
    const { manifest: original, links } = measureCopy(file)

    expectRefusedUntouched(file, hash, files)
    expect(existsSync(join(root, PROFILE_MARKER_FILE_NAME))).toBe(false)

    const report = migrateLegacyProfileForTest(root, 9, now)
    expect(report).toMatchObject({ from: 9, to: 10 })
    expect(Object.fromEntries(report.tables.map((t) => [t.table, t.rows]))).toMatchObject({ clients: LEGACY_COUNTS.clients })

    const first = openAppDatabase(root, now)
    expect(first.migration).toEqual({ from: 10, to: 10 }) // the open itself migrated nothing
    expectUpgradedSafely(first.db, original, links, LEGACY_COUNTS.clients)
    const migrated = manifestOf(first.db)
    first.db.close()

    // The untouched original and a verified snapshot are kept for recovery, both identical to the v9 data.
    const stampDir = join(dataDirectory(root), report.folder)
    for (const kept of ['original-v9.sqlite', 'snapshot-v9.sqlite']) {
      const copy = measureCopy(join(stampDir, kept))
      expect(diffManifests(original, copy.manifest), kept).toEqual([])
      expect(copy.links, kept).toEqual(links)
    }
    expect(existsSync(join(dataDirectory(root), 'pre-migration'))).toBe(false)

    const second = openAppDatabase(root, now)
    expect(second.migration).toEqual({ from: 10, to: 10 })
    expect(diffManifests(migrated, manifestOf(second.db))).toEqual([])
    second.db.close()
    expect(maintenanceCode(() => migrateLegacyProfileForTest(root, 9, now))).toBe('nothing-to-do')
  })

  it('a failed maintenance migration leaves the v9 profile byte-identical, still refused, and migratable on rerun', () => {
    const { file } = buildLegacyProfile(root, 9)
    const hash = sha256(file)
    const { manifest: original, links } = measureCopy(file)

    const real = migrations[9]!
    const failing = [...migrations.slice(0, 9), { ...real, sql: `${real.sql}\nSELECT * FROM table_that_does_not_exist;` }]
    expect(() =>
      migrateProfile({ dataDir: root, expectFrom: 9, expectTo: 10, confirm: confirmationPhrase(9, 10), now, migrations: failing })
    ).toThrow(MigrationFailedError)

    // The live file never moved and the in-progress marker is gone, so this is not an interrupted migration.
    expect(sha256(file)).toBe(hash)
    expect(existsSync(join(dataDirectory(root), 'maintenance', 'migration-in-progress.json'))).toBe(false)
    expect(() => openAppDatabase(root, now)).toThrow(MigrationRequiredError)
    expect(sha256(file)).toBe(hash)

    expect(migrateLegacyProfileForTest(root, 9, now)).toMatchObject({ from: 9, to: 10 })
    const opened = openAppDatabase(root, now)
    expectUpgradedSafely(opened.db, original, links, LEGACY_COUNTS.clients)
    opened.db.close()
  })

  it('fails closed for an old build and recovers through the operator revert (recovery path)', () => {
    // migrations.slice(0, 9) simulates the OLD build. A true drill with an old binary is #211's job.
    const { file } = buildLegacyProfile(root, 9)
    const { manifest: original } = measureCopy(file)
    migrateLegacyProfileForTest(root, 9, now)
    const upgradedHash = sha256(file)

    const oldBuild = { now, migrations: migrations.slice(0, 9) }
    expect(() => openAppDatabase(root, oldBuild)).toThrow(DatabaseTooNewError)
    expect(sha256(file)).toBe(upgradedHash)

    // The revert phrase is required, and an unchanged v10 profile goes back to exactly the v9 content.
    expect(maintenanceCode(() => revertMigration({ dataDir: root, confirm: 'wrong', now }))).toBe('not-confirmed')
    expect(sha256(file)).toBe(upgradedHash)
    expect(revertMigration({ dataDir: root, confirm: revertPhrase(9, 10), now })).toMatchObject({ from: 9, to: 10 })

    const old = openAppDatabase(root, oldBuild)
    expect(getSchemaVersion(old.db)).toBe(9)
    expect(diffManifests(original, manifestOf(old.db))).toEqual([])
    expect(integrityOk(old.db)).toBe(true)
    old.db.close()
    // And this build refuses the reverted profile again instead of re-upgrading it.
    expect(() => openAppDatabase(root, now)).toThrow(MigrationRequiredError)
  })

  it('refuses to revert once the migrated profile has new research, so nothing is lost', () => {
    buildLegacyProfile(root, 9)
    migrateLegacyProfileForTest(root, 9, now)
    const data = new AppData(root, now)
    try {
      newClient(data, 'Created After Migration', activeUser(data, 'sub-after', 'Nia Fictional').id)
    } finally {
      data.close()
    }
    expect(maintenanceCode(() => revertMigration({ dataDir: root, confirm: revertPhrase(9, 10), now }))).toBe('changed-since-migration')
    const reopened = openAppDatabase(root, now)
    expect(getSchemaVersion(reopened.db)).toBe(10)
    expect(count(reopened.db, "SELECT count(*) AS n FROM clients WHERE display_name = 'Created After Migration'")).toBe(1)
    reopened.db.close()
  })
})

describe('backup and restore across the ownership schema', () => {
  let data: AppData | undefined

  afterEach(() => {
    try {
      data?.close()
    } catch {
      // Already closed.
    }
    data = undefined
  })

  it('restores ownership, grants and events and rebuilds the repositories', () => {
    data = new AppData(join(root, 'profile'))
    // A legacy-style unclaimed client exists before any user does.
    const legacyId = newClient(data, 'Legacy Fictional', null)
    const legacyCase = newCase(data, legacyId, 'Legacy case')
    const admin = activeUser(data, 'sub-admin', 'Olga Fictional', 'owner')
    const researcher = activeUser(data, 'sub-researcher', 'Rafa Fictional')
    const colleague = activeUser(data, 'sub-colleague', 'Cleo Fictional')
    const ownedId = newClient(data, 'Owned Fictional', researcher.id)
    const ownedCase = newCase(data, ownedId, 'Owned case')
    expect(data.ownership.setClientGrant({ clientId: ownedId, granteeUserId: admin.id, permission: 'viewer', grantedBy: researcher.id }).ok).toBe(true)
    expect(data.ownership.setCaseGrant({ caseId: ownedCase, granteeUserId: colleague.id, permission: 'editor', grantedBy: researcher.id }).ok).toBe(true)

    // Claim the legacy client using a verified backup, as the host-only workflow does.
    const evidenceFile = join(root, 'claim-evidence.tgbackup')
    data.createBackup(evidenceFile)
    const preview = data.ownership.previewClaim(legacyId)
    if (!preview.ok) throw new Error('preview refused')
    const verified = data.ownership.verifyClaimBackup(evidenceFile, preview.preview)
    if (!verified.ok) throw new Error('backup refused')
    const claim = data.ownership.claimLegacyClient({
      clientId: legacyId,
      targetUserId: colleague.id,
      scopeToken: preview.preview.scopeToken,
      backup: verified.evidence,
      confirmation: `claim client ${legacyId} for user ${colleague.id}`,
      actor: 'host'
    })
    expect(claim.ok).toBe(true)

    const backupFile = join(root, 'ownership.tgbackup')
    data.createBackup(backupFile)
    const saved = manifestOf(data.db)
    expect(saved.tables['client_ownership']?.rowCount).toBe(2)
    expect(saved.tables['client_grants']?.rowCount).toBe(1)
    expect(saved.tables['case_grants']?.rowCount).toBe(1)
    expect(saved.tables['ownership_events']?.rowCount).toBe(4)

    // Change everything the backup covers, then restore.
    const before = data.ownership
    data.ownership.revokeClientGrant({ clientId: ownedId, granteeUserId: admin.id, revokedBy: researcher.id })
    newClient(data, 'Created After Backup', researcher.id)
    data.restoreBackup(backupFile)

    expect(data.ownership).not.toBe(before)
    expect(diffManifests(saved, manifestOf(data.db))).toEqual([])
    expect(integrityOk(data.db)).toBe(true)
    expect(foreignKeyViolations(data.db)).toEqual([])
    expect(data.ownership.getClientOwner(legacyId)).toMatchObject({ ownerUserId: colleague.id, origin: 'legacy-claim' })
    expect(data.ownership.getCaseOwner(legacyCase)?.ownerUserId).toBe(colleague.id)
    expect(data.ownership.getClientOwner(ownedId)).toMatchObject({ ownerUserId: researcher.id, origin: 'created' })
    expect(data.ownership.listGrants({ clientId: ownedId }).map((g) => g.granteeUserId)).toEqual([admin.id])
    expect(data.ownership.listGrants({ caseId: ownedCase }).map((g) => g.permission)).toEqual(['editor'])
    expect(data.ownership.listEvents(legacyId).map((e) => e.action)).toEqual(['legacy-claimed'])
    // The reconstructed repositories keep working.
    expect(data.ownership.setClientGrant({ clientId: ownedId, granteeUserId: colleague.id, permission: 'viewer', grantedBy: researcher.id }).ok).toBe(true)
    newClient(data, 'Created After Restore', researcher.id)
  })

  it('restores a v9 backup into the current app: content preserved, every client unclaimed', () => {
    const file = join(root, 'v9.tgbackup')
    buildLegacyBackupFile(file, 9)
    const original = manifestOfFile(file)
    const probe = new DatabaseSync(file, { readOnly: true })
    expect(getSchemaVersion(probe)).toBe(9)
    probe.close()

    data = new AppData(join(root, 'profile'))
    newClient(data, 'Will Be Replaced', null)
    const summary = data.restoreBackup(file)
    expect(summary).toMatchObject({ clients: LEGACY_COUNTS.clients, schemaVersion: 10 })

    expect(diffManifests(original, manifestOf(data.db), NEW_TABLES)).toEqual([])
    for (const table of NEW_TABLES) expect(manifestOf(data.db).tables[table]?.rowCount, table).toBe(0)
    expect(integrityOk(data.db)).toBe(true)
    expect(foreignKeyViolations(data.db)).toEqual([])
    expect(data.ownership.listUnclaimedClients({ limit: 500 })).toHaveLength(LEGACY_COUNTS.clients)
    // And an old case on a restored client still derives "unclaimed".
    expect(data.ownership.getCaseOwner(data.cases.list({ clientId: null, archived: 'all', states: [], text: '', sort: 'created' }, SCOPE_ALL)[0]!.id)).toBeNull()
  })
})
