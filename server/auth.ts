import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import QRCode from 'qrcode';
import { base32, dataKey, newWrappedDataKey, seal, unseal, verifyTotp } from './crypto.ts';

export const SESSION_COOKIE = '__Host-session';
const OAUTH_COOKIE = '__Host-oauth';
const SESSION_DAYS = 30;
const PENDING_MINUTES = 10; // a signed-in-but-not-yet-2FA session lives this long
const MAX_MFA_FAILURES = 10; // per 15 minutes

const hash = (token: string) => createHash('sha256').update(token).digest();
const b64url = (b: Buffer) => b.toString('base64url');
const cookieOpts = { path: '/', httpOnly: true, secure: true, sameSite: 'lax' as const };

export type AuthConfig = { origin: string; googleClientId: string; googleClientSecret: string; masterKey: Buffer; ownerEmail?: string };
export type User = { id: string; email: string; name: string; role: 'owner' | 'user'; wrapped: Buffer; mfa_ok: boolean; has_totp: boolean };

export async function createSession(pool: pg.Pool, userId: string, mfaOk: boolean): Promise<string> {
  const token = b64url(randomBytes(32));
  const ttl = mfaOk ? `${SESSION_DAYS} days` : `${PENDING_MINUTES} minutes`;
  await pool.query(`INSERT INTO sessions (token_hash, user_id, mfa_ok, expires_at) VALUES ($1, $2, $3, now() + $4::interval)`, [hash(token), userId, mfaOk, ttl]);
  return token;
}

async function sessionUser(pool: pg.Pool, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.data_key_wrapped AS wrapped, s.mfa_ok, u.totp_secret_enc IS NOT NULL AS has_totp
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [hash(token)],
  );
  return rows[0] ?? null;
}

export async function logEvent(pool: pg.Pool, userId: string, kind: string, req: FastifyRequest) {
  await pool.query('INSERT INTO auth_events (user_id, kind, ip, user_agent) VALUES ($1, $2, $3, $4)', [
    userId,
    kind,
    req.ip,
    String(req.headers['user-agent'] ?? '').slice(0, 300),
  ]);
}

const recoveryHash = (code: string) => hash(code.toLowerCase().replace(/[^a-z2-7]/g, ''));

