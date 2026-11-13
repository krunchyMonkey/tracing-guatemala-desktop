import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppData } from '../../src/main/database/app-data'
import { dataDirectory, DATABASE_FILE_NAME } from '../../src/main/database/connection'
import { migrations } from '../../src/main/database/migrations'
import { scopeContentDigest } from '../../src/main/database/ownership-repository'
import { caseAccess, clientAccess, type ResearchScope } from '../../src/main/database/research-access'
import { acquireDataDirLock } from '../../src/server/data-dir'
import { RESEARCH_CLASS } from '../../src/server/auth/research-policy'
import { CALL_NAMES } from '../../src/server/live-host'
import { applyClaim, planClaim, type ClaimFaultPoint } from '../../src/server/maintenance/claim-legacy'
import { runMaintenanceCommand, type MaintenanceArgs, type MaintenanceIo } from '../../src/server/maintenance/cli'
import { fid, buildLegacyProfile, LEGACY, migrateLegacyProfileForTest } from './helpers/legacy-fixture'
import { activeUser, disabledUser, newCase, pendingUser } from './helpers/ownership-helpers'

// #245: the offline, host-only `db:claim-legacy` command, on fictional temporary profiles.

// Each test builds a v9 profile, runs the real db:migrate and takes VACUUM snapshots: fixed
// disk work, no waiting on a race. On the Windows runner the first (cold) test passed 5 s
// once, so give these tests the same kind of budget as the heavy migration-safety tests.
vi.setConfig({ testTimeout: 30_000 })

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-claim-legacy-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const claimFolders = () => readdirSync(join(dataDirectory(root), 'maintenance')).filter((n) => n.startsWith('claim-'))
const live = () => join(dataDirectory(root), DATABASE_FILE_NAME)
const { ana, beto, carla } = LEGACY.clients
const ALL = [ana, beto, carla]

interface World {
  a: string
  b: string
}

/** A v9 profile upgraded the supported way, plus two bound, active owners. */
function world(): World {
  buildLegacyProfile(root)
  migrateLegacyProfileForTest(root)
  const data = new AppData(root)
  try {
    const a = activeUser(data, 'sub-alma', 'Alma Fictional', 'owner')
    const b = activeUser(data, 'sub-boris', 'Boris Fictional', 'owner')
    return { a: a.id, b: b.id }
  } finally {
    data.close()
  }
}

function listing(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    out.push(entry.name)
    if (entry.isDirectory()) out.push(...listing(join(dir, entry.name)).map((n) => `${entry.name}/${n}`))
  }
  return out.sort()
}

/** Everything observable about the profile folder: file bytes and every name in it. */
function state(): { sha: string; names: string[] } {
  return { sha: createHash('sha256').update(readFileSync(live())).digest('hex'), names: listing(root) }
}

function rows(sql: string, ...params: string[]): unknown[] {
  const db = new DatabaseSync(live(), { readOnly: true })
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}
const ownerOf = (clientId: string) => rows('SELECT owner_user_id FROM client_ownership WHERE client_id = ?', clientId)
const ownershipCount = () => (rows('SELECT count(*) AS n FROM client_ownership')[0] as { n: number }).n
const targetRows = (id: string) => [rows('SELECT * FROM app_users WHERE id = ?', id), rows('SELECT * FROM user_identities WHERE user_id = ? ORDER BY provider, subject', id)]

interface Run {
  code: number
  out: string
  err: string
}

async function run(
  extra: Partial<MaintenanceArgs>,
  options: { tty?: boolean; outputTty?: boolean; answer?: string; fault?: (point: ClaimFaultPoint) => void } = {}
): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const io: MaintenanceIo = {
    isTTY: options.tty ?? false,
    outputIsTTY: options.outputTty ?? options.tty ?? false,
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    prompt: async (q) => {
      out.push(q)
      return options.answer ?? ''
    }
  }
  const code = await runMaintenanceCommand(
    { migrate: false, revert: false, claim: true, dataDir: root, expectFrom: undefined, expectTo: undefined, confirm: undefined, ...extra },
    io,
    options.fault ? { claim: { fault: options.fault } } : {}
  )
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const phraseFor = (target: string, clients: string[]) => planClaim({ dataDir: root, targetUserId: target, clientIds: clients }).phrase

