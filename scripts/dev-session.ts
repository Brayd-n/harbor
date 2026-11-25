// Local testing without Google: creates (or reuses) a user and prints a session token.
// Usage: node scripts/dev-session.ts <email> [--pending]   (--pending = not past 2FA yet)
// Then in the browser console on http://localhost: document.cookie = "__Host-session=TOKEN; path=/; secure"
import { createSession, upsertGoogleUser } from '../server/auth.ts';
import { createPool, migrate } from '../server/db.ts';

const email = process.argv[2] ?? 'dev@example.com';
const pool = createPool();
await migrate(pool);
const cfg = { origin: '', googleClientId: '', googleClientSecret: '', masterKey: Buffer.from(process.env.MASTER_KEY ?? '', 'hex'), ownerEmail: process.env.OWNER_EMAIL };
const id = await upsertGoogleUser(pool, cfg, `dev:${email}`, email, email.split('@')[0]);
if (!id) throw new Error('account is disabled');
console.log(await createSession(pool, id, !process.argv.includes('--pending')));
await pool.end();
