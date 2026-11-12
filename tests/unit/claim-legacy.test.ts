import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppData } from '../../src/main/database/app-data'
import { dataDirectory, DATABASE_FILE_NAME } from '../../src/main/database/connection'
import { migrations } from '../../src/main/database/migrations'
import { caseAccess, clientAccess, type ResearchScope } from '../../src/main/database/research-access'
import { RESEARCH_CLASS } from '../../src/server/auth/research-policy'
import { CALL_NAMES } from '../../src/server/live-host'
import { applyClaim, planClaim, type ClaimFaultPoint } from '../../src/server/maintenance/claim-legacy'
import { runMaintenanceCommand, type MaintenanceArgs, type MaintenanceIo } from '../../src/server/maintenance/cli'
import { fid, buildLegacyProfile, LEGACY, migrateLegacyProfileForTest } from './helpers/legacy-fixture'
import { activeUser, disabledUser, newCase, pendingUser } from './helpers/ownership-helpers'

// #245: the offline, host-only `db:claim-legacy` command, on fictional temporary profiles.

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
  options: { tty?: boolean; answer?: string; fault?: (point: ClaimFaultPoint) => void } = {}
): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const io: MaintenanceIo = {
    isTTY: options.tty ?? false,
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
    expect(result.out).toContain('Alma Fictional')
    expect(result.out).toContain('role, identity and account will not change')
    expect(result.out).toContain('Sign-in identity bound: yes (google)')
    expect(result.out).toContain('Ana Fictional')
    expect(result.out).toContain('pending')
    expect(result.out).toMatch(/\d+ cases, \d+ notebook pages, \d+ tasks, \d+ journal entries, \d+ time entries/)
    expect(result.out).toContain(`CLAIM 3 CLIENTS FOR ${w.a} `)
    expectClean(result)
    expect(state()).toEqual(before)
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

describe('host-only', () => {
  it('has no Live call or route that claims anything', () => {
    for (const name of [...CALL_NAMES, ...Object.keys(RESEARCH_CLASS)]) expect(name).not.toMatch(/claim/i)
  })
})