function expectClean(result: Run): void {
  expect(result.out + result.err).not.toContain(root)
  expect(result.out + result.err).not.toMatch(/sqlite|@example\.test|sub-alma|sub-boris/i)
}

describe('preview', () => {
  it('prints the plan and leaves the profile byte-identical, with no maintenance folder', async () => {
    const w = world()
    const before = state()
    const result = await run({ targetUser: w.a, clients: ALL, preview: true })
    expect(result.code).toBe(0)
    expect(result.out).toContain(w.a)
    expect(result.out).not.toContain('Fictional') // ids and counts only by default
    expect(result.out).toContain('role, identity and account will not change')
    expect(result.out).toContain('Sign-in identity bound: yes (google)')
    expect(result.out).toContain(ana)
    expect(result.out).toContain('pending')
    expect(result.out).toContain('Confirm the researcher has agreed to each listed client.')
    expect(result.out).toMatch(/\d+ cases, \d+ notebook pages, \d+ tasks, \d+ journal entries, \d+ time entries/)
    expect(result.out).toContain(`CLAIM 3 CLIENTS FOR ${w.a} `)
    expectClean(result)
    expect(state()).toEqual(before)
  })

  it('shows display names only with --show-names in an interactive terminal', async () => {
    const w = world()
    const before = state()
    const tty = await run({ targetUser: w.a, clients: [ana], preview: true, showNames: true }, { tty: true })
    expect(tty.out).toContain('Alma Fictional')
    expect(tty.out).toContain('Ana Fictional')
    const piped = await run({ targetUser: w.a, clients: [ana], preview: true, showNames: true }, { tty: false })
    expect(piped.code).toBe(0)
    expect(piped.out).not.toContain('Fictional')
    expect(piped.out).toContain('--show-names is ignored')
    // A terminal for input but output redirected to a file (`> log.txt`): still no names.
    const redirected = await run({ targetUser: w.a, clients: [ana], preview: true, showNames: true }, { tty: true, outputTty: false })
    expect(redirected.out).not.toContain('Fictional')
    expect(redirected.out).toContain('--show-names is ignored')
    const plain = await run({ targetUser: w.a, clients: [ana], preview: true }, { tty: true })
    expect(plain.out).not.toContain('Fictional')
    expect(state()).toEqual(before)
  })

  it('refuses a leftover write-ahead log as not cleanly closed, for preview and apply, changing no byte', async () => {
    const w = world()
    const holder = new DatabaseSync(live())
    try {
      holder.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
      holder.exec(`UPDATE clients SET updated_at = '2026-10-02T00:00:00.000Z' WHERE id = '${ana}'`)
      const wal = `${live()}-wal`
      expect(statSync(wal).size).toBeGreaterThan(0)
      const bytes = () => [readFileSync(live()), readFileSync(wal)]
      const before = bytes()
      for (const extra of [{ preview: true }, { confirm: 'CLAIM 1 CLIENTS FOR x y' }]) {
        const result = await run({ targetUser: w.a, clients: [ana], ...extra })
        expect(result.code).toBe(1)
        expect(result.err).toContain('not closed cleanly')
      }
      const after = bytes()
      expect(after[0]!.equals(before[0]!)).toBe(true)
      expect(after[1]!.equals(before[1]!)).toBe(true)
    } finally {
      holder.close()
    }
    expect(ownershipCount()).toBe(0)
  })
})

