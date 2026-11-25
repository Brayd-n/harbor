// Desktop devices: device-code linking, rotating refresh tokens, the device list, Code mode
// projects, image uploads and the WebSocket endpoint.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ACCESS_TTL_MS, SESSION_COOKIE, deviceUser, hash, logEvent, sessionUser, signAccess, type AuthConfig } from './auth.ts';
import { withUser } from './db.ts';
import type { Conn, Hub } from './hub.ts';

const CODE_MINUTES = 10;
const REFRESH_DAYS = 60;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels, so codes don't spell words
const MAX_BLOB = 5 * 1024 * 1024;
const BLOB_QUOTA = 200 * 1024 * 1024;

const str = (max: number) => ({ type: 'string', maxLength: max });
export const infoSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { os: str(100), os_version: str(100), arch: str(50), hostname: str(255), home_dir: str(1000), shell: str(200) },
};
type Info = Partial<Record<'os' | 'os_version' | 'arch' | 'hostname' | 'home_dir' | 'shell', string>>;
const uuid = { type: 'string', format: 'uuid' };
const idParam = { type: 'object', properties: { id: uuid }, required: ['id'] };

const userCode = () => Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join('').replace(/^(.{4})/, '$1-');
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z]/g, '').replace(/^(.{4})/, '$1-');

async function issueTokens(pool: pg.Pool, master: Buffer, deviceId: string) {
  const refresh = `hrt_${randomBytes(32).toString('base64url')}`;
  await pool.query(`INSERT INTO refresh_tokens (token_hash, device_id, expires_at) VALUES ($1, $2, now() + interval '${REFRESH_DAYS} days')`, [hash(refresh), deviceId]);
  return { access_token: signAccess(master, deviceId), refresh_token: refresh, expires_in: ACCESS_TTL_MS / 1000 };
}

async function updateInfo(db: pg.PoolClient | pg.Pool, deviceId: string, info: Info) {
  await db.query(
    `UPDATE devices SET os = coalesce($2, os), os_version = coalesce($3, os_version), arch = coalesce($4, arch), hostname = coalesce($5, hostname),
            home_dir = coalesce($6, home_dir), shell = coalesce($7, shell), last_seen = now() WHERE id = $1`,
    [deviceId, info.os, info.os_version, info.arch, info.hostname, info.home_dir, info.shell],
  );
}

