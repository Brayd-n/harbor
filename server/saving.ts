// Token saving: settings, thinking level, per-reply cost and savings, and auto-compact.
import { generateText, type LanguageModel } from 'ai';
import type { CatalogModel } from './models.ts';

export type Settings = { compact: boolean; short: boolean; thinkHard: boolean };
export const DEFAULT_SETTINGS: Settings = { compact: true, short: false, thinkHard: false };
export const settingsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { compact: { type: 'boolean' }, short: { type: 'boolean' }, thinkHard: { type: 'boolean' } },
};

export const SHORT_ANSWERS =
  'Answer as briefly as the question allows. No preamble, no restating the question, no closing summary or offers of more help. ' +
  'Keep code, numbers and exact details complete.';

// --- Thinking ---

const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type Level = (typeof LEVELS)[number];

// Thinking is billed as output. By default use the least the model allows ('none' where it can be
// turned off); "think harder" asks for 'high'. Levels come from the model's own list in the catalog.
export function reasoningLevel(model: CatalogModel | undefined, thinkHard: boolean): Level | undefined {
  if (!model?.reasoning) return undefined;
  const allowed = (model.effort ?? []).filter((v): v is Level => (LEVELS as readonly string[]).includes(v));
  if (!allowed.length) return thinkHard ? 'high' : 'none';
  const sorted = [...allowed].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b));
  if (!thinkHard) return sorted[0];
  return sorted.includes('high') ? 'high' : sorted[sorted.length - 1];
}

// --- Cost ---

export type Usage = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };

const perM = (tokens: number | null | undefined, price: number | undefined) => ((tokens ?? 0) * (price ?? 0)) / 1e6;

// USD for one call, and what prompt caching saved compared with paying the full input price.
export function priceCall(u: Usage, cost: CatalogModel['cost']) {
  if (!cost) return { cost: 0, cacheSaved: 0 };
  const read = u.cacheRead ?? 0;
  const write = u.cacheWrite ?? 0;
  const fresh = Math.max(0, (u.input ?? 0) - read - write);
  const total =
    perM(fresh, cost.input) + perM(read, cost.cacheRead ?? cost.input) + perM(write, cost.cacheWrite ?? cost.input) + perM(u.output, cost.output);
  // Cache writes cost a bit more than plain input; that premium counts against the saving.
  const cacheSaved = perM(read, cost.input - (cost.cacheRead ?? cost.input)) - perM(write, (cost.cacheWrite ?? cost.input) - cost.input);
  return { cost: total, cacheSaved };
}

// --- Auto-compact ---

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
const KEEP_RECENT = 6; // newest messages always sent word for word
const COMPACT_AT = 24_000; // tokens of history, or 40% of the model's context if that's smaller

export type HistoryRow = { role: 'user' | 'assistant'; text: string; created_at: Date };

// Which messages to fold into the summary this turn, if any.
export function compactionPlan(summary: string, recent: HistoryRow[], context: number | null) {
  const limit = Math.min(COMPACT_AT, Math.floor((context ?? 128_000) * 0.4));
  const size = estimateTokens(summary) + recent.reduce((n, r) => n + estimateTokens(r.text), 0);
  if (size <= limit || recent.length <= KEEP_RECENT) return null;
  return { fold: recent.slice(0, -KEEP_RECENT), keep: recent.slice(-KEEP_RECENT) };
}

const transcript = (rows: HistoryRow[]) => rows.map((r) => `${r.role === 'user' ? 'User' : 'Assistant'}: ${r.text}`).join('\n\n');

export async function summarize(model: LanguageModel, previous: string, fold: HistoryRow[], signal: AbortSignal) {
  const { text, usage } = await generateText({
    model,
    abortSignal: signal,
    maxRetries: 1,
    maxOutputTokens: 1200,
    system:
      'You compress chat history so an assistant can continue the conversation without the original messages. ' +
      'Keep facts, decisions, names, numbers, code identifiers, file names, open questions and the user’s stated preferences. ' +
      'Drop greetings and filler. Write terse notes, at most 400 words.',
    prompt: `${previous ? `Earlier summary:\n${previous}\n\n` : ''}Conversation to add:\n${transcript(fold)}`,
  });
  return {
    text: text.trim(),
    usage: {
      input: usage.inputTokens ?? null,
      output: usage.outputTokens ?? null,
      cacheRead: usage.inputTokenDetails?.cacheReadTokens ?? null,
      cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? null,
    } satisfies Usage,
  };
}

// The cheapest model with a known price on the same provider as the chat (that key is known to work).
export function cheapestModel(catalog: CatalogModel[], provider: string, needTokens: number): CatalogModel | undefined {
  return catalog
    .filter((m) => m.provider === provider && m.cost && m.cost.input > 0 && (m.context ?? 0) >= needTokens * 1.2)
    .sort((a, b) => a.cost!.input + a.cost!.output - (b.cost!.input + b.cost!.output))[0];
}

// What sending the summary instead of the full history saved on this call. Priced at the cached-input
// rate where the model has one, so the claim stays conservative (those tokens might have been cached).
export function compactSaved(fullTokens: number, sentTokens: number, cost: CatalogModel['cost']) {
  if (!cost || fullTokens <= sentTokens) return 0;
  return perM(fullTokens - sentTokens, cost.cacheRead ?? cost.input);
}