describe('apply', () => {
  it('claims every listed client with audit rows, changes nothing else, and A (not B) can then read them', async () => {
    const w = world()
    const targetBefore = targetRows(w.a)
    const result = await run({ targetUser: w.a, clients: ALL, operator: 'host-1', confirm: phraseFor(w.a, ALL) })
    expect(result.code).toBe(0)
    expect(result.out).toContain('claimed 3')
    expectClean(result)

    expect(ownershipCount()).toBe(3)
    for (const id of ALL) expect(ownerOf(id)).toEqual([{ owner_user_id: w.a }])
    expect(targetRows(w.a)).toEqual(targetBefore)

    const data = new AppData(root)
    try {
      const batchIds = new Set<string>()
      for (const id of ALL) {
        const events = data.ownership.listEvents(id)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ action: 'legacy-claimed', subjectUserId: w.a, actor: 'cli:host-1' })
        batchIds.add(String(events[0]!.detail!['batchId']))
        expect(data.ownership.getClientOwner(id)?.origin).toBe('legacy-claim')
      }
      expect(batchIds.size).toBe(1)
      expect([...batchIds][0]).toMatch(/^[0-9a-f-]{36}$/)

      const scope = (userId: string): ResearchScope => ({ kind: 'user', userId })
      for (const id of ALL) {
        expect(clientAccess(data.db, scope(w.a), id)).toBe('write')
        expect(clientAccess(data.db, scope(w.b), id)).toBe('none')
      }
      expect(caseAccess(data.db, scope(w.a), LEGACY.cases.anaActive)).toBe('write')
      expect(caseAccess(data.db, scope(w.b), LEGACY.cases.anaActive)).toBe('none')
      // The repositories keep working on a claimed client.
      expect(newCase(data, ana, 'New case after claim')).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      data.close()
    }

    const folders = claimFolders()
    expect(folders).toHaveLength(1)
    const dir = join(dataDirectory(root), 'maintenance', folders[0]!)
    const reportText = readFileSync(join(dir, 'report.json'), 'utf8')
    const report = JSON.parse(reportText) as { batchId: string; operator: string; counts: { claimed: number }; verified: boolean; snapshot: { sha256: string; bytes: number } }
    expect(report).toMatchObject({ operator: 'host-1', counts: { claimed: 3 }, verified: true })
    expect(report.snapshot.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(reportText).not.toMatch(/Fictional/)
    expect(existsSync(join(dir, `snapshot-v${migrations.length}.sqlite`))).toBe(true)
  })

  it('defaults the operator to host', async () => {
    const w = world()
    await run({ targetUser: w.a, clients: [ana], confirm: phraseFor(w.a, [ana]) })
    const data = new AppData(root)
    try {
      expect(data.ownership.listEvents(ana)[0]!.actor).toBe('cli:host')
    } finally {
      data.close()
    }
  })

  it('also works interactively, when the phrase is typed', async () => {
    const w = world()
    const result = await run({ targetUser: w.a, clients: [ana, ana] }, { tty: true, answer: phraseFor(w.a, [ana]) })
    expect(result.code).toBe(0)
    expect(result.out).toContain('Confirm the researcher has agreed to each listed client.')
    expect(ownershipCount()).toBe(1) // the duplicate id was folded
  })

  it('refuses without --confirm when not interactive, writing nothing', async () => {
    const w = world()
    const before = state()
    const result = await run({ targetUser: w.a, clients: ALL })
    expect(result.code).toBe(1)
    expect(result.err).toContain('--confirm')
    expect(state()).toEqual(before)
  })

  it('refuses a wrong phrase and a stale preview (a case added after the preview), writing nothing', async () => {
    const w = world()
    const before = state()
    const wrong = await run({ targetUser: w.a, clients: ALL, confirm: 'CLAIM 3 CLIENTS' })
    expect(wrong.code).toBe(1)
    expect(wrong.err).toContain('confirmation phrase did not match')
    expect(state()).toEqual(before)

    const stalePhrase = phraseFor(w.a, ALL)
    const data = new AppData(root)
    try {
      newCase(data, ana, 'Added after the preview')
    } finally {
      data.close()
    }
    const afterAdd = state()
    const stale = await run({ targetUser: w.a, clients: ALL, confirm: stalePhrase })
    expect(stale.code).toBe(1)
    expect(stale.err).toContain('confirmation phrase did not match')
    expect(state()).toEqual(afterAdd)
    expect(ownershipCount()).toBe(0)
  })

  it('refuses when the target or a client changed after the preview (version, status)', async () => {
    const w = world()
    const phrase = phraseFor(w.a, [ana])
    const db = new DatabaseSync(live())
    try {
      db.exec(`UPDATE app_users SET version = version + 1 WHERE id = '${w.a}'`)
    } finally {
      db.close()
    }
    const afterEdit = state()
    const edited = await run({ targetUser: w.a, clients: [ana], confirm: phrase })
    expect(edited.code).toBe(1)
    expect(edited.err).toContain('confirmation phrase did not match')
    expect(state()).toEqual(afterEdit)

    const phrase2 = phraseFor(w.a, [ana])
    const db2 = new DatabaseSync(live())
    try {
      db2.exec(`UPDATE clients SET status = 'archived', archived_at = '2026-10-03T00:00:00.000Z' WHERE id = '${ana}'`)
    } finally {
      db2.close()
    }
    const afterArchive = state()
    const archived = await run({ targetUser: w.a, clients: [ana], confirm: phrase2 })
    expect(archived.code).toBe(1)
    expect(archived.err).toContain('confirmation phrase did not match')
    expect(state()).toEqual(afterArchive)
    expect(ownershipCount()).toBe(0)
  })

  it('does nothing, and says so, when every client is already claimed by this account', async () => {
    const w = world()
    await run({ targetUser: w.a, clients: ALL, confirm: phraseFor(w.a, ALL) })
    const before = state()
    const result = await run({ targetUser: w.a, clients: ALL, confirm: 'anything' })
    expect(result.code).toBe(0)
    expect(result.out).toContain('Nothing to do')
    expect(state()).toEqual(before)
    const previewed = await run({ targetUser: w.a, clients: ALL, preview: true })
    expect(previewed.out).toContain('done')
    expect(state()).toEqual(before)
  })

  describe('a stale phrase after the content changed', () => {
    const edit = (sql: string, ...params: (string | number)[]): void => {
      const db = new DatabaseSync(live())
      try {
        db.prepare(sql).run(...params)
      } finally {
        db.close()
      }
    }
    const { anaActive } = LEGACY.cases
    const edits: [string, string, (string | number)[]][] = [
      ['notebook page content', 'UPDATE notebook_pages SET content = ? WHERE id = ?', ['{"version":1,"blocks":[]}', LEGACY.pages.anaMain]],
      ['client note body', 'UPDATE client_notes SET body = ? WHERE id = ?', ['Fictional edited note.', fid(211)]],
      ['journal entry body', 'UPDATE case_journal_entries SET body = ? WHERE id = ?', ['Fictional edited entry.', fid(321)]],
      ['time entry minutes', 'UPDATE case_time_entries SET duration_minutes = ? WHERE id = ?', [46, fid(341)]],
      ['task title', 'UPDATE case_tasks SET title = ? WHERE id = ?', ['Fictional edited task', fid(331)]],
      ['case brief facts', 'UPDATE case_briefs SET facts = ? WHERE case_id = ?', ['Fictional edited facts.', anaActive]],
      ['case title', 'UPDATE research_cases SET title = ? WHERE id = ?', ['Fictional edited title', anaActive]],
      ['client row display name', 'UPDATE clients SET display_name = ? WHERE id = ?', ['Ana Edited Fictional', ana]]
    ]

    it.each(edits)('refuses after an edit to %s', async (_name, sql, params) => {
      const w = world()
      const phrase = phraseFor(w.a, [ana])
      edit(sql, ...params)
      const before = state()
      const result = await run({ targetUser: w.a, clients: [ana], confirm: phrase })
      expect(result.code).toBe(1)
      expect(result.err).toContain('confirmation phrase did not match')
      expect(state()).toEqual(before)
      expect(ownershipCount()).toBe(0)
    })

    it('an edit to a client that is not in the batch keeps the phrase valid', async () => {
      const w = world()
      const phrase = phraseFor(w.a, [ana])
      edit('UPDATE client_notes SET body = ? WHERE id = ?', 'Fictional edited elsewhere.', fid(213))
      edit('UPDATE case_journal_entries SET body = ? WHERE id = ?', 'Fictional edited elsewhere too.', fid(323))
      const result = await run({ targetUser: w.a, clients: [ana], confirm: phrase })
      expect(result.code).toBe(0)
      expect(ownerOf(ana)).toEqual([{ owner_user_id: w.a }])
      expect(ownerOf(beto)).toEqual([])
    })

    it('a fresh preview phrase succeeds after a refused stale apply', async () => {
      const w = world()
      const stale = phraseFor(w.a, [ana])
      edit('UPDATE client_notes SET body = ? WHERE id = ?', 'Fictional edited note.', fid(211))
      expect((await run({ targetUser: w.a, clients: [ana], confirm: stale })).code).toBe(1)
      const fresh = phraseFor(w.a, [ana])
      expect(fresh).not.toBe(stale)
      const result = await run({ targetUser: w.a, clients: [ana], confirm: fresh })
      expect(result.code).toBe(0)
      expect(ownerOf(ana)).toEqual([{ owner_user_id: w.a }])
    })

    it('scopeContentDigest is deterministic, follows tree content and ignores other clients', () => {
      world()
      const digestOf = (clientId: string): string => {
        const db = new DatabaseSync(live(), { readOnly: true })
        try {
          return scopeContentDigest(db, clientId)
        } finally {
          db.close()
        }
      }
      const first = digestOf(ana)
      expect(first).toMatch(/^[0-9a-f]{64}$/)
      expect(digestOf(ana)).toBe(first)
      edit('UPDATE client_notes SET body = ? WHERE id = ?', 'Fictional edited elsewhere.', fid(213))
      expect(digestOf(ana)).toBe(first)
      edit('UPDATE notebook_pages SET content = ? WHERE id = ?', '{"version":1,"blocks":[]}', LEGACY.pages.anaMain)
      expect(digestOf(ana)).not.toBe(first)
    })
  })
})

