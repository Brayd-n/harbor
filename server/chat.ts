import { isStepCount, streamText, type ModelMessage } from 'ai';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { dataKey, unseal } from './crypto.ts';
import { withUser } from './db.ts';
import type { Hub } from './hub.ts';
import { getCatalog, languageModel, splitModel } from './models.ts';
import { CODE_PROMPT, MAX_STEPS, TOOL_TIMEOUT_MS, codeTools, environmentBlock, headTail, switchNote, toolDigest } from './tools.ts';
import {
  DEFAULT_SETTINGS, SHORT_ANSWERS, cheapestModel, compactSaved, compactionPlan, estimateTokens, priceCall, reasoningLevel, summarize,
  type HistoryRow, type Settings, type Usage,
} from './saving.ts';

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'error'; text: string }
  | { type: 'note'; text: string } // e.g. "now on another device"
  | { type: 'image'; blobId: string; mime: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; output: string; isError: boolean; decision: string; deviceId: string };

const MAX_ACTIVE_TURNS = 2; // per user, across tabs
const TURN_TIMEOUT_MS = 5 * 60_000;
const CODE_TURN_TIMEOUT_MS = 60 * 60_000; // agent turns wait on approvals
const IMAGES_KEPT = 6; // images ride along only with the newest messages
const active = new Map<string, number>(); // ponytail: in-memory, one server process. Move to Postgres/Redis if this ever runs as several.

const systemPrompt = () =>
  `You are a helpful assistant inside Harbor, a self-hosted chat app. Today is ${new Date().toISOString().slice(0, 10)}. ` +
  'Answer in Markdown. Be direct and accurate, and say when you are unsure.';

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

// Stored messages -> history. Thinking and error blocks are left out; tool use becomes one line per call.
export function historyRows(rows: { role: 'user' | 'assistant'; content: Block[]; created_at: Date }[]): HistoryRow[] {
  return rows
    .map((r) => {
      const calls = new Map(r.content.flatMap((b) => (b.type === 'tool_call' ? [[b.id, b] as const] : [])));
      const parts = r.content.flatMap((b) => {
        if (b.type === 'text') return [b.text];
        if (b.type === 'note') return [`(${b.text})`];
        if (b.type === 'tool_result') {
          const call = calls.get(b.callId);
          return [toolDigest(call?.name ?? 'tool', call?.input, b.output, b.isError)];
        }
        return [];
      });
      const images = r.content.flatMap((b) => (b.type === 'image' ? [{ id: b.blobId, mime: b.mime }] : []));
      return { role: r.role, text: parts.join('\n\n'), created_at: r.created_at, ...(images.length && { images }) };
    })
    .filter((r) => r.text.trim() !== '' || r.images);
}

