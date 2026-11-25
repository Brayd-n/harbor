// API tests against a real PostgreSQL (PG* env vars). They wipe the database's public schema.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../server/app.ts';
import { createSession, upsertGoogleUser } from '../server/auth.ts';
import { base32, hotp, seal, unseal, verifyTotp } from '../server/crypto.ts';
import { createPool, migrate, withUser } from '../server/db.ts';
import { parseCatalog, setCatalogForTests } from '../server/models.ts';

process.env.NODE_ENV = 'test';
const ORIGIN = 'https://harbor.test';
const masterKey = randomBytes(32);
const cfg = { origin: ORIGIN, googleClientId: 'id', googleClientSecret: 'secret', masterKey, ownerEmail: 'owner@example.com' };
const pool = createPool();
let app: ReturnType<typeof buildApp>;
const users: Record<string, { id: string; cookie: string }> = {};

async function makeUser(name: string, mfaOk = true) {
  const id = (await upsertGoogleUser(pool, cfg, name, `${name}@example.com`, name))!;
  users[name] = { id, cookie: `__Host-session=${await createSession(pool, id, mfaOk)}` };
}

const as = (user: string | null, method: string, url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload, headers: { origin: ORIGIN, ...(user ? { cookie: users[user].cookie } : {}), ...headers } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(pool);
  app = buildApp(pool, cfg);
  setCatalogForTests(parseCatalog({ anthropic: { models: { 'claude-test': { id: 'claude-test', name: 'Claude Test', tool_call: true } } } }));
  await makeUser('alice');
  await makeUser('bob');
  await makeUser('owner');
});
after(async () => {
  await app.close();
  await pool.end();
});

test('TOTP matches the RFC 6238 test vector and rejects replays', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.equal(hotp(secret, 1, 8), '94287082'); // T = 59 s
  assert.equal(base32(Buffer.from('foobar')), 'MZXW6YTBOI');
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30_000);
  const code = hotp(secret, step);
  assert.equal(verifyTotp(secret, code, 0, now), step);
  assert.equal(verifyTotp(secret, code, step, now), null, 'same step twice');
  assert.equal(verifyTotp(secret, hotp(secret, step - 5), 0, now), null, 'too old');
});

test('sealed values only open with the same key and the same AAD', () => {
  const key = randomBytes(32);
  const box = seal(key, Buffer.from('sk-secret'), 'pk:a:anthropic');
  assert.equal(unseal(key, box, 'pk:a:anthropic').toString(), 'sk-secret');
  assert.throws(() => unseal(key, box, 'pk:b:anthropic'));
  assert.throws(() => unseal(randomBytes(32), box, 'pk:a:anthropic'));
});

test("users can never see or change each other's chats or keys", async () => {
  assert.equal((await as('alice', 'PUT', '/api/providers/anthropic', { key: 'sk-ant-alice-1234' })).statusCode, 200);
  const created = await as('alice', 'POST', '/api/chats', { model: 'anthropic:claude-test' });
  assert.equal(created.statusCode, 201);
  const chatId = created.json().id;
  await withUser(pool, users.alice.id, (db) =>
    db.query("INSERT INTO messages (chat_id, user_id, role, content) VALUES ($1, $2, 'user', '[{\"type\":\"text\",\"text\":\"hi\"}]')", [chatId, users.alice.id]),
  );

  assert.equal((await as('alice', 'GET', `/api/chats/${chatId}`)).json().messages.length, 1);
  assert.deepEqual((await as('bob', 'GET', '/api/chats')).json(), []);
  assert.deepEqual((await as('bob', 'GET', '/api/models')).json(), [], 'bob has no keys, so no models');
  for (const r of [
    await as('bob', 'GET', `/api/chats/${chatId}`),
    await as('bob', 'PATCH', `/api/chats/${chatId}`, { title: 'x' }),
    await as('bob', 'DELETE', `/api/chats/${chatId}`),
  ]) assert.equal(r.statusCode, 404);
  const send = await as('bob', 'POST', `/api/chats/${chatId}/messages`, { text: 'hi', model: 'anthropic:claude-test' });
  assert.equal(send.statusCode, 404);

  // Row-level security on its own: no WHERE clause, still only your rows; writes into someone else's chat fail.
  const seen = await withUser(pool, users.bob.id, async (db) => (await db.query('SELECT * FROM chats')).rows);
  assert.deepEqual(seen, []);
  await assert.rejects(
    withUser(pool, users.bob.id, (db) =>
      db.query("INSERT INTO messages (chat_id, user_id, role, content) VALUES ($1, $2, 'user', '[]')", [chatId, users.alice.id]),
    ),
  );
  const keysSeenByBob = await withUser(pool, users.bob.id, async (db) => (await db.query('SELECT * FROM provider_keys')).rows);
  assert.deepEqual(keysSeenByBob, []);
});