describe('refusals write nothing', () => {
  async function refused(targetUser: string | undefined, clients: string[], expected: string | RegExp, extra: Partial<MaintenanceArgs> = {}): Promise<void> {
    const before = state()
    const result = await run({ targetUser, clients, confirm: 'CLAIM 1 CLIENTS FOR x y', ...extra })
    expect(result.code).toBe(1)
    expect(result.err).toMatch(expected)
    expectClean(result)
    expect(state()).toEqual(before)
  }

  it('needs a data folder, a target and a client', async () => {
    const w = world()
    const before = state()
    const noDir = await run({ dataDir: undefined, targetUser: w.a, clients: [ana] })
    expect(noDir.code).toBe(1)
    expect(noDir.err).toContain('--data-dir')
    await refused(undefined, [ana], '--target-user')
    await refused(w.a, [], '--client')
    expect(state()).toEqual(before)
  })

  it('rejects malformed ids and operators', async () => {
    const w = world()
    await refused(w.a, ['not-an-id'], /needs --target-user/)
    await refused('short', [ana], /needs --target-user/)
    await refused(w.a, [ana], /needs --target-user/, { operator: 'has space' })
    await refused(w.a, [ana], /needs --target-user/, { operator: 'x'.repeat(31) })
  })

  it('refuses an unknown, disabled, pending or unbound target', async () => {
    const w = world()
    const data = new AppData(root)
    let disabled: string
    let pending: string
    try {
      disabled = disabledUser(data, 'sub-dina', 'Dina Fictional').id
      pending = pendingUser(data, 'Pablo Fictional').id
    } finally {
      data.close()
    }
    const unbound = fid(990)
    const db = new DatabaseSync(live())
    try {
      db.exec(
        `INSERT INTO app_users (id, display_name, role, status, auth_version, version, created_at, updated_at)
         VALUES ('${unbound}', 'Ursula Fictional', 'researcher', 'active', 1, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`
      )
    } finally {
      db.close()
    }
    await refused(fid(991), [ana], /does not exist/)
    await refused(disabled, [ana], /not an active Owner or Researcher/)
    await refused(pending, [ana], /not an active Owner or Researcher/)
    await refused(unbound, [ana], /no bound sign-in identity/)
    expect(w.a).toBeTruthy()
  })

  it('refuses an unknown client, and a client claimed by someone else, before any write', async () => {
    const w = world()
    await refused(w.a, [ana, fid(999)], /client does not exist/)
    await run({ targetUser: w.b, clients: [beto], confirm: phraseFor(w.b, [beto]) })
    const before = state()
    const result = await run({ targetUser: w.a, clients: [ana, beto], confirm: 'CLAIM 2 CLIENTS' })
    expect(result.code).toBe(1)
    expect(result.err).toContain('already claimed by a different user')
    expect(state()).toEqual(before)
    expect(ownerOf(beto)).toEqual([{ owner_user_id: w.b }])
    expect(ownerOf(ana)).toEqual([])
  })

  it('refuses a profile that has not been migrated, pointing to db:migrate', async () => {
    buildLegacyProfile(root)
    const before = state()
    const result = await run({ targetUser: LEGACY.users.owner, clients: [ana], confirm: 'x' })
    expect(result.code).toBe(1)
    expect(result.err).toContain('npm run db:migrate')
    expect(state()).toEqual(before)
  })

  it('refuses while another connection has the profile open', async () => {
    const w = world()
    const holder = new DatabaseSync(live())
    holder.prepare('SELECT count(*) AS n FROM clients').get()
    try {
      const result = await run({ targetUser: w.a, clients: [ana], confirm: 'x' })
      expect(result.code).toBe(1)
      expect(result.err).toContain('Another program has this data open')
    } finally {
      holder.close()
    }
    expect(ownershipCount()).toBe(0)
  })

  it('refuses a profile saved by a newer version', async () => {
    const w = world()
    const db = new DatabaseSync(live())
    try {
      db.exec(`PRAGMA user_version = ${migrations.length + 1}`)
    } finally {
      db.close()
    }
    await refused(w.a, [ana], /newer version/)
  })

  it('refuses a case id given as a client, and a folder whose lock a running web host holds, writing nothing', async () => {
    const w = world()
    await refused(w.a, [LEGACY.cases.anaActive], /client does not exist/)
    const release = acquireDataDirLock(root)
    try {
      const before = state()
      const result = await run({ targetUser: w.a, clients: [ana], confirm: 'x' })
      expect(result.code).toBe(1)
      expect(result.err).toContain('is running')
      expect(state()).toEqual(before)
    } finally {
      release()
    }
    expect(ownershipCount()).toBe(0)
  })

  it('treats an upper-case id as the same client, and claims duplicates once', async () => {
    const w = world()
    const lower = 'abcdefab-0000-4000-8000-00000000000a'
    const db = new DatabaseSync(live())
    try {
      db.exec(
        `INSERT INTO clients (id, display_name, source, source_detail, preferred_contact_channel, status, created_at, updated_at)
         VALUES ('${lower}', 'Dora Fictional', 'other', 'Fictional detail', 'unspecified', 'active', '2026-09-05T10:00:00.000Z', '2026-09-05T10:00:00.000Z')`
      )
    } finally {
      db.close()
    }
    const result = await run({ targetUser: w.a.toUpperCase(), clients: [lower, lower.toUpperCase(), lower], confirm: phraseFor(w.a, [lower]) })
    expect(result.code).toBe(0)
    expect(result.out).toContain('claimed 1')
    expect(ownerOf(lower)).toEqual([{ owner_user_id: w.a }])
    expect(ownershipCount()).toBe(1)
  })

  it('refuses a folder that is not a profile', async () => {
    const result = await run({ targetUser: fid(1), clients: [ana], confirm: 'x' })
    expect(result.code).toBe(1)
    expect(existsSync(join(dataDirectory(root), 'maintenance'))).toBe(false)
  })
})

