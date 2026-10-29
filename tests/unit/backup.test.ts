import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackupService, defaultBackupName, type BackupDialogs } from '../../src/main/backup'
import { AppData, BackupInvalidError, inspectBackup, RestoreFailedError } from '../../src/main/database/app-data'
import { APPLICATION_ID, dataDirectory } from '../../src/main/database/connection'
import { migrations } from '../../src/main/database/migrations'
import type { ClientInput, DirectoryQuery, NoteInput } from '../../src/shared/client-model'

// Backup and restore against real files in temporary directories. Fictional data only.

const input: ClientInput = {
  displayName: 'Ana Ejemplo',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: 'fictional_buyer_01',
  email: null,
  otherContact: null,
  preferredContactChannel: 'fiverr'
}

const note: NoteInput = {
  kind: 'note',
  occurredAt: '2026-10-20T10:00:00.000Z',
  channel: null,
  direction: null,
  body: 'Fictional research note.'
}

const everyone: DirectoryQuery = { text: '', status: 'all', sources: [], sort: 'name' }

let root: string
let data: AppData

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-backup-test-'))
  data = new AppData(join(root, 'profile'), () => new Date('2026-10-29T12:00:00.000Z'))
})

afterEach(() => {
  try {
    data.close()
  } catch {
    // Already closed by the test.
  }
  rmSync(root, { recursive: true, force: true })
})

function seed(name = input.displayName) {
  const created = data.clients.create({ ...input, displayName: name })
  if (!created.ok) throw new Error('seed failed')
  const added = data.notes.create(created.client.id, note)
  if (!added.ok) throw new Error('note failed')
  return created.client
}

const names = () => data.clients.list(everyone).map((c) => c.displayName)