test('provider keys are encrypted at rest and never returned', async () => {
  const list = await as('alice', 'GET', '/api/providers');
  assert.ok(!list.body.includes('sk-ant-alice'), 'only last4 is returned');
  assert.equal(list.json().find((p: { id: string }) => p.id === 'anthropic').key.last4, '1234');
  const { rows } = await pool.query('SELECT key_enc FROM provider_keys WHERE user_id = $1', [users.alice.id]);
  assert.ok(!rows[0].key_enc.toString('latin1').includes('sk-ant-alice'));

  // Alice's ciphertext copied into Bob's row doesn't decrypt as Bob's key.
  await pool.query("INSERT INTO provider_keys (user_id, provider, key_enc, last4) VALUES ($1, 'anthropic', $2, '1234')", [users.bob.id, rows[0].key_enc]);
  const chat = (await as('bob', 'POST', '/api/chats', { model: 'anthropic:claude-test' })).json();
  const r = await as('bob', 'POST', `/api/chats/${chat.id}/messages`, { text: 'hi', model: 'anthropic:claude-test' });
  assert.equal(r.statusCode, 500);
  await pool.query('DELETE FROM provider_keys WHERE user_id = $1', [users.bob.id]);
});

test('a chat turn streams the reply with the user’s own key and saves it', async () => {
  const realFetch = globalThis.fetch;
  let sentKey = '';
  let sentBody: Record<string, unknown> = {};
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes('api.anthropic.com')) return realFetch(url, init);
    sentKey = new Headers(init?.headers).get('x-api-key') ?? '';
    sentBody = JSON.parse(String(init?.body));
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const chat = (await as('alice', 'POST', '/api/chats', { model: 'anthropic:claude-test' })).json();
    const r = await as('alice', 'POST', `/api/chats/${chat.id}/messages`, { text: 'Say hello', model: 'anthropic:claude-test' });
    assert.equal(r.statusCode, 200);
    assert.equal(sentKey, 'sk-ant-alice-1234');
    assert.deepEqual(sentBody.cache_control, { type: 'ephemeral' }, 'prompt caching is on');
    const events = r.body.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.slice(6)));
    assert.equal(events.filter((e) => e.t === 'text').map((e) => e.d).join(''), 'Hello there.');
    assert.deepEqual(events.at(-1).message.content, [{ type: 'text', text: 'Hello there.' }]);
    const saved = (await as('alice', 'GET', `/api/chats/${chat.id}`)).json();
    assert.equal(saved.title, 'Say hello');
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[1].usage.cacheRead, 1200);
    assert.equal(saved.messages[1].usage.output, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenCode Go models go to the endpoint the catalog names, and only ever to opencode.ai', async () => {
  setCatalogForTests(
    parseCatalog({
      anthropic: { models: { 'claude-test': { id: 'claude-test', name: 'Claude Test' } } },
      'opencode-go': {
        models: {
          'glm-5.3': { id: 'glm-5.3', name: 'GLM' },
          'minimax-m3': { id: 'minimax-m3', name: 'MiniMax', provider: { npm: '@ai-sdk/anthropic', api: 'https://opencode.ai/inference/go/anthropic/v1' } },
          'evil-model': { id: 'evil-model', name: 'Evil', provider: { npm: '@ai-sdk/anthropic', api: 'https://evil.test/v1' } },
          'cat-jam-free': { id: 'cat-jam-free', name: 'Free (OpenCode only)' },
        },
      },
    }),
  );
  assert.equal((await as('alice', 'PUT', '/api/providers/opencode-go', { key: 'oc-go-key-5678' })).statusCode, 200);
  const realFetch = globalThis.fetch;
  const calls: { url: string; auth: string; session: string; ua: string }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url: String(url), auth: h.get('authorization') ?? h.get('x-api-key') ?? '', session: h.get('x-opencode-session') ?? '', ua: h.get('user-agent') ?? '' });
    return new Response('{"error":{"message":"test"}}', { status: 400, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const chatIds: string[] = [];
  try {
    for (const model of ['glm-5.3', 'minimax-m3', 'evil-model']) {
      const chat = (await as('alice', 'POST', '/api/chats', { model: `opencode-go:${model}` })).json();
      chatIds.push(chat.id);
      await as('alice', 'POST', `/api/chats/${chat.id}/messages`, { text: 'hi', model: `opencode-go:${model}` });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      'https://opencode.ai/inference/go/openai/v1/chat/completions',
      'https://opencode.ai/inference/go/anthropic/v1/messages',
      'https://opencode.ai/inference/go/openai/v1/chat/completions', // catalog pointed elsewhere; ignored
    ],
  );
  assert.ok(calls.every((c) => c.auth.includes('oc-go-key-5678')));
  // One stable session id per chat, and Harbor's own user agent, as Go asks of every client.
  assert.deepEqual(calls.map((c) => c.session), chatIds.map((id) => `ses_${id.replace(/-/g, '')}`));
  assert.ok(calls.every((c) => c.ua.startsWith('harbor/')));
  assert.equal((await as('alice', 'GET', '/api/models')).json().length, 4, 'free Go models are hidden');
});