describe('a batch that stops part-way', () => {
  it('keeps the earlier claims, leaves the rest unclaimed, and a rerun finishes the batch', async () => {
    const w = world()
    const targetBefore = targetRows(w.a)
    const failing = await run(
      { targetUser: w.a, clients: ALL, confirm: phraseFor(w.a, ALL) },
      {
        fault: (point) => {
          if (point === 'before-client-2') throw new Error('injected failure with a secret path C:\\private')
        }
      }
    )
    expect(failing.code).toBe(1)
    expect(failing.out).toContain(`claimed ${ana}`)
    expect(failing.out).toContain(`remaining ${beto}`)
    expect(failing.out).toContain(`remaining ${carla}`)
    expect(failing.out + failing.err).not.toContain('secret path')
    expect(ownerOf(ana)).toEqual([{ owner_user_id: w.a }])
    expect(ownerOf(beto)).toEqual([])
    expect(ownerOf(carla)).toEqual([])
    expect(ownershipCount()).toBe(1)

    const rerun = await run({ targetUser: w.a, clients: ALL, confirm: phraseFor(w.a, ALL) })
    expect(rerun.code).toBe(0)
    expect(rerun.out).toContain(`done ${ana}`)
    expect(rerun.out).toContain(`claimed ${beto}`)
    expect(rerun.out).toContain(`claimed ${carla}`)
    expect(ownershipCount()).toBe(3)
    expect(targetRows(w.a)).toEqual(targetBefore)

    const again = await run({ targetUser: w.a, clients: ALL, confirm: 'x' })
    expect(again.code).toBe(0)
    expect(again.out).toContain('Nothing to do')
  })

  it('stops before any claim if a fault hits right after the snapshot, keeping the snapshot', () => {
    const w = world()
    expect(() =>
      applyClaim(
        { dataDir: root, targetUserId: w.a, clientIds: ALL, confirm: phraseFor(w.a, ALL) },
        {
          fault: (point) => {
            if (point === 'after-snapshot') throw new Error('boom')
          }
        }
      )
    ).toThrow('boom')
    expect(ownershipCount()).toBe(0)
    const folders = claimFolders()
    expect(existsSync(join(dataDirectory(root), 'maintenance', folders[0]!, `snapshot-v${migrations.length}.sqlite`))).toBe(true)
  })
})

