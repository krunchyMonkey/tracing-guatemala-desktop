import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { liveContracts } from '../../src/main/contracts'
import { AppData } from '../../src/main/database/app-data'
import { APPLICATION_ID, dataDirectory } from '../../src/main/database/connection'
import { migrations } from '../../src/main/database/migrations'
import { BACKUP_STATUS_FILE, backupFileName, createWebBackupService } from '../../src/server/backup'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { ClientInput, DirectoryQuery } from '../../src/shared/client-model'
import type { BackupStatus } from '../../src/shared/ipc'
import { call, send, signIn, without, writeHeaders } from './live-helpers'

// Backup status (#117): when the last verified backup was made, kept in
// <data>/backup-status.json by the Live host. Fictional data only.

const input: ClientInput = {
  displayName: 'Ana Ejemplo',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: 'fictional_buyer_01',
  email: null,
  otherContact: null,
  preferredContactChannel: 'fiverr'
}
const everyone: DirectoryQuery = { text: '', status: 'all', sources: [], sort: 'name' }

let root: string
let dataDir: string
let data: AppData

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-backup-status-test-'))
  dataDir = join(root, 'profile')
  data = new AppData(dataDir)
})

afterEach(() => {
  try {
    data.close()
  } catch {
    // Already closed.
  }
  rmSync(root, { recursive: true, force: true })
})

const statusFile = () => join(dataDir, BACKUP_STATUS_FILE)
const none: BackupStatus = { lastBackupAt: null, fileName: null, backupCount: 0 }

