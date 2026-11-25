import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';

// Connection settings come from the standard PG* environment variables (PGHOST, PGUSER, PGPASSWORD, ...).
export function createPool() {
  return new pg.Pool({ max: 8 });
}

// Runs fn in a transaction as the harbor_app role with app.user_id set, so row-level security
// limits every query to this user's rows. All reads and writes of user data go through here.
export async function withUser<T>(pool: pg.Pool, userId: string, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE harbor_app');
    await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

// Applies server/migrations/*.sql in name order, each once. An advisory lock stops two starting
// containers from racing each other.
export async function migrate(pool: pg.Pool) {
  const dir = new URL('./migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(4243)');
    await client.query('CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM migrations')).rows.map((r) => r.name));
    for (const f of files.filter((f) => !done.has(f))) {
      await client.query('BEGIN');
      await client.query(await readFile(new URL(f, dir), 'utf8'));
      await client.query('INSERT INTO migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.query('SELECT pg_advisory_unlock(4243)').catch(() => {});
    client.release();
  }
}