// Unauthenticated endpoints the desktop app calls before it has a token.
export function deviceAuthRoutes(app: FastifyInstance, pool: pg.Pool, cfg: AuthConfig) {
  const limit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  app.post(
    '/auth/device/start',
    { schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, info: infoSchema } } }, config: limit },
    async (req) => {
      const { name, info } = req.body as { name: string; info?: Info };
      const device_code = `hdc_${randomBytes(32).toString('base64url')}`;
      const user_code = userCode();
      await pool.query('DELETE FROM device_codes WHERE expires_at < now()');
      await pool.query(`INSERT INTO device_codes (code_hash, user_code, name, info, expires_at) VALUES ($1, $2, $3, $4, now() + interval '${CODE_MINUTES} minutes')`, [
        hash(device_code),
        user_code,
        name,
        JSON.stringify(info ?? {}),
      ]);
      return { device_code, user_code, verification_uri: `${cfg.origin}/link?code=${user_code}`, expires_in: CODE_MINUTES * 60, interval: 3 };
    },
  );

  // Polled by the app. Pending until a signed-in browser approves the code; then one token pair, once.
  app.post(
    '/auth/device/token',
    { schema: { body: { type: 'object', required: ['device_code'], properties: { device_code: { type: 'string', maxLength: 100 } } } }, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { rows } = await pool.query(
        'DELETE FROM device_codes WHERE code_hash = $1 AND expires_at > now() AND device_id IS NOT NULL RETURNING device_id',
        [hash((req.body as { device_code: string }).device_code)],
      );
      if (rows[0]) return issueTokens(pool, cfg.masterKey, rows[0].device_id);
      const waiting = await pool.query('SELECT 1 FROM device_codes WHERE code_hash = $1 AND expires_at > now()', [hash((req.body as { device_code: string }).device_code)]);
      return waiting.rowCount ? reply.code(428).send({ error: 'pending' }) : reply.code(400).send({ error: 'This code expired. Start again.' });
    },
  );

  // Rotation: each refresh token works once. Seeing a used one again means a copy exists, so the device is revoked.
  app.post(
    '/auth/device/refresh',
    { schema: { body: { type: 'object', required: ['refresh_token'], properties: { refresh_token: { type: 'string', maxLength: 100 } } } }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const h = hash((req.body as { refresh_token: string }).refresh_token);
      const { rows } = await pool.query(
        `SELECT t.device_id, t.used_at, t.expires_at < now() AS expired, d.user_id, d.revoked_at, u.disabled_at
         FROM refresh_tokens t JOIN devices d ON d.id = t.device_id JOIN users u ON u.id = d.user_id WHERE t.token_hash = $1`,
        [h],
      );
      const t = rows[0];
      if (!t || t.expired || t.revoked_at || t.disabled_at) return reply.code(401).send({ error: 'Please link this device again.' });
      const claimed = await pool.query('UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL', [h]);
      if (!claimed.rowCount) {
        await pool.query('UPDATE devices SET revoked_at = now() WHERE id = $1', [t.device_id]);
        await pool.query('DELETE FROM refresh_tokens WHERE device_id = $1', [t.device_id]);
        await logEvent(pool, t.user_id, 'refresh_token_reused', req, t.device_id);
        return reply.code(401).send({ error: 'Please link this device again.' });
      }
      await pool.query('DELETE FROM refresh_tokens WHERE device_id = $1 AND used_at < now() - interval \'1 day\'', [t.device_id]);
      await pool.query('UPDATE devices SET last_seen = now() WHERE id = $1', [t.device_id]);
      return issueTokens(pool, cfg.masterKey, t.device_id);
    },
  );
}

