import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from '../config/env.js';

/** Values node:sqlite accepts as bound parameters. */
export type Param = null | number | bigint | string | Uint8Array;

let db: DatabaseSync | null = null;

export function getDatabase(): DatabaseSync {
  if (!db) {
    const dir = dirname(env.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    db = new DatabaseSync(env.dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');
  }
  return db;
}

export function initializeDatabase(): void {
  const schema = readFileSync(resolve(import.meta.dirname, 'schema.sql'), 'utf-8');
  const d = getDatabase();
  d.exec(schema);
  // CREATE TABLE IF NOT EXISTS never adds columns to an existing table, so migrate explicitly.
  const addColumn = (table: string, column: string, type: string) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn('discovery_areas', 'boundary_geojson', 'TEXT');
  addColumn('discovery_areas', 'boundary_method', 'TEXT');
  addColumn('business_locations', 'area_method', 'TEXT');
  addColumn('business_locations', 'dhaka_scope', 'TEXT');
  addColumn('businesses', 'source_confidence', 'REAL');
  addColumn('business_locations', 'admin_division', 'TEXT');
  addColumn('business_locations', 'admin_district', 'TEXT');
  addColumn('business_locations', 'admin_upazila', 'TEXT');
  console.log(`Database ready: ${env.dbPath}`);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Parameter-bound statement wrapper (never interpolate values into SQL). */
export function prepare<T = Record<string, unknown>>(sql: string) {
  const stmt = getDatabase().prepare(sql);
  return {
    run(...args: Param[]) {
      return stmt.run(...args);
    },
    get(...args: Param[]): T | undefined {
      return stmt.get(...args) as T | undefined;
    },
    all(...args: Param[]): T[] {
      return stmt.all(...args) as T[];
    },
  };
}

/** Run `fn` inside a transaction; rolls back and rethrows on error. Executes immediately. */
export function transaction<T>(fn: () => T): T {
  const d = getDatabase();
  d.exec('BEGIN');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (error) {
    d.exec('ROLLBACK');
    throw error;
  }
}