describe('a post-check that fails after claims', () => {
  it('reports claim-verify-failed, points to the report and the runbook, and still lists the ids', async () => {
    const w = world()
    const result = await run(
      { targetUser: w.a, clients: [ana, beto], confirm: phraseFor(w.a, [ana, beto]) },
      {
        fault: (point) => {
          if (point !== 'before-verify') return
          const db = new DatabaseSync(live()) // a foreign write on a separate connection
          try {
            db.exec(`UPDATE clients SET display_name = 'Changed' WHERE id = '${carla}'`)
          } finally {
            db.close()
          }
        }
      }
    )
    expect(result.code).toBe(1)
    expect(result.err).toContain('Claims may have been committed')
    expect(result.err).toContain('maintenance/<folder>/report.json')
    expect(result.err).toContain('docs/operations/ownership-reconciliation.md')
    expect(result.out).toContain(`claimed ${ana}`)
    expect(result.out).toContain(`claimed ${beto}`)
    expect(result.out).toContain('maintenance/claim-')
    expectClean(result)
    expect(ownershipCount()).toBe(2)
    const dir = join(dataDirectory(root), 'maintenance', claimFolders()[0]!)
    expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))).toMatchObject({ verified: false, counts: { claimed: 2 } })
  })
})

describe('host-only', () => {
  it('has no Live call or route that claims anything', () => {
    for (const name of [...CALL_NAMES, ...Object.keys(RESEARCH_CLASS)]) expect(name).not.toMatch(/claim/i)
  })
})
