// Devices, the WebSocket hub and Code mode tool routing, against a real PostgreSQL (PG* env vars).
// Wipes the database's public schema, like api.test.ts (npm test runs files one at a time).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../server/app.ts';
import { createSession, signAccess, upsertGoogleUser, verifyAccess } from '../server/auth.ts';
import { createPool, migrate, withUser } from '../server/db.ts';
import { parseCatalog, setCatalogForTests } from '../server/models.ts';
import { headTail, environmentBlock } from '../server/tools.ts';

process.env.NODE_ENV = 'test';
const ORIGIN = 'https://harbor.test';
const masterKey = randomBytes(32);
const cfg = { origin: ORIGIN, googleClientId: 'id', googleClientSecret: 'secret', masterKey };
const pool = createPool();
let app: ReturnType<typeof buildApp>;
const cookies: Record<string, string> = {};
type Dev = { id: string; access: string; refresh: string };
const devices: Record<string, Dev> = {};

const req = (auth: { cookie?: string; bearer?: string }, method: string, url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({
    method: method as 'GET',
    url,
    payload,
    headers: {
      ...(auth.cookie ? { cookie: auth.cookie, origin: ORIGIN } : { origin: 'tauri://localhost' }),
      ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
      ...headers,
    },
  });
const web = (user: string) => ({ cookie: cookies[user] });
const dev = (name: string) => ({ bearer: devices[name].access });

async function link(user: string, name: string, info: object): Promise<Dev> {
  const start = (await req({}, 'POST', '/auth/device/start', { name, info })).json();
  assert.equal((await req({}, 'POST', '/auth/device/token', { device_code: start.device_code })).statusCode, 428, 'pending until approved');
  assert.equal((await req(web(user), 'GET', `/api/device-codes/${start.user_code.toLowerCase()}`)).json().name, name);
  const linked = await req(web(user), 'POST', '/api/devices/link', { code: start.user_code });
  assert.equal(linked.statusCode, 200, linked.body);
  const tokens = (await req({}, 'POST', '/auth/device/token', { device_code: start.device_code })).json();
  assert.equal((await req({}, 'POST', '/auth/device/token', { device_code: start.device_code })).statusCode, 400, 'a code gives out tokens once');
  return { id: linked.json().id, access: tokens.access_token, refresh: tokens.refresh_token };
}

// A WebSocket client that records what it receives.
async function socket(auth: { cookie?: string; bearer?: string }) {
  const ws = await app.injectWS('/ws', { headers: auth.cookie ? { cookie: auth.cookie, origin: ORIGIN } : {} });
  const got: Record<string, any>[] = [];
  const listeners: ((m: Record<string, any>) => void)[] = [];
  ws.on('message', (d: Buffer) => {
    const m = JSON.parse(d.toString());
    got.push(m);
    for (const l of listeners) l(m);
  });
  const next = (t: string) => new Promise<Record<string, any>>((resolve) => {
    const seen = got.find((m) => m.t === t);
    if (seen) return resolve(seen);
    listeners.push((m) => m.t === t && resolve(m));
  });
  if (auth.bearer) ws.send(JSON.stringify({ t: 'auth', token: auth.bearer }));
  const hello = await next('hello');
  return { ws, got, next, connId: hello.connId as string, on: (l: (m: Record<string, any>) => void) => listeners.push(l) };
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(pool);
  app = buildApp(pool, cfg);
  await app.ready();
  setCatalogForTests(parseCatalog({ anthropic: { models: { 'claude-test': { id: 'claude-test', name: 'Claude Test', tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] } } } } }));
  for (const u of ['alice', 'bob']) {
    const id = (await upsertGoogleUser(pool, cfg, u, `${u}@example.com`, u))!;
    cookies[u] = `__Host-session=${await createSession(pool, id, true)}`;
    await req(web(u), 'PUT', '/api/providers/anthropic', { key: `sk-ant-${u}-key-1234` });
  }
  const linux = { os: 'linux', os_version: '24.04', arch: 'x86_64', hostname: 'box', home_dir: '/home/a', shell: 'GNU bash 5.2' };
  devices.a1 = await link('alice', 'Linux desktop', linux);
  devices.a2 = await link('alice', 'Windows desktop', { ...linux, os: 'windows', os_version: '10.0.26100', home_dir: 'C:\\Users\\a', shell: 'PowerShell 7.5 (pwsh)' });
  devices.b1 = await link('bob', 'Bob laptop', linux);
});
after(async () => {
  await app.close();
  await pool.end();
});