test('a session that has not passed 2FA cannot use the API, and 2FA codes work once', async () => {
  await makeUser('carol', false);
  assert.equal((await as('carol', 'GET', '/api/chats')).statusCode, 401);
  assert.equal((await as('carol', 'GET', '/auth/state')).json().step, 'enroll');

  const setup = await as('carol', 'POST', '/auth/2fa/setup');
  const secret = Buffer.from(
    setup.json().secret.replace(/ /g, '').match(/.{1,8}/g)!.map((chunk: string) => {
      // decode base32 chunk by chunk (8 chars = 5 bytes)
      let bits = '';
      for (const c of chunk) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
      return bits.match(/.{8}/g)!.map((b) => parseInt(b, 2));
    }).flat(),
  );
  const step = Math.floor(Date.now() / 30_000);
  assert.equal((await as('carol', 'POST', '/auth/2fa/enroll', { code: '000000' === hotp(secret, step) ? '111111' : '000000' })).statusCode, 400);
  const enroll = await as('carol', 'POST', '/auth/2fa/enroll', { code: hotp(secret, step) });
  assert.equal(enroll.statusCode, 200, enroll.body);
  const recovery: string[] = enroll.json().recoveryCodes;
  assert.equal(recovery.length, 10);
  const upgraded = enroll.cookies.find((c) => c.name === '__Host-session')!.value;
  assert.equal((await app.inject({ method: 'GET', url: '/api/chats', headers: { cookie: `__Host-session=${upgraded}` } })).statusCode, 200);
  assert.equal((await as('carol', 'GET', '/api/chats')).statusCode, 401, 'the pre-2FA token is gone');

  // New sign-in: the enrollment code can't be replayed, a recovery code works exactly once.
  users.carol.cookie = `__Host-session=${await createSession(pool, users.carol.id, false)}`;
  assert.equal((await as('carol', 'POST', '/auth/2fa/verify', { code: hotp(secret, step) })).statusCode, 400);
  assert.equal((await as('carol', 'POST', '/auth/2fa/verify', { code: recovery[0] })).statusCode, 200);
  users.carol.cookie = `__Host-session=${await createSession(pool, users.carol.id, false)}`;
  assert.equal((await as('carol', 'POST', '/auth/2fa/verify', { code: recovery[0] })).statusCode, 400);
  assert.equal((await as('carol', 'POST', '/auth/2fa/setup')).statusCode, 409, "can't re-enroll over an existing secret");
});

test('cross-site writes, admin access and disabled accounts are blocked', async () => {
  const csrf = await app.inject({ method: 'POST', url: '/api/chats', payload: { model: 'anthropic:claude-test' }, headers: { cookie: users.alice.cookie, origin: 'https://evil.test' } });
  assert.equal(csrf.statusCode, 403);
  assert.equal((await as('alice', 'GET', '/api/admin/users')).statusCode, 404);
  const list = await as('owner', 'GET', '/api/admin/users');
  assert.equal(list.statusCode, 200);
  assert.ok(!list.body.includes('data_key') && !list.body.includes('totp_secret'));
  assert.equal((await as('owner', 'POST', `/api/admin/users/${users.bob.id}/disabled`, { disabled: true })).statusCode, 200);
  assert.equal((await as('bob', 'GET', '/api/chats')).statusCode, 401);
  assert.equal(await upsertGoogleUser(pool, cfg, 'bob', 'bob@example.com', 'bob'), null, 'disabled users cannot sign in again');
});

test('export has the chats, and deleting the account removes everything', async () => {
  const exp = await as('alice', 'GET', '/api/account/export');
  assert.ok(exp.json().chats.length >= 2);
  assert.ok(!exp.body.includes('sk-ant'));
  assert.equal((await as('alice', 'DELETE', '/api/account')).statusCode, 200);
  for (const t of ['users', 'chats', 'messages', 'provider_keys', 'sessions']) {
    const col = t === 'users' ? 'id' : 'user_id';
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${col} = $1`, [users.alice.id])).rows[0].n, 0, t);
  }
});
