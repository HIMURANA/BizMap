import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

export const ROOT = resolve(import.meta.dirname, '..', '..');
const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Add DATABASE_URL=postgres://user:password@localhost:5432/bizmap to .env (see HANDOFF.md, section 3e).');
}

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
pool.on('error', (e) => console.error('[pg] idle client error', e.message));

export type Row = Record<string, unknown>;

export async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}
export async function one<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await pool.query(sql, params)).rows[0] as T | undefined;
}

/** Runs fn inside one transaction on a dedicated client. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function migrate(): Promise<void> {
  await pool.query(readFileSync(resolve(import.meta.dirname, 'schema.sql'), 'utf-8'));
}