describe('createBackup', () => {
  it('writes one self-contained, verified file with every client and note', () => {
    seed('Ana Ejemplo')
    seed('Bea Muestra')
    const target = join(root, 'backup.tgbackup')
    expect(data.createBackup(target)).toEqual({ clients: 2, notes: 2, schemaVersion: migrations.length })

    expect(existsSync(`${target}-wal`)).toBe(false)
    const copy = new DatabaseSync(target, { readOnly: true })
    expect((copy.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('delete')
    expect((copy.prepare('PRAGMA application_id').get() as { application_id: number }).application_id).toBe(APPLICATION_ID)
    copy.close()
    expect(readdirSync(root).filter((f) => f.includes('partial'))).toEqual([])
  })

  it('replaces an existing file at the chosen location', () => {
    const target = join(root, 'backup.tgbackup')
    writeFileSync(target, 'old contents')
    seed()
    data.createBackup(target)
    expect(inspectBackup(target).clients).toBe(1)
  })
})

describe('inspectBackup', () => {
  it.each([
    ['a text file', (file: string) => writeFileSync(file, 'not a database at all '.repeat(100)), 'not-a-backup'],
    ['an empty file', (file: string) => writeFileSync(file, ''), 'not-a-backup'],
    [
      'another app’s SQLite database',
      (file: string) => {
        const other = new DatabaseSync(file)
        other.exec('CREATE TABLE clients (id TEXT); PRAGMA user_version = 1;')
        other.close()
      },
      'not-a-backup'
    ]
  ])('rejects %s', (_label, make, problem) => {
    const file = join(root, 'candidate.tgbackup')
    make(file)
    expect(() => inspectBackup(file)).toThrow(new BackupInvalidError(problem as 'not-a-backup'))
  })

  it.each([
    ['the first page', () => [100, 8192]],
    ['a later data page', (size: number) => [size - 4096, size]]
  ])('rejects a backup damaged in %s', (_label, range) => {
    for (let i = 0; i < 30; i++) seed(`Client ${i}`)
    const file = join(root, 'backup.tgbackup')
    data.createBackup(file)
    const bytes = readFileSync(file)
    // Keep the 100-byte header so it still looks like SQLite, then corrupt pages.
    const [start, end] = range(bytes.length)
    bytes.fill(0xff, start, end)
    writeFileSync(file, bytes)
    expect(() => inspectBackup(file)).toThrow(new BackupInvalidError('damaged'))
  })

  it('rejects a backup from a newer app version', () => {
    seed()
    const file = join(root, 'backup.tgbackup')
    data.createBackup(file)
    const db = new DatabaseSync(file)
    db.exec(`PRAGMA user_version = ${migrations.length + 1}`)
    db.close()
    expect(() => inspectBackup(file)).toThrow(new BackupInvalidError('too-new'))
  })

  it('rejects a missing file', () => {
    expect(() => inspectBackup(join(root, 'nowhere.tgbackup'))).toThrow(new BackupInvalidError('not-a-backup'))
  })
})

describe('restoreBackup', () => {
  it('backup → change data → restore brings everything back', () => {
    const ana = seed('Ana Ejemplo')
    const file = join(root, 'backup.tgbackup')
    data.createBackup(file)

    data.clients.update(ana.id, { ...input, displayName: 'Changed After Backup' })
    seed('Created After Backup')
    data.clients.archive(ana.id)

    expect(data.restoreBackup(file)).toMatchObject({ clients: 1, notes: 1 })
    expect(names()).toEqual(['Ana Ejemplo'])
    expect(data.clients.get(ana.id)).toMatchObject({ status: 'active', displayName: 'Ana Ejemplo' })
    expect(data.notes.list(ana.id).map((n) => n.body)).toEqual([note.body])

    // The restored data is live: new writes work and survive reopening.
    seed('After Restore')
    data.close()
    data = new AppData(join(root, 'profile'))
    expect(names()).toEqual(['After Restore', 'Ana Ejemplo'])
  })

  it('keeps a safety copy of the data it replaced', () => {
    seed('Ana Ejemplo')
    const file = join(root, 'backup.tgbackup')
    data.createBackup(file)
    seed('Only In Current Data')
    data.restoreBackup(file)

    const safetyDir = join(dataDirectory(join(root, 'profile')), 'pre-restore')
    const [safety] = readdirSync(safetyDir)
    const copy = new DatabaseSync(join(safetyDir, safety!), { readOnly: true })
    const saved = copy.prepare('SELECT display_name FROM clients ORDER BY display_name').all() as { display_name: string }[]
    expect(saved.map((r) => r.display_name)).toEqual(['Ana Ejemplo', 'Only In Current Data'])
    copy.close()
  })

  it('upgrades a backup made by an older schema version', () => {
    const file = join(root, 'old.tgbackup')
    const old = new DatabaseSync(file)
    old.exec(migrations[0]!.sql)
    old.exec(`PRAGMA user_version = 1; PRAGMA application_id = ${APPLICATION_ID};`)
    old
      .prepare(
        `INSERT INTO clients (id, display_name, source, created_at, updated_at)
         VALUES ('00000000-0000-4000-8000-000000000001', 'Older Backup Client', 'direct', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    old.close()

    expect(data.restoreBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })
    expect(names()).toEqual(['Older Backup Client'])
    expect(data.notes.create('00000000-0000-4000-8000-000000000001', note).ok).toBe(true)
  })

  it('rejects an invalid backup without touching current data', () => {
    seed('Current Client')
    const file = join(root, 'bad.tgbackup')
    writeFileSync(file, 'definitely not a backup '.repeat(100))
    expect(() => data.restoreBackup(file)).toThrow(BackupInvalidError)
    expect(names()).toEqual(['Current Client'])
    expect(existsSync(join(dataDirectory(join(root, 'profile')), 'pre-restore'))).toBe(false)
  })

  it('rolls back to the previous data when the restored data fails verification', () => {
    seed('Backup Client')
    const file = join(root, 'backup.tgbackup')
    data.createBackup(file)
    seed('Current Client')

    expect(() =>
      data.restoreBackup(file, {
        verify: () => {
          throw new Error('simulated failure after the swap')
        }
      })
    ).toThrow(RestoreFailedError)
    expect(names()).toEqual(['Backup Client', 'Current Client'])
    expect(seed('Still Writable').displayName).toBe('Still Writable')

    const dir = dataDirectory(join(root, 'profile'))
    expect(readdirSync(dir).filter((f) => f.includes('replaced') || f.includes('staging'))).toEqual([])
  })
})

describe('backup service', () => {
  function dialogs(save: string | null, open: string | null): BackupDialogs {
    return { chooseSaveTarget: vi.fn(async () => save), chooseBackupFile: vi.fn(async () => open) }
  }

  it('names backups by date', () => {
    expect(defaultBackupName(new Date('2026-10-29T23:00:00.000Z'))).toBe('Tracing Guatemala backup 2026-10-29.tgbackup')
  })

  it('reports cancelled dialogs without changing anything', async () => {
    const service = createBackupService(() => data, dialogs(null, null))
    expect(await service.create()).toEqual({ ok: false, reason: 'cancelled' })
    expect(await service.chooseRestore()).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('creates a backup and returns only the file name', async () => {
    seed()
    const target = join(root, 'nested name.tgbackup')
    const result = await createBackupService(() => data, dialogs(target, null)).create()
    expect(result).toEqual({ ok: true, fileName: 'nested name.tgbackup', clients: 1, notes: 1 })
    expect(JSON.stringify(result)).not.toContain(root)
  })

  it('restores only the checked file, once, by token', async () => {
    seed('Backup Client')
    const file = join(root, 'backup.tgbackup')
    data.createBackup(file)
    seed('Current Client')
    const service = createBackupService(() => data, dialogs(null, file))

    const choice = await service.chooseRestore()
    if (!choice.ok) throw new Error('choice failed')
    expect(choice).toMatchObject({ fileName: 'backup.tgbackup', clients: 1, notes: 1 })
    expect(JSON.stringify(choice)).not.toContain(root)

    expect(await service.restore(crypto.randomUUID())).toEqual({ ok: false, reason: 'expired' })
    expect(await service.restore(choice.token)).toEqual({ ok: true, clients: 1, notes: 1 })
    expect(names()).toEqual(['Backup Client'])
    expect(await service.restore(choice.token)).toEqual({ ok: false, reason: 'expired' })
  })

  it('explains why a chosen file cannot be restored', async () => {
    const file = join(root, 'notes.txt')
    writeFileSync(file, 'plain text '.repeat(100))
    expect(await createBackupService(() => data, dialogs(null, file)).chooseRestore()).toEqual({
      ok: false,
      reason: 'not-a-backup'
    })
  })
})