test('access tokens are signed, expire, and name their device', () => {
  const id = '6f1c1a8e-2a4e-4d4b-9a59-0d0f1c2b3a4d';
  const t = signAccess(masterKey, id, 1_000);
  assert.equal(verifyAccess(masterKey, t, 2_000), id);
  assert.equal(verifyAccess(masterKey, t, 1_000 + 16 * 60_000), null, 'expired');
  assert.equal(verifyAccess(randomBytes(32), t, 2_000), null, 'other key');
  assert.equal(verifyAccess(masterKey, t.replace(id, id.replace('6f', '7f')), 2_000), null, 'other device');
});

test('a linked device uses the API with its token, and only the web app can link more', async () => {
  const me = (await req(dev('a1'), 'GET', '/api/me')).json();
  assert.equal(me.email, 'alice@example.com');
  assert.equal(me.device.name, 'Linux desktop');
  const start = (await req({}, 'POST', '/auth/device/start', { name: 'sneaky' })).json();
  assert.equal((await req(dev('a1'), 'POST', '/api/devices/link', { code: start.user_code })).statusCode, 403);
  assert.equal((await req({}, 'POST', '/api/chats', { model: 'anthropic:claude-test' })).statusCode, 403, 'no token, no cookie: CSRF rule still applies');
  const cors = await app.inject({ method: 'OPTIONS', url: '/api/chats', headers: { origin: 'tauri://localhost', 'access-control-request-method': 'POST' } });
  assert.equal(cors.headers['access-control-allow-origin'], 'tauri://localhost');
  assert.equal(cors.headers['access-control-allow-credentials'], undefined);
  const evil = await app.inject({ method: 'OPTIONS', url: '/api/chats', headers: { origin: 'https://evil.test' } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
});

test('refresh tokens rotate, and replaying an old one revokes the device', async () => {
  const extra = await link('alice', 'Spare', {});
  const r1 = await req({}, 'POST', '/auth/device/refresh', { refresh_token: extra.refresh });
  assert.equal(r1.statusCode, 200);
  const fresh = r1.json();
  assert.equal((await req({ bearer: fresh.access_token }, 'GET', '/api/me')).statusCode, 200);
  assert.equal((await req({}, 'POST', '/auth/device/refresh', { refresh_token: extra.refresh })).statusCode, 401, 'old token replayed');
  assert.equal((await req({ bearer: fresh.access_token }, 'GET', '/api/me')).statusCode, 401, 'device revoked, access token dead at once');
  assert.equal((await req({}, 'POST', '/auth/device/refresh', { refresh_token: fresh.refresh_token })).statusCode, 401);
  const events = await pool.query("SELECT 1 FROM auth_events WHERE kind = 'refresh_token_reused' AND device_id = $1", [extra.id]);
  assert.equal(events.rowCount, 1);
});

test("users can't see, revoke or use each other's devices, projects, images or audit logs", async () => {
  const project = await req(dev('a1'), 'POST', '/api/projects', { name: 'site', path: '/home/a/site' });
  assert.equal(project.statusCode, 201);
  const pid = project.json().id;
  assert.equal((await req(web('alice'), 'POST', '/api/projects', { name: 'x', path: '/x' })).statusCode, 403, 'folders come from a device');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
  const blob = await app.inject({ method: 'POST', url: '/api/blobs', payload: png, headers: { cookie: cookies.alice, origin: ORIGIN, 'content-type': 'image/png' } });
  assert.equal(blob.statusCode, 201);
  const fake = await app.inject({ method: 'POST', url: '/api/blobs', payload: Buffer.from('<svg onload=alert(1)>'), headers: { cookie: cookies.alice, origin: ORIGIN, 'content-type': 'image/png' } });
  assert.equal(fake.statusCode, 400, 'type comes from magic bytes');

  assert.ok((await req(dev('b1'), 'GET', '/api/devices')).json().every((d: { name: string }) => d.name === 'Bob laptop'));
  assert.equal((await req(dev('b1'), 'DELETE', `/api/devices/${devices.a1.id}`)).statusCode, 404);
  assert.equal((await req(web('bob'), 'DELETE', `/api/devices/${devices.a1.id}`)).statusCode, 404);
  assert.deepEqual((await req(dev('b1'), 'GET', '/api/projects')).json(), []);
  assert.equal((await req(dev('b1'), 'PUT', `/api/projects/${pid}/path`, { path: '/tmp' })).statusCode, 404);
  assert.equal((await req(dev('b1'), 'POST', '/api/chats', { model: 'anthropic:claude-test', project_id: pid })).statusCode, 404);
  assert.equal((await req(dev('b1'), 'GET', `/api/blobs/${blob.json().id}`)).statusCode, 404);
  // Row-level security underneath: no WHERE clause, still nothing of Alice's; can't attach Alice's device to Bob's rows.
  const bobId = (await pool.query("SELECT id FROM users WHERE email = 'bob@example.com'")).rows[0].id;
  for (const t of ['devices', 'projects', 'project_paths', 'blobs', 'tool_runs']) {
    const rows = await withUser(pool, bobId, async (db) => (await db.query(`SELECT user_id FROM ${t}`)).rows);
    assert.ok(rows.every((r) => r.user_id === bobId), t);
  }
  await assert.rejects(
    withUser(pool, bobId, async (db) => {
      const p = await db.query("INSERT INTO projects (user_id, name) VALUES ($1, 'p') RETURNING id", [bobId]);
      await db.query('INSERT INTO project_paths (project_id, device_id, user_id, path) VALUES ($1, $2, $3, $4)', [p.rows[0].id, devices.a1.id, bobId, '/']);
    }),
    'a project path must point at your own device',
  );
});

test('websockets: a bad token or a cross-site browser socket is refused', async () => {
  const ws = await app.injectWS('/ws', {});
  const closed = new Promise<number>((r) => ws.on('close', (code: number) => r(code)));
  ws.send(JSON.stringify({ t: 'auth', token: 'hat_nope' }));
  assert.equal(await closed, 4401);
  const cross = await app.injectWS('/ws', { headers: { cookie: cookies.alice, origin: 'https://evil.test' } });
  assert.equal(await new Promise<number>((r) => cross.on('close', (code: number) => r(code))), 4403);
  ws.terminate();
  cross.terminate();
});

// Anthropic API stand-in: first call asks for read_file, second call answers in text.
function fakeAnthropic(bodies: Record<string, any>[]) {
  const sse = (events: [string, object][]) => new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const start = (model: string): [string, object] => ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 80 } } }];
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (bodies.length % 2 === 1) {
      return sse([
        start(body.model),
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${bodies.length}`, name: 'read_file', input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
    }
    return sse([
      start(body.model),
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It says hello.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
  }) as typeof fetch;
}

test('Code mode: tool requests go only to the window that sent the message, on its own device', async () => {
  const project = (await req(dev('a1'), 'GET', '/api/projects')).json()[0];
  const chat = (await req(dev('a1'), 'POST', '/api/chats', { model: 'anthropic:claude-test', project_id: project.id })).json();
  assert.equal(chat.mode, 'code');

  const a1 = await socket(dev('a1'));
  const a1other = await socket(dev('a1')); // a second window on the same device
  const a2 = await socket(dev('a2'));
  const browser = await socket(web('alice'));
  const bob = await socket(dev('b1'));
  // Alice's other device tries to answer every request it can guess; Alice's chosen window answers for real.
  a1.on((m) => {
    if (m.t !== 'tool_request') return;
    a2.ws.send(JSON.stringify({ t: 'tool_result', id: m.id, output: 'FORGED', decision: 'auto' }));
    bob.ws.send(JSON.stringify({ t: 'tool_result', id: m.id, output: 'FORGED', decision: 'auto' }));
    setTimeout(() => a1.ws.send(JSON.stringify({ t: 'tool_result', id: m.id, output: '# hello', decision: 'approved', exitCode: null, durationMs: 3 })), 20);
  });

  const bodies: Record<string, any>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeAnthropic(bodies);
  try {
    assert.equal((await req(web('alice'), 'POST', `/api/chats/${chat.id}/messages`, { text: 'hi', model: 'anthropic:claude-test' })).statusCode, 409, 'not from a browser');
    assert.equal(
      (await req(dev('a2'), 'POST', `/api/chats/${chat.id}/messages`, { text: 'hi', model: 'anthropic:claude-test' }, { 'x-harbor-conn': a2.connId })).statusCode,
      409,
      'no folder on this device yet',
    );
    assert.equal(
      (await req(dev('a1'), 'POST', `/api/chats/${chat.id}/messages`, { text: 'hi', model: 'anthropic:claude-test' }, { 'x-harbor-conn': a2.connId })).statusCode,
      409,
      "another device's window can't be named as the target",
    );
    const r = await req(dev('a1'), 'POST', `/api/chats/${chat.id}/messages`, { text: 'What does the README say?', model: 'anthropic:claude-test' }, { 'x-harbor-conn': a1.connId });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers['access-control-allow-origin'], 'tauri://localhost', 'the stream carries CORS for the desktop app');
    const events = r.body.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.slice(6)));
    assert.equal(events.find((e) => e.t === 'tool_result').output, '# hello', 'the forged answers were ignored');
    assert.equal(events.at(-1).t, 'done');
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(a1.got.filter((m) => m.t === 'tool_request').length, 1);
  const tr = a1.got.find((m) => m.t === 'tool_request')!;
  assert.deepEqual([tr.tool, tr.input, tr.root, tr.chatId], ['read_file', { path: 'README.md' }, '/home/a/site', chat.id]);
  for (const other of [a1other, a2, browser, bob]) assert.ok(!other.got.some((m) => m.t === 'tool_request'));
  // Live sync: Alice's other windows see the reply stream; Bob sees nothing; the sender gets it over HTTP only.
  for (const w of [a1other, a2, browser]) assert.ok(w.got.some((m) => m.t === 'chat' && m.chatId === chat.id && m.e.t === 'done'));
  assert.ok(!bob.got.some((m) => m.t === 'chat'));
  assert.ok(!a1.got.some((m) => m.t === 'chat'));

  // The environment block of the driving device is in the system prompt, and the tool result went back to the model.
  const system = JSON.stringify(bodies[0].system);
  assert.ok(system.includes('working directory: /home/a/site') && system.includes('shell: GNU bash 5.2'));
  assert.ok(JSON.stringify(bodies[1].messages).includes('# hello'));
  assert.ok(bodies[0].tools.some((t: { name: string }) => t.name === 'shell'));

  const runs = (await req(dev('a1'), 'GET', `/api/chats/${chat.id}/tool-runs`)).json();
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].tool, runs[0].decision, runs[0].device], ['read_file', 'approved', 'Linux desktop']);
  assert.deepEqual((await req(dev('b1'), 'GET', `/api/chats/${chat.id}/tool-runs`)).json(), []);
  const saved = (await req(dev('a1'), 'GET', `/api/chats/${chat.id}`)).json();
  assert.equal(saved.messages.length, 2, 'refused sends store nothing');
  const reply = saved.messages[1];
  assert.deepEqual(reply.content.map((b: { type: string }) => b.type), ['tool_call', 'tool_result', 'text']);
  assert.equal(reply.usage.input, 360, 'both model calls are counted (AI SDK input includes cache reads)');
  assert.ok(reply.usage.cacheRead === 160);

  // Continuing on the Windows machine: it gets its own folder, its own environment, and a note about the switch.
  assert.equal((await req(dev('a2'), 'PUT', `/api/projects/${project.id}/path`, { path: 'C:\\code\\site' })).statusCode, 200);
  a2.on((m) => m.t === 'tool_request' && a2.ws.send(JSON.stringify({ t: 'tool_result', id: m.id, output: 'denied by user', isError: true, decision: 'denied' })));
  globalThis.fetch = fakeAnthropic(bodies);
  try {
    const r = await req(dev('a2'), 'POST', `/api/chats/${chat.id}/messages`, { text: 'Now on Windows', model: 'anthropic:claude-test' }, { 'x-harbor-conn': a2.connId });
    assert.equal(r.statusCode, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(a1.got.filter((m) => m.t === 'tool_request').length, 1, 'Linux ran nothing for the Windows turn');
  assert.equal(a2.got.find((m) => m.t === 'tool_request')!.root, 'C:\\code\\site');
  const sys2 = JSON.stringify(bodies[2].system);
  assert.ok(sys2.includes('shell: PowerShell 7.5 (pwsh)') && sys2.includes('path separator: \\\\'));
  assert.ok(JSON.stringify(bodies[2].messages).includes('Now on Windows desktop'), 'switch note');
  // Earlier tool use is replayed as a one-line digest, not the full output.
  assert.ok(JSON.stringify(bodies[2].messages).includes('[read_file \\"README.md\\"'));
  assert.equal((await req(dev('a2'), 'GET', `/api/chats/${chat.id}/tool-runs`)).json()[0].decision, 'denied');

  // Revoking a device closes its sockets.
  const closed = new Promise((r) => a2.ws.on('close', r));
  assert.equal((await req(web('alice'), 'DELETE', `/api/devices/${devices.a2.id}`)).statusCode, 200);
  await closed;
  assert.equal((await req(dev('a2'), 'GET', '/api/chats')).statusCode, 401);
  for (const w of [a1, a1other, a2, browser, bob]) w.ws.terminate();
});

test('long tool output keeps its head and tail; the environment block says where commands run', () => {
  const s = 'a'.repeat(50) + 'b'.repeat(50);
  const cut = headTail(s, 20);
  assert.ok(cut.startsWith('a'.repeat(10)) && cut.endsWith('b'.repeat(10)) && cut.includes('80 characters cut'));
  const block = environmentBlock({ id: 'x', name: 'PC', os: 'windows', os_version: '11', arch: 'x86_64', hostname: 'h', home_dir: 'C:\\Users\\b', shell: '' }, 'C:\\p', new Date('2026-11-25'));
  assert.ok(block.includes('shell: pwsh') && block.includes('date: 2026-11-25'));
});
