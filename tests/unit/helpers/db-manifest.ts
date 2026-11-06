import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

// A canonical, content-hashing manifest of a SQLite database (#209): every table's
// CREATE statement, row count and a SHA-256 over all its rows in primary-key order,
// plus every index and trigger definition. Two manifests being equal means the
// durable content and schema are identical. Test helper only; fictional data.

export interface TableManifest {
  sql: string
  rowCount: number
  rowsSha256: string
}

export interface SchemaObject {
  type: 'index' | 'trigger'
  table: string
  sql: string
}

export interface DbManifest {
  tables: Record<string, TableManifest>
  /** Indexes and triggers by name. */
  objects: Record<string, SchemaObject>
}

/** The tables migration 10 adds. A v9 -> v10 comparison excludes exactly these (and their indexes/triggers). */
export const OWNERSHIP_TABLES = ['client_ownership', 'client_grants', 'case_grants', 'ownership_events'] as const

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]
  return rows.map((r) => r.name)
}

function orderBy(db: DatabaseSync, table: string): string {
  const info = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string; pk: number }[]
  const keys = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk)
  // Every table in this schema has a primary key; fall back to all columns so ordering stays total.
  return (keys.length > 0 ? keys : info).map((c) => quote(c.name)).join(', ')
}

const serialize = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))

export function manifestOf(db: DatabaseSync): DbManifest {
  const tables: Record<string, TableManifest> = {}
  for (const name of tableNames(db)) {
    const create = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string }
    const rows = db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${orderBy(db, name)}`).all() as Record<string, unknown>[]
    const hash = createHash('sha256')
    for (const row of rows) hash.update(`${serialize(Object.values(row))}\n`)
    tables[name] = { sql: create.sql, rowCount: rows.length, rowsSha256: hash.digest('hex') }
  }
  const objects: Record<string, SchemaObject> = {}
  const rows = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name")
    .all() as { type: 'index' | 'trigger'; name: string; tbl_name: string; sql: string }[]
  for (const r of rows) objects[r.name] = { type: r.type, table: r.tbl_name, sql: r.sql }
  return { tables, objects }
}

/**
 * Differences between two manifests as readable strings (empty = identical), ignoring the named
 * tables and any index or trigger attached to them.
 */
export function diffManifests(before: DbManifest, after: DbManifest, excludeTables: readonly string[] = []): string[] {
  const skip = new Set(excludeTables)
  const problems: string[] = []
  const names = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])
  for (const name of [...names].sort()) {
    if (skip.has(name)) continue
    const a = before.tables[name]
    const b = after.tables[name]
    if (!a) problems.push(`table ${name} appeared`)
    else if (!b) problems.push(`table ${name} disappeared`)
    else {
      if (a.sql !== b.sql) problems.push(`table ${name}: CREATE statement differs`)
      if (a.rowCount !== b.rowCount) problems.push(`table ${name}: row count ${a.rowCount} -> ${b.rowCount}`)
      if (a.rowsSha256 !== b.rowsSha256) problems.push(`table ${name}: row hash differs`)
    }
  }
  const objectNames = new Set([...Object.keys(before.objects), ...Object.keys(after.objects)])
  for (const name of [...objectNames].sort()) {
    const a = before.objects[name]
    const b = after.objects[name]
    if (skip.has((a ?? b)!.table)) continue
    if (!a) problems.push(`${b!.type} ${name} appeared`)
    else if (!b) problems.push(`${a.type} ${name} disappeared`)
    else if (a.sql !== b.sql) problems.push(`${a.type} ${name}: definition differs`)
  }
  return problems
}

/**
 * For every foreign key in the schema, how many child rows have a parent and how many are orphans.
 * Equal before/after means every parent-child relationship survived.
 */
export function relationshipCounts(db: DatabaseSync): Record<string, { linked: number; orphaned: number }> {
  const result: Record<string, { linked: number; orphaned: number }> = {}
  for (const table of tableNames(db)) {
    const keys = db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all() as { table: string; from: string; to: string | null }[]
    for (const key of keys) {
      const parentColumn = key.to ?? 'rowid'
      const linked = (
        db
          .prepare(
            `SELECT count(*) AS n FROM ${quote(table)} c WHERE EXISTS (SELECT 1 FROM ${quote(key.table)} p WHERE p.${quote(parentColumn)} = c.${quote(key.from)})`
          )
          .get() as { n: number }
      ).n
      const total = (db.prepare(`SELECT count(*) AS n FROM ${quote(table)} c WHERE c.${quote(key.from)} IS NOT NULL`).get() as { n: number }).n
      result[`${table}.${key.from} -> ${key.table}`] = { linked, orphaned: total - linked }
    }
  }
  return result
}

/** relationshipCounts restricted to tables that exist in `keep` (so new tables don't count). */
export function relationshipCountsExcluding(db: DatabaseSync, excludeTables: readonly string[]): Record<string, { linked: number; orphaned: number }> {
  const all = relationshipCounts(db)
  return Object.fromEntries(Object.entries(all).filter(([key]) => !excludeTables.includes(key.split('.')[0]!)))
}

export function integrityOk(db: DatabaseSync): boolean {
  const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
  return rows.length === 1 && rows[0]?.integrity_check === 'ok'
}

export function foreignKeyViolations(db: DatabaseSync): unknown[] {
  return db.prepare('PRAGMA foreign_key_check').all()
}
