import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

export const PROVIDERS = {
  anthropic: { name: 'Anthropic', make: (apiKey: string) => createAnthropic({ apiKey }) },
  openai: { name: 'OpenAI', make: (apiKey: string) => createOpenAI({ apiKey }) },
  google: { name: 'Google', make: (apiKey: string) => createGoogleGenerativeAI({ apiKey }) },
  openrouter: { name: 'OpenRouter', make: (apiKey: string) => createOpenRouter({ apiKey }) },
} as const;
export type ProviderId = keyof typeof PROVIDERS;
export const isProvider = (p: string): p is ProviderId => Object.hasOwn(PROVIDERS, p);

export const languageModel = (provider: ProviderId, modelId: string, apiKey: string): LanguageModel =>
  PROVIDERS[provider].make(apiKey)(modelId) as LanguageModel;

// "openrouter:meta-llama/llama-4:free" -> ["openrouter", "meta-llama/llama-4:free"]
export function splitModel(ref: string): [ProviderId, string] | null {
  const i = ref.indexOf(':');
  const provider = ref.slice(0, i);
  return i > 0 && isProvider(provider) && ref.length > i + 1 ? [provider, ref.slice(i + 1)] : null;
}

export type CatalogModel = {
  id: string; // "provider:model-id"
  provider: ProviderId;
  name: string;
  vision: boolean;
  reasoning: boolean;
  tools: boolean;
  context: number | null;
  cost: { input: number; output: number } | null; // USD per million tokens
  released: string;
};

// Model list from models.dev, the open catalog OpenCode uses. Refreshed daily, kept in memory.
let catalog: CatalogModel[] = [];
export const getCatalog = () => catalog;

type DevModel = {
  id: string; name: string; status?: string; tool_call?: boolean; reasoning?: boolean; release_date?: string;
  modalities?: { input?: string[]; output?: string[] }; limit?: { context?: number }; cost?: { input?: number; output?: number };
};

export function parseCatalog(data: Record<string, { models?: Record<string, DevModel> }>): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const provider of Object.keys(PROVIDERS) as ProviderId[]) {
    for (const m of Object.values(data[provider]?.models ?? {})) {
      if (m.status === 'deprecated' || !(m.modalities?.output ?? ['text']).includes('text')) continue;
      out.push({
        id: `${provider}:${m.id}`,
        provider,
        name: m.name,
        vision: m.modalities?.input?.includes('image') ?? false,
        reasoning: !!m.reasoning,
        tools: !!m.tool_call,
        context: m.limit?.context ?? null,
        cost: m.cost?.input != null && m.cost.output != null ? { input: m.cost.input, output: m.cost.output } : null,
        released: m.release_date ?? '',
      });
    }
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || b.released.localeCompare(a.released));
}

export async function refreshCatalog(log: { warn: (o: object, msg: string) => void }) {
  try {
    const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = parseCatalog(await res.json());
    if (next.length) catalog = next;
  } catch (e) {
    log.warn({ err: String(e) }, 'could not refresh the model catalog; keeping the old one');
  }
}

export const setCatalogForTests = (c: CatalogModel[]) => (catalog = c);
