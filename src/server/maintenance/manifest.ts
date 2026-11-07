import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

// A content fingerprint of every user table, used by the migration maintenance
// command to prove that an upgrade changed no stored row. It holds names, column
// lists, row counts and digests only: never row content.

export interface TableManifest {
  columns: string[]
  rows: number
  sha256: string
}

export type Manifest = Record<string, TableManifest>

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

interface ColumnInfo {
  name: string
  pk: number
}

function columnsOf(db: DatabaseSync, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${quote(table)})`).all() as unknown as ColumnInfo[]
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) return 'N;'
  if (typeof value === 'bigint') return `I${value.toString()};`
  if (typeof value === 'number') return `R${Object.is(value, -0) ? '-0' : String(value)};`
  if (typeof value === 'string') return `T${Buffer.byteLength(value)}:${value};`
  if (value instanceof Uint8Array) return `B${value.byteLength}:${Buffer.from(value).toString('hex')};`
  return 'U;'
}

/** Rows in a fixed order: rowid, or the primary key for a WITHOUT ROWID table. */
function digestTable(db: DatabaseSync, table: string, columns: string[], withoutRowid: boolean, pk: string[]): TableManifest {
  const select = columns.map(quote).join(', ')
  const order = withoutRowid ? pk.map(quote).join(', ') : 'rowid'
  const statement = db.prepare(`SELECT ${select} FROM ${quote(table)} ORDER BY ${order}`)
  statement.setReadBigInts(true)
  const hash = createHash('sha256')
  let rows = 0
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    hash.update(columns.map((column) => serialize(row[column])).join(''))
    hash.update('\n')
    rows += 1
  }
  return { columns, rows, sha256: hash.digest('hex') }
}

interface UserTable {
  name: string
  withoutRowid: boolean
}

export function userTables(db: DatabaseSync): UserTable[] {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string | null }[]
  return rows.map((row) => ({ name: row.name, withoutRowid: /WITHOUT\s+ROWID/i.test(row.sql ?? '') }))
}

/** Digest of one table over an explicit column list (the source's, after an additive migration). */
export function tableDigest(db: DatabaseSync, table: string, columns: string[]): TableManifest {
  const info = userTables(db).find((candidate) => candidate.name === table)
  if (!info) throw new Error('table missing')
  const present = new Set(columnsOf(db, table).map((column) => column.name))
  if (!columns.every((column) => present.has(column))) throw new Error('column missing')
  const pk = columnsOf(db, table)
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name)
  return digestTable(db, table, columns, info.withoutRowid, pk)
}

export function computeManifest(db: DatabaseSync): Manifest {
  const manifest: Manifest = {}
  for (const { name } of userTables(db)) {
    manifest[name] = tableDigest(
      db,
      name,
      columnsOf(db, name).map((column) => column.name)
    )
  }
  return manifest
}

export function manifestsEqual(a: Manifest, b: Manifest): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function rowCounts(manifest: Manifest): { table: string; rows: number }[] {
  return Object.entries(manifest).map(([table, entry]) => ({ table, rows: entry.rows }))
}