// Routes under /api (the caller is already signed in, by session cookie or device token).
export function deviceApiRoutes(api: FastifyInstance, pool: pg.Pool, hub: Hub) {
  const as = <T>(userId: string, fn: (db: pg.PoolClient) => Promise<T>) => withUser(pool, userId, fn);

  // What the user is about to approve. Only codes still waiting.
  api.get('/device-codes/:code', async (req, reply) => {
    const { rows } = await pool.query('SELECT name, info FROM device_codes WHERE user_code = $1 AND expires_at > now() AND device_id IS NULL', [
      normCode((req.params as { code: string }).code),
    ]);
    return rows[0] ?? reply.code(404).send({ error: 'That code is wrong or expired.' });
  });

  // Approving a link needs the browser session (with 2FA). A device can't link more devices.
  api.post(
    '/devices/link',
    { schema: { body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', maxLength: 20 }, name: { type: 'string', minLength: 1, maxLength: 80 } } } }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (req.device) return reply.code(403).send({ error: 'Approve new devices from the web app.' });
      const { code, name } = req.body as { code: string; name?: string };
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        const { rows } = await db.query('SELECT code_hash, name, info FROM device_codes WHERE user_code = $1 AND expires_at > now() AND device_id IS NULL FOR UPDATE', [normCode(code)]);
        if (!rows[0]) {
          await db.query('ROLLBACK');
          return reply.code(404).send({ error: 'That code is wrong or expired.' });
        }
        const info = rows[0].info as Info;
        const dev = await db.query('INSERT INTO devices (user_id, name) VALUES ($1, $2) RETURNING id', [req.user.id, name ?? rows[0].name]);
        await updateInfo(db, dev.rows[0].id, info);
        await db.query('UPDATE device_codes SET device_id = $2 WHERE code_hash = $1', [rows[0].code_hash, dev.rows[0].id]);
        await db.query('COMMIT');
        await logEvent(pool, req.user.id, 'device_linked', req, dev.rows[0].id);
        return { ok: true, id: dev.rows[0].id };
      } catch (e) {
        await db.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        db.release();
      }
    },
  );

  api.get('/devices', async (req) =>
    as(req.user.id, async (db) => {
      const { rows } = await db.query(
        'SELECT id, name, os, os_version, arch, hostname, home_dir, shell, last_seen, created_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at',
      );
      return rows.map((d) => ({ ...d, current: d.id === req.device?.id }));
    }),
  );

  api.get('/devices/me', async (req, reply) => req.device ?? reply.code(404).send({ error: 'Not a device.' }));

  api.delete('/devices/:id', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rowCount } = await as(req.user.id, (db) => db.query('UPDATE devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]));
    if (!rowCount) return reply.code(404).send({ error: 'Not found.' });
    await pool.query('DELETE FROM refresh_tokens WHERE device_id = $1', [id]);
    hub.kickDevice(id);
    await logEvent(pool, req.user.id, 'device_revoked', req, id);
    return { ok: true };
  });

  // --- Code mode projects: one project, a folder per device ---

  api.get('/projects', async (req) =>
    as(req.user.id, async (db) => {
      const { rows } = await db.query(
        `SELECT p.id, p.name, pp.path FROM projects p LEFT JOIN project_paths pp ON pp.project_id = p.id AND pp.device_id = $1 ORDER BY p.created_at DESC`,
        [req.device?.id ?? null],
      );
      return rows;
    }),
  );

  const pathBody = (extra: object = {}) => ({
    type: 'object',
    additionalProperties: false,
    required: ['path', ...Object.keys(extra)],
    properties: { path: { type: 'string', minLength: 1, maxLength: 1000 }, ...extra },
  });

  api.post('/projects', { schema: { body: pathBody({ name: { type: 'string', minLength: 1, maxLength: 120 } }) } }, async (req, reply) => {
    if (!req.device) return reply.code(403).send({ error: 'Open folders from the desktop app.' });
    const { name, path } = req.body as { name: string; path: string };
    const project = await as(req.user.id, async (db) => {
      const { rows } = await db.query('INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id, name', [req.user.id, name]);
      await db.query('INSERT INTO project_paths (project_id, device_id, user_id, path) VALUES ($1, $2, $3, $4)', [rows[0].id, req.device!.id, req.user.id, path]);
      return { ...rows[0], path };
    });
    return reply.code(201).send(project);
  });

  api.put('/projects/:id/path', { schema: { params: idParam, body: pathBody() } }, async (req, reply) => {
    if (!req.device) return reply.code(403).send({ error: 'Open folders from the desktop app.' });
    const { id } = req.params as { id: string };
    const { path } = req.body as { path: string };
    const ok = await as(req.user.id, async (db) => {
      if (!(await db.query('SELECT 1 FROM projects WHERE id = $1', [id])).rowCount) return false;
      await db.query(
        `INSERT INTO project_paths (project_id, device_id, user_id, path) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, device_id) DO UPDATE SET path = EXCLUDED.path`,
        [id, req.device!.id, req.user.id, path],
      );
      return true;
    });
    return ok ? { ok: true } : reply.code(404).send({ error: 'Not found.' });
  });

  // --- Audit log ---

  api.get('/chats/:id/tool-runs', { schema: { params: idParam } }, async (req) =>
    as(req.user.id, async (db) => {
      const { rows } = await db.query(
        `SELECT r.id, r.tool, r.input, r.decision, r.exit_code, r.duration_ms, r.is_error, r.created_at, d.name AS device
         FROM tool_runs r JOIN devices d ON d.id = r.device_id WHERE r.chat_id = $1 ORDER BY r.created_at DESC LIMIT 500`,
        [(req.params as { id: string }).id],
      );
      return rows;
    }),
  );

  // --- Image uploads (already downscaled by the client) ---

  api.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: MAX_BLOB }, (_req, body, done) => done(null, body));

  api.post('/blobs', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const data = req.body as Buffer;
    const mime = Buffer.isBuffer(data) ? sniffImage(data) : null;
    if (!mime) return reply.code(400).send({ error: 'Only PNG, JPEG, GIF and WebP images.' });
    const sha = createHash('sha256').update(data).digest();
    const id = await as(req.user.id, async (db) => {
      const same = await db.query('SELECT id FROM blobs WHERE sha256 = $1', [sha]);
      if (same.rows[0]) return same.rows[0].id as string;
      const used = await db.query('SELECT coalesce(sum(size), 0)::bigint AS n FROM blobs');
      if (Number(used.rows[0].n) + data.length > BLOB_QUOTA) return null;
      const { rows } = await db.query('INSERT INTO blobs (user_id, sha256, mime, size, data) VALUES ($1, $2, $3, $4, $5) RETURNING id', [req.user.id, sha, mime, data.length, data]);
      return rows[0].id as string;
    });
    return id ? reply.code(201).send({ id, mime }) : reply.code(413).send({ error: 'Image storage is full (200 MB).' });
  });

  api.get('/blobs/:id', { schema: { params: idParam } }, async (req, reply) => {
    const row = await as(req.user.id, async (db) => (await db.query('SELECT mime, data FROM blobs WHERE id = $1', [(req.params as { id: string }).id])).rows[0]);
    if (!row) return reply.code(404).send({ error: 'Not found.' });
    return reply.header('Cache-Control', 'private, max-age=31536000, immutable').type(row.mime).send(row.data);
  });
}