export function authRoutes(app: FastifyInstance, pool: pg.Pool, cfg: AuthConfig) {
  const redirectUri = `${cfg.origin}/auth/google/callback`;
  const loginLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };
  const codeLimit = { rateLimit: { max: 6, timeWindow: '1 minute' } };
  const codeBody = { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 20 } } };
  const key = (u: User) => dataKey(cfg.masterKey, u.id, u.wrapped);

  // Google sign-in: OpenID Connect authorization-code flow with PKCE, state and nonce.
  // The ID token comes straight from Google's token endpoint over TLS (not through the browser),
  // so per OIDC Core 3.1.3.7 its claims are checked without verifying the JWT signature.
  app.get('/auth/google', { config: loginLimit }, async (_req, reply) => {
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    reply.setCookie(OAUTH_COOKIE, JSON.stringify({ state, nonce, verifier }), { ...cookieOpts, maxAge: 600 });
    const params = new URLSearchParams({
      client_id: cfg.googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>('/auth/google/callback', { config: loginLimit }, async (req, reply) => {
    let saved: { state?: string; nonce?: string; verifier?: string } = {};
    try {
      saved = JSON.parse(req.cookies[OAUTH_COOKIE] ?? '{}');
    } catch {}
    reply.clearCookie(OAUTH_COOKIE, cookieOpts);
    const { code, state } = req.query;
    if (!code || !state || !saved.state || state !== saved.state) {
      req.log.warn('sign-in: missing code or state mismatch');
      return reply.redirect('/?login=failed');
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        code,
        client_id: cfg.googleClientId,
        client_secret: cfg.googleClientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: saved.verifier ?? '',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      req.log.warn({ status: res.status }, 'sign-in: token exchange failed');
      return reply.redirect('/?login=failed');
    }
    const { id_token } = (await res.json()) as { id_token?: string };
    const claims = JSON.parse(Buffer.from(String(id_token).split('.')[1] ?? '', 'base64url').toString() || '{}');
    const valid =
      ['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) &&
      claims.aud === cfg.googleClientId &&
      claims.exp * 1000 > Date.now() &&
      claims.nonce === saved.nonce &&
      claims.email_verified === true &&
      typeof claims.sub === 'string';
    if (!valid) {
      req.log.warn('sign-in: ID token claims rejected');
      return reply.redirect('/?login=failed');
    }

    const userId = await upsertGoogleUser(pool, cfg, claims.sub, claims.email, String(claims.name ?? ''));
    if (!userId) return reply.redirect('/?login=disabled');
    await logEvent(pool, userId, 'sign_in', req);
    await pool.query('DELETE FROM sessions WHERE expires_at < now()');
    reply.setCookie(SESSION_COOKIE, await createSession(pool, userId, false), { ...cookieOpts, maxAge: SESSION_DAYS * 86400 });
    return reply.redirect('/');
  });

  // What the web app should show: sign-in, 2FA setup, 2FA code, or the app.
  app.get('/auth/state', async (req) => {
    const u = await sessionUser(pool, req.cookies[SESSION_COOKIE]);
    if (!u) return { step: 'signed_out' };
    const user = { email: u.email, name: u.name, role: u.role };
    return { step: u.mfa_ok ? 'ready' : u.has_totp ? 'verify' : 'enroll', user };
  });

  // The routes below need a session that hasn't passed 2FA yet.
  app.register(async (pending) => {
    pending.addHook('preHandler', async (req, reply) => {
      const u = await sessionUser(pool, req.cookies[SESSION_COOKIE]);
      if (!u || u.mfa_ok) return reply.code(401).send({ error: 'Please sign in again.' });
      req.user = u;
    });

    // Upgrades the session: the old token is deleted and a fresh 30-day one replaces it.
    const finish = async (req: FastifyRequest, reply: FastifyReply) => {
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash(req.cookies[SESSION_COOKIE]!)]);
      reply.setCookie(SESSION_COOKIE, await createSession(pool, req.user.id, true), { ...cookieOpts, maxAge: SESSION_DAYS * 86400 });
    };

    pending.post('/auth/2fa/setup', async (req, reply) => {
      if (req.user.has_totp) return reply.code(409).send({ error: 'Two-factor is already set up.' });
      const secret = randomBytes(20);
      await pool.query('UPDATE users SET totp_pending_enc = $2 WHERE id = $1', [req.user.id, seal(key(req.user), secret, `totp:${req.user.id}`)]);
      const label = encodeURIComponent(`Harbor:${req.user.email}`);
      const uri = `otpauth://totp/${label}?secret=${base32(secret)}&issuer=Harbor&algorithm=SHA1&digits=6&period=30`;
      return { secret: base32(secret).replace(/(.{4})/g, '$1 ').trim(), qr: await QRCode.toString(uri, { type: 'svg', margin: 0 }) };
    });

    pending.post('/auth/2fa/enroll', { schema: { body: codeBody }, config: codeLimit }, async (req, reply) => {
      if (req.user.has_totp) return reply.code(409).send({ error: 'Two-factor is already set up.' });
      const { rows } = await pool.query('SELECT totp_pending_enc FROM users WHERE id = $1', [req.user.id]);
      if (!rows[0].totp_pending_enc) return reply.code(400).send({ error: 'Start setup first.' });
      const secret = unseal(key(req.user), rows[0].totp_pending_enc, `totp:${req.user.id}`);
      const step = verifyTotp(secret, (req.body as { code: string }).code.replace(/\s/g, ''), 0);
      if (step === null) return reply.code(400).send({ error: "That code didn't match. Check your phone's clock and try the next one." });

      const codes = Array.from({ length: 10 }, () => base32(randomBytes(5)).toLowerCase().replace(/(.{4})(.{4})/, '$1-$2'));
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('UPDATE users SET totp_secret_enc = $2, totp_pending_enc = NULL, totp_last_step = $3 WHERE id = $1', [
          req.user.id,
          rows[0].totp_pending_enc,
          step,
        ]);
        await db.query('DELETE FROM recovery_codes WHERE user_id = $1', [req.user.id]);
        for (const c of codes) await db.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)', [req.user.id, recoveryHash(c)]);
        await db.query('COMMIT');
      } catch (e) {
        await db.query('ROLLBACK');
        throw e;
      } finally {
        db.release();
      }
      await logEvent(pool, req.user.id, '2fa_enabled', req);
      await finish(req, reply);
      return { recoveryCodes: codes };
    });

    pending.post('/auth/2fa/verify', { schema: { body: codeBody }, config: codeLimit }, async (req, reply) => {
      if (!req.user.has_totp) return reply.code(400).send({ error: 'Set up two-factor first.' });
      const { rows: fails } = await pool.query(
        "SELECT count(*)::int AS n FROM auth_events WHERE user_id = $1 AND kind = '2fa_failed' AND created_at > now() - interval '15 minutes'",
        [req.user.id],
      );
      if (fails[0].n >= MAX_MFA_FAILURES) return reply.code(429).send({ error: 'Too many wrong codes. Wait 15 minutes and try again.' });

      const code = (req.body as { code: string }).code.trim();
      let ok = false;
      if (/^\d{3}\s?\d{3}$/.test(code)) {
        const { rows } = await pool.query('SELECT totp_secret_enc, totp_last_step FROM users WHERE id = $1', [req.user.id]);
        const step = verifyTotp(unseal(key(req.user), rows[0].totp_secret_enc, `totp:${req.user.id}`), code.replace(/\s/g, ''), Number(rows[0].totp_last_step));
        // The WHERE clause makes the step update atomic, so two requests can't both use one code.
        if (step !== null) ok = (await pool.query('UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2', [req.user.id, step])).rowCount === 1;
      } else {
        ok = (await pool.query('DELETE FROM recovery_codes WHERE user_id = $1 AND code_hash = $2', [req.user.id, recoveryHash(code)])).rowCount === 1;
        if (ok) await logEvent(pool, req.user.id, 'recovery_code_used', req);
      }
      if (!ok) {
        await logEvent(pool, req.user.id, '2fa_failed', req);
        return reply.code(400).send({ error: "That code didn't work." });
      }
      await logEvent(pool, req.user.id, '2fa_passed', req);
      await finish(req, reply);
      return { ok: true };
    });
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash(token)]);
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return { ok: true };
  });
}

// Returns the user's id, or null if the account is disabled.
export async function upsertGoogleUser(pool: pg.Pool, cfg: AuthConfig, sub: string, email: string, name: string): Promise<string | null> {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO users (id, google_sub, email, name, data_key_wrapped) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
     RETURNING id, disabled_at`,
    [id, sub, email, name.slice(0, 200), newWrappedDataKey(cfg.masterKey, id)],
  );
  if (rows[0].disabled_at) return null;
  if (cfg.ownerEmail && email.toLowerCase() === cfg.ownerEmail.toLowerCase()) {
    await pool.query("UPDATE users SET role = 'owner' WHERE id = $1", [rows[0].id]);
  }
  return rows[0].id;
}

// For /api: a session that has passed 2FA, on an account that isn't disabled.
export async function requireUser(pool: pg.Pool, req: FastifyRequest, reply: FastifyReply) {
  const user = await sessionUser(pool, req.cookies[SESSION_COOKIE]);
  if (!user || !user.mfa_ok) return reply.code(401).send({ error: 'Please sign in.' });
  req.user = user;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}
