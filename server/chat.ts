import { streamText } from 'ai';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { dataKey, unseal } from './crypto.ts';
import { withUser } from './db.ts';
import { getCatalog, languageModel, splitModel } from './models.ts';
import {
  DEFAULT_SETTINGS, SHORT_ANSWERS, cheapestModel, compactSaved, compactionPlan, estimateTokens, priceCall, reasoningLevel, summarize,
  type HistoryRow, type Settings, type Usage,
} from './saving.ts';

export type Block = { type: 'text'; text: string } | { type: 'thinking'; text: string } | { type: 'error'; text: string };

const MAX_ACTIVE_TURNS = 2; // per user, across tabs
const TURN_TIMEOUT_MS = 5 * 60_000;
const active = new Map<string, number>(); // ponytail: in-memory, one server process. Move to Postgres/Redis if this ever runs as several.

const systemPrompt = () =>
  `You are a helpful assistant inside Harbor, a self-hosted chat app. Today is ${new Date().toISOString().slice(0, 10)}. ` +
  'Answer in Markdown. Be direct and accurate, and say when you are unsure.';

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

// Stored messages -> plain text history. Thinking and error blocks are left out.
export function historyRows(rows: { role: 'user' | 'assistant'; content: Block[]; created_at: Date }[]): HistoryRow[] {
  return rows
    .map((r) => ({ role: r.role, text: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n'), created_at: r.created_at }))
    .filter((r) => r.text.trim() !== '');
}

export function chatStreamRoute(api: FastifyInstance, pool: pg.Pool, masterKey: Buffer) {
  api.post(
    '/chats/:id/messages',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'model'],
          properties: { text: { type: 'string', minLength: 1, maxLength: 100_000 }, model: { type: 'string', maxLength: 300 } },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { text, model } = req.body as { text: string; model: string };
      const ref = splitModel(model);
      if (!ref) return reply.code(400).send({ error: 'Unknown model.' });
      const [provider, modelId] = ref;
      const userId = req.user.id;
      if ((active.get(userId) ?? 0) >= MAX_ACTIVE_TURNS) {
        return reply.code(429).send({ error: 'You already have two replies in progress. Wait for one to finish.' });
      }

      const setup = await withUser(pool, userId, async (db) => {
        const chat = await db.query('SELECT title, summary, summary_until FROM chats WHERE id = $1', [id]);
        if (!chat.rows[0]) return { error: 404 as const };
        const keyRow = await db.query('SELECT key_enc FROM provider_keys WHERE provider = $1', [provider]);
        if (!keyRow.rows[0]) return { error: 'nokey' as const };
        const settings = await db.query('SELECT data FROM user_settings');
        const userMsg = await db.query(
          "INSERT INTO messages (chat_id, user_id, role, content) VALUES ($1, $2, 'user', $3) RETURNING id, role, content, created_at",
          [id, userId, JSON.stringify([{ type: 'text', text }])],
        );
        await db.query(
          "UPDATE chats SET model = $2, updated_at = now(), title = CASE WHEN title = '' THEN $3 ELSE title END WHERE id = $1",
          [id, model, text.replace(/\s+/g, ' ').trim().slice(0, 80)],
        );
        const history = await db.query('SELECT role, content, created_at FROM messages WHERE chat_id = $1 ORDER BY created_at', [id]);
        return {
          keyEnc: keyRow.rows[0].key_enc as Buffer,
          userMsg: userMsg.rows[0],
          history: history.rows as { role: 'user' | 'assistant'; content: Block[]; created_at: Date }[],
          summary: chat.rows[0].summary as string,
          summaryUntil: chat.rows[0].summary_until as Date | null,
          settings: { ...DEFAULT_SETTINGS, ...settings.rows[0]?.data } as Settings,
        };
      });
      if ('error' in setup) {
        return setup.error === 404
          ? reply.code(404).send({ error: 'Not found.' })
          : reply.code(400).send({ error: `Add your ${provider} API key in Settings first.` });
      }
      const apiKey = unseal(dataKey(masterKey, userId, req.user.wrapped), setup.keyEnc, `pk:${userId}:${provider}`).toString();
      const info = getCatalog().find((m) => m.id === model);

      // Server-sent events over a POST response. The client reads it with fetch().
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ t: 'user', message: setup.userMsg });

      // Closing the tab or pressing Stop aborts the model call; whatever arrived so far is kept.
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]);
      active.set(userId, (active.get(userId) ?? 0) + 1);

      // History as plain text; messages already folded into the summary aren't sent again.
      const rows = historyRows(setup.history);
      let summary = setup.summary;
      let recent = rows.filter((r) => !setup.summaryUntil || r.created_at > setup.summaryUntil);
      let compactCost = 0;
      let compacted = false;

      let answer = '', thinking = '', failure = '';
      let usage: Record<string, unknown> | null = null;
      try {
        // Auto-compact: fold older turns into the summary with the cheapest model on the same key.
        const plan = setup.settings.compact ? compactionPlan(summary, recent, info?.context ?? null) : null;
        if (plan) {
          send({ t: 'compacting' });
          const need = estimateTokens(summary) + plan.fold.reduce((n, r) => n + estimateTokens(r.text), 0);
          const cheap = cheapestModel(getCatalog(), provider, need) ?? info;
          try {
            const result = await summarize(languageModel(provider, cheap?.id.slice(provider.length + 1) ?? modelId, apiKey, id), summary, plan.fold, signal);
            if (result.text) {
              summary = result.text;
              recent = plan.keep;
              compacted = true;
              compactCost = priceCall(result.usage, cheap?.cost ?? null).cost;
              const until = plan.fold[plan.fold.length - 1].created_at;
              await withUser(pool, userId, (db) => db.query('UPDATE chats SET summary = $2, summary_until = $3 WHERE id = $1', [id, summary, until]));
            }
          } catch {
            // Compaction is an optimization: if it fails, send the full history as usual.
          }
        }

        const system =
          systemPrompt() + (setup.settings.short ? `\n\n${SHORT_ANSWERS}` : '') + (summary ? `\n\nSummary of the earlier conversation:\n${summary}` : '');
        const result = streamText({
          model: languageModel(provider, modelId, apiKey, id),
          system,
          messages: recent.map(({ role, text }) => ({ role, content: text })),
          abortSignal: signal,
          maxRetries: 1,
          reasoning: reasoningLevel(info, setup.settings.thinkHard),
          providerOptions: cacheOptions(provider, modelId),
          // The SDK's default logs the whole error, which can include the chat text it sent. Errors
          // already reach the user through the stream, so nothing is logged here.
          onError: () => {},
        });
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            answer += part.text;
            send({ t: 'text', d: part.text });
          } else if (part.type === 'reasoning-delta') {
            thinking += part.text;
            send({ t: 'thinking', d: part.text });
          } else if (part.type === 'error') {
            failure = errorText(part.error);
          } else if (part.type === 'finish') {
            const u: Usage = {
              input: part.totalUsage.inputTokens ?? null,
              output: part.totalUsage.outputTokens ?? null,
              cacheRead: part.totalUsage.inputTokenDetails?.cacheReadTokens ?? null,
              cacheWrite: part.totalUsage.inputTokenDetails?.cacheWriteTokens ?? null,
            };
            const priced = priceCall(u, info?.cost ?? null);
            // Savings meter: caching discount, plus history not resent because of the summary,
            // minus what the summary itself cost this turn.
            const full = rows.reduce((n, r) => n + estimateTokens(r.text), 0);
            const sent = estimateTokens(summary) + recent.reduce((n, r) => n + estimateTokens(r.text), 0);
            const saved = priced.cacheSaved + (summary ? compactSaved(full, sent, info?.cost ?? null) : 0) - compactCost;
            usage = { ...u, cost: round(priced.cost + compactCost), saved: round(saved), ...(compacted && { compacted: true }) };
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) failure = errorText(e);
      } finally {
        active.set(userId, (active.get(userId) ?? 1) - 1);
        if (!active.get(userId)) active.delete(userId);
      }

      const content: Block[] = [];
      if (thinking) content.push({ type: 'thinking', text: thinking });
      if (answer) content.push({ type: 'text', text: answer });
      if (failure) content.push({ type: 'error', text: failure });
      if (!content.length) content.push({ type: 'error', text: abort.signal.aborted ? 'Stopped.' : 'The model sent an empty reply.' });
      try {
        const saved = await withUser(pool, userId, async (db) => {
          const { rows } = await db.query(
            "INSERT INTO messages (chat_id, user_id, role, content, model, usage) VALUES ($1, $2, 'assistant', $3, $4, $5) RETURNING id, role, content, model, usage, created_at",
            [id, userId, JSON.stringify(content), model, usage && JSON.stringify(usage)],
          );
          await db.query('UPDATE chats SET updated_at = now() WHERE id = $1', [id]);
          return rows[0];
        });
        send({ t: 'done', message: saved });
      } catch (e) {
        // The chat may have been deleted mid-reply; nothing to save to.
        req.log.warn({ err: String(e) }, 'could not save assistant message');
      }
      res.end();
    },
  );
}

// Prompt caching: each turn resends the whole chat, so the provider can bill the part it saw last
// turn at roughly a tenth of the input price. Anthropic needs it switched on (automatic mode puts the
// cache point after the newest message); OpenAI, Google and DeepSeek-style APIs cache on their own.
export function cacheOptions(provider: string, modelId: string): Record<string, Record<string, { type: 'ephemeral' }>> | undefined {
  const ephemeral = { type: 'ephemeral' as const };
  if (provider === 'openrouter') return modelId.startsWith('anthropic/') ? { openrouter: { cache_control: ephemeral } } : undefined;
  // Covers Anthropic itself and OpenCode Go models served through the Anthropic API style.
  return { anthropic: { cacheControl: ephemeral } };
}

// Provider errors go to the user, but trimmed and never with a stack.
export function errorText(e: unknown): string {
  const status = (e as { statusCode?: number })?.statusCode;
  if (status === 401 || status === 403) return 'The provider rejected your API key. Check or replace it in Settings.';
  if (status === 429) return 'The provider is rate limiting your key, or your account is out of credit. Try again shortly.';
  const msg = e instanceof Error ? e.message : String(e);
  return (msg || 'The provider returned an error.').slice(0, 500);
}
