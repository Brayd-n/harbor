import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import type pg from 'pg';
import { authRoutes, requireUser, type AuthConfig } from './auth.ts';
import { chatStreamRoute } from './chat.ts';
import { deviceApiRoutes, deviceAuthRoutes, wsRoute } from './devices.ts';
import { Hub } from './hub.ts';
import { dataKey, seal } from './crypto.ts';
import { withUser } from './db.ts';
import { PROVIDERS, getCatalog, isProvider, splitModel } from './models.ts';
import { DEFAULT_SETTINGS, settingsSchema } from './saving.ts';

export type Config = AuthConfig & { webDir?: string };

const idParam = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] };

// Scripts and styles only from our own origin; the page can only talk to our own origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

// The desktop app's bundled UI (Tauri) calls the API cross-origin with a bearer token, never cookies.
const DESKTOP_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);

export function buildApp(pool: pg.Pool, cfg: Config, hub = new Hub()) {
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
  // req.ip throws on injected WebSocket test requests (no real socket); everything real has one.
  app.register(rateLimit, { max: 300, timeWindow: '1 minute', keyGenerator: (req) => { try { return req.ip; } catch { return 'unknown'; } } });
  app.register(websocket, { options: { maxPayload: 512 * 1024 } });

  // CORS for the desktop app only. No credentials: it authenticates with a bearer token it holds.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !DESKTOP_ORIGINS.has(origin)) return;
    reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      return reply
        .header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE')
        .header('Access-Control-Allow-Headers', 'authorization, content-type, x-harbor-conn')
        .header('Access-Control-Max-Age', '600')
        .code(204)
        .send();
    }
  });

  // CSRF: session cookies are SameSite=Lax, and every state-changing request must also come from our own origin.
  // Bearer-token requests carry no ambient credentials, and /auth/device/* uses none at all.
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.headers.origin === cfg.origin) return;
    if (req.headers.authorization?.startsWith('Bearer ') || req.url.startsWith('/auth/device/')) return;
    return reply.code(403).send({ error: 'Cross-site request blocked.' });
  });

  app.addHook('onSend', async (req, reply) => {
    // Built JS/CSS/font file names contain a content hash, so browsers can keep them.
    if (req.url.startsWith('/assets/') && reply.statusCode === 200 && !String(reply.getHeader('content-type')).startsWith('text/html')) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    }
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
  deviceAuthRoutes(app, pool, cfg);
  app.register(async (ws) => wsRoute(ws, pool, hub, cfg));
  app.get('/healthz', async () => ({ ok: true }));

  // Everything under /api needs a session that passed 2FA. User data is only touched through withUser(),
  // so row-level security applies on top of the explicit checks.
  app.register(
    async (api) => {
      api.addHook('preHandler', (req, reply) => requireUser(pool, cfg.masterKey, req, reply));
      const as = <T>(userId: string, fn: (db: pg.PoolClient) => Promise<T>) => withUser(pool, userId, fn);

      api.get('/me', async (req) => ({ email: req.user.email, name: req.user.name, role: req.user.role, has_totp: req.user.has_totp, device: req.device }));

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
        as(req.user.id, async (db) => (await db.query('SELECT id, title, model, mode, updated_at FROM chats ORDER BY updated_at DESC LIMIT 500')).rows),
      );

      api.post(
        '/chats',
        {
          schema: {
            body: {
              type: 'object',
              required: ['model'],
              additionalProperties: false,
              properties: { model: { type: 'string', maxLength: 300 }, project_id: { type: 'string', format: 'uuid' } },
            },
          },
        },
        async (req, reply) => {
          const { model, project_id } = req.body as { model: string; project_id?: string };
          if (!splitModel(model)) return reply.code(400).send({ error: 'Unknown model.' });
          // A chat with a project is a Code chat. The project must be this user's (RLS + the foreign key).
          const chat = await as(req.user.id, async (db) => {
            if (project_id && !(await db.query('SELECT 1 FROM projects WHERE id = $1', [project_id])).rowCount) return null;
            const { rows } = await db.query(
              'INSERT INTO chats (user_id, model, mode, project_id) VALUES ($1, $2, $3, $4) RETURNING id, title, model, mode, project_id, updated_at',
              [req.user.id, model, project_id ? 'code' : 'chat', project_id ?? null],
            );
            return rows[0];
          });
          return chat ? reply.code(201).send(chat) : reply.code(404).send({ error: 'Not found.' });
        },
      );

      api.get('/chats/:id', { schema: { params: idParam } }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const chat = await as(req.user.id, async (db) => {
          const c = await db.query(`SELECT c.id, c.title, c.model, c.mode, c.project_id, c.updated_at, c.summary_until, p.name AS project, pp.path
             FROM chats c LEFT JOIN projects p ON p.id = c.project_id LEFT JOIN project_paths pp ON pp.project_id = c.project_id AND pp.device_id = $2
             WHERE c.id = $1`, [id, req.device?.id ?? null]);
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

      chatStreamRoute(api, pool, cfg.masterKey, hub);
      deviceApiRoutes(api, pool, hub);

      // --- Token saving ---

      api.get('/settings', async (req) =>
        as(req.user.id, async (db) => ({ ...DEFAULT_SETTINGS, ...(await db.query('SELECT data FROM user_settings')).rows[0]?.data })),
      );

      api.put('/settings', { schema: { body: settingsSchema } }, async (req) =>
        as(req.user.id, async (db) => {
          const { rows } = await db.query(
            `INSERT INTO user_settings (user_id, data) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET data = user_settings.data || EXCLUDED.data RETURNING data`,
            [req.user.id, JSON.stringify(req.body)],
          );
          return { ...DEFAULT_SETTINGS, ...rows[0].data };
        }),
      );

      // Savings meter: spent and saved, this month and all time (USD).
      api.get('/usage', async (req) =>
        as(req.user.id, async (db) => {
          const { rows } = await db.query(
            `SELECT coalesce(sum((usage->>'cost')::numeric) FILTER (WHERE created_at >= date_trunc('month', now())), 0)::float AS month_cost,
                    coalesce(sum((usage->>'saved')::numeric) FILTER (WHERE created_at >= date_trunc('month', now())), 0)::float AS month_saved,
                    coalesce(sum((usage->>'cost')::numeric), 0)::float AS total_cost,
                    coalesce(sum((usage->>'saved')::numeric), 0)::float AS total_saved
             FROM messages WHERE role = 'assistant' AND usage ? 'cost'`,
          );
          return rows[0];
        }),
      );

      // --- Account ---

      api.get('/account/events', async (req) => {
        const { rows } = await pool.query('SELECT kind, ip, user_agent, created_at FROM auth_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
        return rows;
      });

      api.post('/account/sign-out-everywhere', async (req, reply) => {
        await pool.query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
        await pool.query('UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.user.id]);
        await pool.query('DELETE FROM refresh_tokens t USING devices d WHERE d.id = t.device_id AND d.user_id = $1', [req.user.id]);
        hub.kickUser(req.user.id);
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
        hub.kickUser(req.user.id);
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
            if (disabled) {
              await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
              hub.kickUser(id);
            }
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