describe('backup status file', () => {
  it('is unknown until a backup is made', () => {
    const service = createWebBackupService(dataDir, () => data)
    expect(service.status()).toEqual(none)
    expect(existsSync(statusFile())).toBe(false)
  })

  it('records a verified backup: when, which file, how many clients and notes', () => {
    data.clients.create(input)
    const at = new Date('2026-10-29T15:04:05.000Z')
    const service = createWebBackupService(dataDir, () => data, () => at)
    const made = service.create()
    if (!made.ok) throw new Error('backup failed')

    expect(JSON.parse(readFileSync(statusFile(), 'utf8'))).toEqual({
      lastBackupAt: '2026-10-29T15:04:05.000Z',
      fileName: made.fileName,
      clients: 1,
      notes: 0
    })
    expect(service.status()).toEqual({ lastBackupAt: '2026-10-29T15:04:05.000Z', fileName: made.fileName, backupCount: 1 })
    // Written by rename: no temporary file is left behind.
    expect(readdirSync(dataDir).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('keeps the previous status when a backup fails, and a first failure records nothing', () => {
    const good = createWebBackupService(dataDir, () => data, () => new Date('2026-10-20T08:00:00.000Z'))
    expect(good.create().ok).toBe(true)
    const before = readFileSync(statusFile(), 'utf8')

    const broken = {
      createBackup: () => {
        throw new Error('disk full')
      }
    } as unknown as AppData
    const failing = createWebBackupService(dataDir, () => broken, () => new Date('2026-10-29T08:00:00.000Z'))
    expect(failing.create()).toEqual({ ok: false, reason: 'failed' })
    expect(readFileSync(statusFile(), 'utf8')).toBe(before)
    expect(failing.status().lastBackupAt).toBe('2026-10-20T08:00:00.000Z')

    rmSync(statusFile())
    expect(failing.create()).toEqual({ ok: false, reason: 'failed' })
    expect(existsSync(statusFile())).toBe(false)
    expect(failing.status().lastBackupAt).toBeNull()
  })

  it('still reports the backup as made if only the status file cannot be written', () => {
    const service = createWebBackupService(dataDir, () => data, () => new Date('2026-10-29T08:00:00.000Z'))
    // A folder in the way makes the final rename fail.
    mkdirSync(statusFile())
    expect(service.create().ok).toBe(true)
    expect(readdirSync(dataDir).filter((f) => f.includes('.tmp'))).toEqual([])
    expect(service.status().lastBackupAt).toBeNull()
  })

  it.each([
    ['not JSON', '{oops'],
    ['an empty file', ''],
    ['the wrong shape', JSON.stringify({ lastBackupAt: 'yesterday' })],
    ['a date that is not a date', JSON.stringify({ lastBackupAt: 'someday', fileName: backupFileName(new Date()), clients: 0, notes: 0 })],
    [
      'a file name this host would not generate',
      JSON.stringify({ lastBackupAt: '2026-10-29T08:00:00.000Z', fileName: '..\\..\\secret.txt', clients: 0, notes: 0 })
    ],
    ['JSON null', 'null']
  ])('treats %s as unknown instead of failing', (_name, contents) => {
    const service = createWebBackupService(dataDir, () => data)
    writeFileSync(statusFile(), contents)
    expect(service.status()).toEqual(none)
  })

  it('counts only backup files named by this host', () => {
    const service = createWebBackupService(dataDir, () => data)
    mkdirSync(join(dataDir, 'backups'), { recursive: true })
    const names = [backupFileName(new Date(2026, 9, 1, 8)), backupFileName(new Date(2026, 9, 2, 8)), backupFileName(new Date(2026, 9, 2, 8), 1)]
    for (const name of names) writeFileSync(join(dataDir, 'backups', name), 'x')
    writeFileSync(join(dataDir, 'backups', 'notes.txt'), 'x')
    writeFileSync(join(dataDir, 'backups', 'Tracing Guatemala backup copy.tgbackup'), 'x')
    expect(service.status().backupCount).toBe(3)
  })

  it('counts the folder as it is now, but keeps the date of the last verified backup', () => {
    const service = createWebBackupService(dataDir, () => data)
    const made = service.create()
    if (!made.ok) throw new Error('backup failed')
    rmSync(join(dataDir, 'backups', made.fileName))
    expect(service.status().backupCount).toBe(0)
    expect(service.status().lastBackupAt).not.toBeNull()
  })

  it('never contains a path', () => {
    const service = createWebBackupService(dataDir, () => data)
    service.create()
    const status = service.status()
    expect(Object.keys(status).sort()).toEqual(['backupCount', 'fileName', 'lastBackupAt'])
    const text = JSON.stringify(status)
    expect(text).not.toContain(root)
    expect(text).not.toMatch(/[\\/]/)
    expect(liveContracts.getBackupStatus.result.parse(status)).toEqual(status)
  })

  it('lives outside the database folder, so a restore leaves it alone', () => {
    const service = createWebBackupService(dataDir, () => data, () => new Date('2026-10-29T08:00:00.000Z'))
    expect(service.create().ok).toBe(true)
    expect(statusFile().startsWith(dataDirectory(dataDir))).toBe(false)
    const before = readFileSync(statusFile(), 'utf8')
    data.restoreBackup(join(dataDir, 'backups', readdirSync(join(dataDir, 'backups'))[0]!))
    expect(readFileSync(statusFile(), 'utf8')).toBe(before)
  })
})

// ---------- over HTTP ----------

describe('getBackupStatus over HTTP', () => {
  let server: RunningLiveServer | null = null

  async function start(): Promise<RunningLiveServer> {
    data.close()
    server = await startLiveServer({
      dataDir,
      port: 0,
      staticDir: null,
      appInfo: { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' },
      log: () => {}
    })
    return server
  }

  afterEach(async () => {
    await server?.close()
    server = null
  })

  it('answers a signed-in browser with a strict result, and follows each backup', async () => {
    const live = await start()
    const signed = await signIn(live)
    expect(await call(live, signed, 'getBackupStatus')).toEqual(none)

    await call(live, signed, 'createClient', input)
    const made = await call<{ ok: true; fileName: string }>(live, signed, 'createBackup')
    const after = await call<BackupStatus>(live, signed, 'getBackupStatus')
    expect(Object.keys(after).sort()).toEqual(['backupCount', 'fileName', 'lastBackupAt'])
    expect(after).toMatchObject({ fileName: made.fileName, backupCount: 1 })
    expect(Math.abs(Date.now() - Date.parse(after.lastBackupAt!))).toBeLessThan(60_000)
    expect(JSON.stringify(after)).not.toContain(root)
  })

  it('needs a session, the same origin and the CSRF token, and takes no arguments', async () => {
    const live = await start()
    const signed = await signIn(live)
    const headers = writeHeaders(live, signed)
    const post = (h: Record<string, string>, body = JSON.stringify({ args: [] })) =>
      send(live, 'POST', '/api/v1/call/getBackupStatus', h, body)
    expect((await post(without(headers, 'Cookie'))).status).toBe(401)
    expect((await post(without(headers, 'X-TG-CSRF'))).status).toBe(403)
    expect((await post({ ...headers, Origin: 'http://evil.example' })).status).toBe(403)
    const extra = await post(headers, JSON.stringify({ args: ['..\\secret'] }))
    expect(extra.status).toBe(400)
    expect(extra.json()).toEqual({ error: 'invalid-arguments' })
    expect((await post(headers)).status).toBe(200)
  })

  it('keeps the status when a backup is restored over HTTP', async () => {
    const live = await start()
    const signed = await signIn(live)
    await call(live, signed, 'createClient', input)
    const made = await call<{ ok: true; fileName: string }>(live, signed, 'createBackup')
    const before = await call<BackupStatus>(live, signed, 'getBackupStatus')
    await call(live, signed, 'createClient', { ...input, displayName: 'Added Later', fiverrUsername: 'fictional_buyer_02' })

    const bytes = readFileSync(join(dataDir, 'backups', made.fileName))
    const headers = { ...writeHeaders(live, signed), 'Content-Type': 'application/octet-stream' }
    const choice = (await send(live, 'POST', '/api/v1/backup/upload', headers, bytes)).json() as { result: { token: string } }
    expect(await call(live, signed, 'restoreBackup', choice.result.token)).toMatchObject({ ok: true, clients: 1 })
    expect(await call(live, signed, 'getBackupStatus')).toEqual(before)
  })
})

// ---------- an older (desktop-style) backup, restored through the Live upload API ----------

describe('restoring an older backup through the Live upload API', () => {
  let server: RunningLiveServer | null = null

  afterEach(async () => {
    await server?.close()
    server = null
  })

  /** A schema-version-2 database, as the first desktop releases wrote: clients and notes only. */
  function buildV2Backup(file: string): void {
    const old = new DatabaseSync(file)
    old.exec(migrations[0]!.sql)
    old.exec(migrations[1]!.sql)
    old.exec(`PRAGMA user_version = 2; PRAGMA application_id = ${APPLICATION_ID};`)
    old
      .prepare(
        `INSERT INTO clients (id, display_name, source, created_at, updated_at)
         VALUES ('00000000-0000-4000-8000-000000000002', 'Older Desktop Client', 'direct', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    old
      .prepare(
        `INSERT INTO client_notes (id, client_id, kind, occurred_at, created_at, updated_at, body)
         VALUES ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000002', 'note',
                 '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'Fictional older note.')`
      )
      .run()
    old.close()
  }

  it('upgrades the data, keeps what was in it and accepts the upload', async () => {
    data.close()
    const file = join(root, 'older-desktop.tgbackup')
    buildV2Backup(file)

    server = await startLiveServer({
      dataDir,
      port: 0,
      staticDir: null,
      appInfo: { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' },
      log: () => {}
    })
    const live = server
    const signed = await signIn(live)
    await call(live, signed, 'createClient', input)

    const headers = {
      ...writeHeaders(live, signed),
      'Content-Type': 'application/octet-stream',
      'X-TG-File-Name': encodeURIComponent('Tracing Guatemala backup 2026-01-02.tgbackup')
    }
    const choice = (await send(live, 'POST', '/api/v1/backup/upload', headers, readFileSync(file))).json() as {
      result: { ok: true; token: string; clients: number; notes: number }
    }
    expect(choice.result).toMatchObject({ ok: true, clients: 1, notes: 1 })

    expect(await call(live, signed, 'restoreBackup', choice.result.token)).toEqual({ ok: true, clients: 1, notes: 1 })
    const clients = await call<{ id: string; displayName: string }[]>(live, signed, 'listClients', everyone)
    expect(clients.map((c) => c.displayName)).toEqual(['Older Desktop Client'])
    const notes = await call<{ body: string }[]>(live, signed, 'listNotes', clients[0]!.id)
    expect(notes.map((n) => n.body)).toEqual(['Fictional older note.'])

    // Migrated to the current schema: the case features work on the restored data.
    const created = await call<{ ok: boolean }>(live, signed, 'createCase', clients[0]!.id, {
      title: 'After the upgrade',
      goal: null,
      orderReference: null,
      dueDate: null
    })
    expect(created.ok).toBe(true)
    expect(await call<unknown[]>(live, signed, 'listCases', { clientId: null, archived: 'active', states: [], text: '', sort: 'due' })).toHaveLength(1)

    // The previous data was kept as a safety copy first.
    expect(readdirSync(join(dataDirectory(dataDir), 'pre-restore'))).toHaveLength(1)
  })
})
