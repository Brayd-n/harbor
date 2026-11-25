import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type pg from 'pg';
import { authRoutes, requireUser, type AuthConfig } from './auth.ts';
import { chatStreamRoute } from './chat.ts';
import { dataKey, seal } from './crypto.ts';
import { withUser } from './db.ts';
import { PROVIDERS, getCatalog, isProvider, splitModel } from './models.ts';

export type Config = AuthConfig & { webDir?: string };

const idParam = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] };

// Scripts and styles only from our own origin; the page can only talk to our own origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export function buildApp(pool: pg.Pool, cfg: Config) {
  // Caddy reaches the container through Docker's private bridge network; trust X-Forwarded-For only from there.
  const app = Fastify({
    // Request logs never include OAuth codes/state or other query values.
    logger: process.env.NODE_ENV !== 'test' && {
      serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] }) },
    },
    trustProxy: 'loopback,uniquelocal',
    bodyLimit: 512 * 1024,
  });

  app.register(cookie);
  app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // CSRF: session cookies are SameSite=Lax, and every state-changing request must also come from our own origin.
  app.addHook('onRequest', async (req, reply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== cfg.origin) {
      return reply.code(403).send({ error: 'Cross-site request blocked.' });
    }
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CSP);
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: `Invalid input: ${err.message}` });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong.' });
  });

  authRoutes(app, pool, cfg);
  app.get('/healthz', async () => ({ ok: true }));

  // Everything under /api needs a session that passed 2FA. User data is only touched through withUser(),
  // so row-level security applies on top of the explicit checks.
  app.register(
    async (api) => {
      api.addHook('preHandler', (req, reply) => requireUser(pool, req, reply));
      const as = <T>(userId: string, fn: (db: pg.PoolClient) => Promise<T>) => withUser(pool, userId, fn);

      api.get('/me', async (req) => ({ email: req.user.email, name: req.user.name, role: req.user.role }));

      // --- Provider keys (never sent back, only the last 4 characters) ---

      api.get('/providers', async (req) => {
        const rows = await as(req.user.id, async (db) => (await db.query('SELECT provider, last4, created_at FROM provider_keys')).rows);
        return Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, key: rows.find((r) => r.provider === id) ?? null }));
      });

      api.put(
        '/providers/:provider',
        {
          schema: {
            body: { type: 'object', required: ['key'], additionalProperties: false, properties: { key: { type: 'string', minLength: 8, maxLength: 500, pattern: '^\\S+$' } } },
          },
          config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
        },
        async (req, reply) => {
          const { provider } = req.params as { provider: string };
          if (!isProvider(provider)) return reply.code(404).send({ error: 'Unknown provider.' });
          const key = (req.body as { key: string }).key;
          const enc = seal(dataKey(cfg.masterKey, req.user.id, req.user.wrapped), Buffer.from(key), `pk:${req.user.id}:${provider}`);
          await as(req.user.id, (db) =>
            db.query(
              `INSERT INTO provider_keys (user_id, provider, key_enc, last4) VALUES ($1, $2, $3, $4)
               ON CONFLICT (user_id, provider) DO UPDATE SET key_enc = EXCLUDED.key_enc, last4 = EXCLUDED.last4, created_at = now()`,
              [req.user.id, provider, enc, key.slice(-4)],
            ),
          );
          return { ok: true };
        },
      );

      api.delete('/providers/:provider', async (req) => {
        const { provider } = req.params as { provider: string };
        await as(req.user.id, (db) => db.query('DELETE FROM provider_keys WHERE provider = $1', [provider]));
        return { ok: true };
      });

      // Models from the catalog, for the providers this user has keys for.
      api.get('/models', async (req) => {
        const have = await as(req.user.id, async (db) => (await db.query('SELECT provider FROM provider_keys')).rows.map((r) => r.provider));
        return getCatalog().filter((m) => have.includes(m.provider));
      });

      // --- Chats ---

      api.get('/chats', async (req) =>
        as(req.user.id, async (db) => (await db.query('SELECT id, title, model, updated_at FROM chats ORDER BY updated_at DESC LIMIT 500')).rows),
      );

      api.post(
        '/chats',
        { schema: { body: { type: 'object', required: ['model'], additionalProperties: false, properties: { model: { type: 'string', maxLength: 300 } } } } },
        async (req, reply) => {
          const { model } = req.body as { model: string };
          if (!splitModel(model)) return reply.code(400).send({ error: 'Unknown model.' });
          const chat = await as(req.user.id, async (db) => {
            const { rows } = await db.query('INSERT INTO chats (user_id, model) VALUES ($1, $2) RETURNING id, title, model, updated_at', [req.user.id, model]);
            return rows[0];
          });
          return reply.code(201).send(chat);
        },
      );

      api.get('/chats/:id', { schema: { params: idParam } }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const chat = await as(req.user.id, async (db) => {
          const c = await db.query('SELECT id, title, model, updated_at FROM chats WHERE id = $1', [id]);
          if (!c.rows[0]) return null;
          const m = await db.query('SELECT id, role, content, model, usage, created_at FROM messages WHERE chat_id = $1 ORDER BY created_at', [id]);
          return { ...c.rows[0], messages: m.rows };
        });
        return chat ?? reply.code(404).send({ error: 'Not found.' });
      });

      api.patch(
        '/chats/:id',
        { schema: { params: idParam, body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string', maxLength: 200 } } } } },
        async (req, reply) => {
          const { id } = req.params as { id: string };
          const { rowCount } = await as(req.user.id, (db) => db.query('UPDATE chats SET title = $2 WHERE id = $1', [id, (req.body as { title: string }).title]));
          return rowCount ? { ok: true } : reply.code(404).send({ error: 'Not found.' });
        },
      );

      api.delete('/chats/:id', { schema: { params: idParam } }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const { rowCount } = await as(req.user.id, (db) => db.query('DELETE FROM chats WHERE id = $1', [id]));
        return rowCount ? { ok: true } : reply.code(404).send({ error: 'Not found.' });
      });

      chatStreamRoute(api, pool, cfg.masterKey);

      // --- Account ---

      api.get('/account/events', async (req) => {
        const { rows } = await pool.query('SELECT kind, ip, user_agent, created_at FROM auth_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
        return rows;
      });

      api.post('/account/sign-out-everywhere', async (req, reply) => {
        await pool.query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
        reply.clearCookie('__Host-session', { path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
        return { ok: true };
      });

      api.get('/account/export', async (req, reply) => {
        const chats = await as(req.user.id, async (db) => {
          const { rows } = await db.query(
            `SELECT c.id, c.title, c.model, c.created_at, c.updated_at,
                    coalesce((SELECT json_agg(json_build_object('role', m.role, 'content', m.content, 'model', m.model, 'usage', m.usage, 'created_at', m.created_at) ORDER BY m.created_at)
                              FROM messages m WHERE m.chat_id = c.id), '[]') AS messages
             FROM chats c ORDER BY c.created_at`,
          );
          return rows;
        });
        const body = { exported_at: new Date().toISOString(), account: { email: req.user.email, name: req.user.name }, chats };
        return reply.header('Content-Disposition', 'attachment; filename="harbor-export.json"').send(body);
      });

      // Deletes everything: chats, messages, keys, sessions, the wrapped data key with the user row.
      api.delete('/account', async (req, reply) => {
        await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
        reply.clearCookie('__Host-session', { path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
        return { ok: true };
      });

      // --- Owner admin. Runs as the owner database role, which RLS doesn't restrict. ---

      api.register(async (admin) => {
        admin.addHook('preHandler', async (req, reply) => {
          if (req.user.role !== 'owner') return reply.code(404).send({ error: 'Not found.' });
        });
        admin.get('/admin/users', async () => {
          const { rows } = await pool.query(
            `SELECT u.id, u.email, u.name, u.role, u.created_at, u.disabled_at, u.totp_secret_enc IS NOT NULL AS has_2fa,
                    (SELECT count(*)::int FROM chats c WHERE c.user_id = u.id) AS chats,
                    (SELECT count(*)::int FROM messages m WHERE m.user_id = u.id) AS messages,
                    (SELECT max(created_at) FROM auth_events e WHERE e.user_id = u.id) AS last_seen
             FROM users u ORDER BY u.created_at`,
          );
          return rows;
        });
        admin.post(
          '/admin/users/:id/disabled',
          { schema: { params: idParam, body: { type: 'object', required: ['disabled'], properties: { disabled: { type: 'boolean' } } } } },
          async (req, reply) => {
            const { id } = req.params as { id: string };
            if (id === req.user.id) return reply.code(400).send({ error: "You can't disable your own account." });
            const disabled = (req.body as { disabled: boolean }).disabled;
            const { rowCount } = await pool.query('UPDATE users SET disabled_at = CASE WHEN $2 THEN now() END WHERE id = $1', [id, disabled]);
            if (disabled) await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
            return rowCount ? { ok: true } : reply.code(404).send({ error: 'Not found.' });
          },
        );
      });
    },
    { prefix: '/api' },
  );

  // The built React app. /privacy and /terms are plain HTML so Google's reviewers can read them without JS.
  if (cfg.webDir && existsSync(cfg.webDir)) {
    app.register(fastifyStatic, { root: cfg.webDir, wildcard: false, cacheControl: false });
    app.get('/privacy', (_req, reply) => reply.sendFile('privacy.html'));
    app.get('/terms', (_req, reply) => reply.sendFile('terms.html'));
    app.setNotFoundHandler((req, reply) =>
      req.method === 'GET' && !req.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Not found.' }),
    );
  }
  return app;
}
