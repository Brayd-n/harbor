import { buildApp } from './app.ts';
import { createPool, migrate } from './db.ts';
import { refreshCatalog } from './models.ts';

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
};

// 32-byte hex key that wraps every user's data key. Lives only in /etc/harbor/app.env, never in the database.
const masterKey = Buffer.from(env('MASTER_KEY'), 'hex');
if (masterKey.length !== 32) throw new Error('MASTER_KEY must be 64 hex characters');

const pool = createPool();
await migrate(pool);
const app = buildApp(pool, {
  origin: env('APP_ORIGIN', 'http://localhost:3000'),
  googleClientId: env('GOOGLE_CLIENT_ID', ''),
  googleClientSecret: env('GOOGLE_CLIENT_SECRET', ''),
  ownerEmail: env('OWNER_EMAIL', ''),
  masterKey,
  webDir: new URL('../dist/', import.meta.url).pathname,
});
await refreshCatalog(app.log);
setInterval(() => refreshCatalog(app.log), 24 * 3600_000).unref();
await app.listen({ host: env('HOST', '127.0.0.1'), port: Number(env('PORT', '3000')) });