export function chatStreamRoute(api: FastifyInstance, pool: pg.Pool, masterKey: Buffer, hub: Hub) {
  api.post(
    '/chats/:id/messages',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'model'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 100_000 },
            model: { type: 'string', maxLength: 300 },
            images: { type: 'array', maxItems: 4, items: { type: 'string', format: 'uuid' } },
          },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { text, model, images = [] } = req.body as { text: string; model: string; images?: string[] };
      const ref = splitModel(model);
      if (!ref) return reply.code(400).send({ error: 'Unknown model.' });
      const [provider, modelId] = ref;
      const userId = req.user.id;
      const device = req.device;
      // The window that sent this message; in Code mode its tools run there and nowhere else.
      const connId = String(req.headers['x-harbor-conn'] ?? '') || undefined;
      if ((active.get(userId) ?? 0) >= MAX_ACTIVE_TURNS) {
        return reply.code(429).send({ error: 'You already have two replies in progress. Wait for one to finish.' });
      }

      const setup = await withUser(pool, userId, async (db) => {
        const chat = await db.query(
          `SELECT c.title, c.summary, c.summary_until, c.mode, c.last_device_id, pp.path
           FROM chats c LEFT JOIN project_paths pp ON pp.project_id = c.project_id AND pp.device_id = $2 WHERE c.id = $1`,
          [id, device?.id ?? null],
        );
        const c = chat.rows[0];
        if (!c) return { error: 404 as const };
        if (c.mode === 'code' && !device) return { error: 'device' as const };
        if (c.mode === 'code' && !c.path) return { error: 'folder' as const };
        if (c.mode === 'code' && !hub.find(connId, userId, device!.id)) return { error: 'conn' as const };
        const keyRow = await db.query('SELECT key_enc FROM provider_keys WHERE provider = $1', [provider]);
        if (!keyRow.rows[0]) return { error: 'nokey' as const };
        const blobs = images.length ? (await db.query('SELECT id, mime FROM blobs WHERE id = ANY($1)', [images])).rows : [];
        if (blobs.length !== new Set(images).size) return { error: 404 as const };
        const settings = await db.query('SELECT data FROM user_settings');
        const content: Block[] = [{ type: 'text', text }, ...blobs.map((b) => ({ type: 'image' as const, blobId: b.id, mime: b.mime }))];
        // Continuing a Code chat on another machine: say so, so the model stops using the old shell and paths.
        if (c.mode === 'code' && c.last_device_id && c.last_device_id !== device!.id) content.unshift({ type: 'note', text: switchNote(device!, c.path) });
        const userMsg = await db.query(
          "INSERT INTO messages (chat_id, user_id, role, content, device_id) VALUES ($1, $2, 'user', $3, $4) RETURNING id, role, content, created_at",
          [id, userId, JSON.stringify(content), device?.id ?? null],
        );
        await db.query(
          "UPDATE chats SET model = $2, updated_at = now(), last_device_id = coalesce($4, last_device_id), title = CASE WHEN title = '' THEN $3 ELSE title END WHERE id = $1",
          [id, model, text.replace(/\s+/g, ' ').trim().slice(0, 80), device?.id ?? null],
        );
        const history = await db.query('SELECT role, content, created_at FROM messages WHERE chat_id = $1 ORDER BY created_at', [id]);
        return {
          keyEnc: keyRow.rows[0].key_enc as Buffer,
          userMsg: userMsg.rows[0],
          history: history.rows as { role: 'user' | 'assistant'; content: Block[]; created_at: Date }[],
          summary: c.summary as string,
          summaryUntil: c.summary_until as Date | null,
          code: c.mode === 'code' ? { root: c.path as string } : null,
          settings: { ...DEFAULT_SETTINGS, ...settings.rows[0]?.data } as Settings,
        };
      });
      if ('error' in setup) {
        if (setup.error === 404) return reply.code(404).send({ error: 'Not found.' });
        if (setup.error === 'device') return reply.code(409).send({ error: 'Code chats run in the desktop app.' });
        if (setup.error === 'folder') return reply.code(409).send({ error: 'Choose the project folder on this device first.' });
        if (setup.error === 'conn') return reply.code(409).send({ error: 'This window is not connected. Reload and try again.' });
        return reply.code(400).send({ error: `Add your ${provider} API key in Settings first.` });
      }
      const conn = setup.code ? hub.find(connId, userId, device!.id) : undefined;
      const apiKey = unseal(dataKey(masterKey, userId, req.user.wrapped), setup.keyEnc, `pk:${userId}:${provider}`).toString();
      const info = getCatalog().find((m) => m.id === model);

      // Server-sent events over a POST response for the sender; the same events go to the user's
      // other open windows over the WebSocket hub.
      reply.hijack();
      const res = reply.raw;
      // Keep headers set by hooks so far (CORS for the desktop app).
      res.writeHead(200, { ...(reply.getHeaders() as Record<string, string>), 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const send = (o: object) => {
        res.write(`data: ${JSON.stringify(o)}\n\n`);
        hub.broadcast(userId, { t: 'chat', chatId: id, e: o }, connId);
      };
      send({ t: 'user', message: setup.userMsg });

      // Closing the tab or pressing Stop aborts the model call; whatever arrived so far is kept.
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(setup.code ? CODE_TURN_TIMEOUT_MS : TURN_TIMEOUT_MS)]);
      active.set(userId, (active.get(userId) ?? 0) + 1);

      // History; messages already folded into the summary aren't sent again.
      const rows = historyRows(setup.history);
      let summary = setup.summary;
      let recent = rows.filter((r) => !setup.summaryUntil || r.created_at > setup.summaryUntil);
      let compactCost = 0;
      let compacted = false;

      // Reply blocks in the order they arrived: thinking, text, tool calls and their results.
      const content: Block[] = [];
      const append = (type: 'text' | 'thinking', d: string) => {
        const last = content[content.length - 1];
        if (last?.type === type) last.text += d;
        else content.push({ type, text: d });
      };
      let failure = '';
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

        // Stable parts first (base prompt, environment), so the cached prefix survives from turn to turn.
        const system =
          (setup.code ? `${CODE_PROMPT}\n\n${environmentBlock(device!, setup.code.root)}` : systemPrompt()) +
          (setup.settings.short ? `\n\n${SHORT_ANSWERS}` : '') +
          (summary ? `\n\nSummary of the earlier conversation:\n${summary}` : '');

        const tools = setup.code
          ? codeTools(async (name, input, callId) => {
              const r = await hub.request(conn!, { chatId: id, tool: name, input, root: setup.code!.root }, TOOL_TIMEOUT_MS, signal);
              const output = headTail(r.output);
              content.push({ type: 'tool_result', callId, output, isError: r.isError, decision: r.decision, deviceId: device!.id });
              send({ t: 'tool_result', callId, output: output.slice(0, 4000), isError: r.isError, decision: r.decision });
              await withUser(pool, userId, (db) =>
                db.query(
                  'INSERT INTO tool_runs (user_id, chat_id, device_id, tool, input, decision, exit_code, duration_ms, is_error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                  [userId, id, device!.id, name, JSON.stringify(input), r.decision, r.exitCode ?? null, r.durationMs ?? null, r.isError],
                ),
              ).catch(() => {});
              return r.isError ? `Error: ${output}` : output;
            })
          : undefined;

        const result = streamText({
          model: languageModel(provider, modelId, apiKey, id),
          system,
          messages: await modelMessages(pool, userId, recent, !!info?.vision),
          tools,
          stopWhen: isStepCount(setup.code ? MAX_STEPS : 1),
          abortSignal: signal,
          maxRetries: 1,
          reasoning: reasoningLevel(info, setup.settings.thinkHard),
          providerOptions: cacheOptions(provider, modelId),
          // The SDK's default logs the whole error, which can include the chat text it sent. Errors
          // already reach the user through the stream, so nothing is logged here.
          onError: () => {},
        });
        const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        let saved = 0;
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            append('text', part.text);
            send({ t: 'text', d: part.text });
          } else if (part.type === 'reasoning-delta') {
            append('thinking', part.text);
            send({ t: 'thinking', d: part.text });
          } else if (part.type === 'tool-call') {
            content.push({ type: 'tool_call', id: part.toolCallId, name: part.toolName, input: part.input });
            send({ t: 'tool_call', id: part.toolCallId, name: part.toolName, input: part.input });
          } else if (part.type === 'error') {
            failure = errorText(part.error);
          } else if (part.type === 'finish-step') {
            // Every step (one model call) is priced on its own; caching savings add up across a tool loop.
            const u: Usage = {
              input: part.usage.inputTokens ?? null,
              output: part.usage.outputTokens ?? null,
              cacheRead: part.usage.inputTokenDetails?.cacheReadTokens ?? null,
              cacheWrite: part.usage.inputTokenDetails?.cacheWriteTokens ?? null,
            };
            for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) total[k] = (total[k] ?? 0) + (u[k] ?? 0);
            saved += priceCall(u, info?.cost ?? null).cacheSaved;
          }
        }
        if (total.input || total.output) {
          const priced = priceCall(total, info?.cost ?? null);
          // Savings meter: caching discount, plus history not resent because of the summary,
          // minus what the summary itself cost this turn.
          const full = rows.reduce((n, r) => n + estimateTokens(r.text), 0);
          const sent = estimateTokens(summary) + recent.reduce((n, r) => n + estimateTokens(r.text), 0);
          saved += (summary ? compactSaved(full, sent, info?.cost ?? null) : 0) - compactCost;
          usage = { ...total, cost: round(priced.cost + compactCost), saved: round(saved), ...(compacted && { compacted: true }) };
        }
      } catch (e) {
        if (!abort.signal.aborted) failure = errorText(e);
      } finally {
        active.set(userId, (active.get(userId) ?? 1) - 1);
        if (!active.get(userId)) active.delete(userId);
      }

      if (failure) content.push({ type: 'error', text: failure });
      if (!content.some((b) => b.type !== 'thinking')) content.push({ type: 'error', text: abort.signal.aborted ? 'Stopped.' : 'The model sent an empty reply.' });
      try {
        const saved = await withUser(pool, userId, async (db) => {
          const { rows } = await db.query(
            "INSERT INTO messages (chat_id, user_id, role, content, model, usage, device_id) VALUES ($1, $2, 'assistant', $3, $4, $5, $6) RETURNING id, role, content, model, usage, created_at",
            [id, userId, JSON.stringify(content), model, usage && JSON.stringify(usage), device?.id ?? null],
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

// History -> model messages. Images go along only with the newest few messages (image tokens add up fast).
async function modelMessages(pool: pg.Pool, userId: string, recent: HistoryRow[], vision: boolean): Promise<ModelMessage[]> {
  const keep = recent.slice(-IMAGES_KEPT).flatMap((r) => r.images ?? []);
  const data = vision && keep.length
    ? new Map((await withUser(pool, userId, (db) => db.query('SELECT id, data FROM blobs WHERE id = ANY($1)', [keep.map((i) => i.id)]))).rows.map((r) => [r.id, r.data as Buffer]))
    : new Map<string, Buffer>();
  return recent.map((r): ModelMessage => {
    if (r.role === 'assistant') return { role: 'assistant', content: r.text };
    const imgs = (r.images ?? []).filter((i) => data.has(i.id));
    const dropped = (r.images?.length ?? 0) - imgs.length;
    const text = r.text + (dropped ? `\n\n[${dropped} image${dropped > 1 ? 's' : ''} not shown]` : '');
    if (!imgs.length) return { role: 'user', content: text };
    return { role: 'user', content: [{ type: 'text', text }, ...imgs.map((i) => ({ type: 'image' as const, image: data.get(i.id)!, mediaType: i.mime }))] };
  });
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