// MIME type from magic bytes, never from the client's header or file name.
export function sniffImage(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// /ws: browsers authenticate with the session cookie (and must come from our own origin, so another
// site can't open a socket with it); the desktop app sends its access token as the first message.
export function wsRoute(app: FastifyInstance, pool: pg.Pool, hub: Hub, cfg: AuthConfig) {
  app.get('/ws', { websocket: true }, async (socket, req) => {
    const send = (o: object) => socket.readyState === 1 && socket.send(JSON.stringify(o));
    let conn: Conn | null = null;

    const start = (userId: string, deviceId: string | null) => {
      conn = hub.add({ userId, deviceId, send, close: () => socket.close(4001, 'revoked') });
      send({ t: 'hello', connId: conn.id, deviceId });
    };

    const handle = async (raw: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!conn) {
        if (msg.t !== 'auth' || typeof msg.token !== 'string') return socket.close(4401, 'auth');
        const found = await deviceUser(pool, cfg.masterKey, msg.token);
        if (!found) return socket.close(4401, 'auth');
        start(found.user.id, found.device.id);
        return;
      }
      if (msg.t === 'tool_result') hub.onResult(conn, msg);
      else if (msg.t === 'info' && conn.deviceId && msg.info && typeof msg.info === 'object') {
        const info = Object.fromEntries(
          Object.entries(msg.info as Record<string, unknown>)
            .filter(([k, v]) => k in infoSchema.properties && typeof v === 'string')
            .map(([k, v]) => [k, (v as string).slice(0, 1000)]),
        ) as Info;
        await updateInfo(pool, conn.deviceId, info);
      }
    };

    // Browser: cookie lookup first. Messages that arrive meanwhile wait for it, in order.
    const cookie = req.cookies[SESSION_COOKIE];
    if (cookie && req.headers.origin !== cfg.origin) return socket.close(4403, 'origin');
    let busy: Promise<unknown> = cookie
      ? sessionUser(pool, cookie).then((user) => (user?.mfa_ok ? start(user.id, null) : socket.close(4401, 'auth')))
      : Promise.resolve();
    socket.on('message', (data: Buffer) => {
      const raw = data.toString();
      if (raw.length > 400_000) return socket.close(1009, 'too big');
      busy = busy.then(() => handle(raw)).catch(() => {});
    });
    socket.on('close', () => conn && hub.remove(conn));
    const timer = setTimeout(() => !conn && socket.close(4401, 'auth'), 10_000);
    socket.on('close', () => clearTimeout(timer));
  });
}
