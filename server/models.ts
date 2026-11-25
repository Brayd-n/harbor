import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

// OpenCode Go serves each model through the API style it was built for (OpenAI-compatible by default,
// some through Anthropic-, OpenAI- or Google-style endpoints). models.dev says which, per model.
// Keys only ever go to this prefix, whatever the catalog says.
const OPENCODE_GO = 'https://opencode.ai/inference/go/';

type Sdk = { npm: string; api?: string };

// Go asks every client for a stable session id per conversation (routing and prompt caching)
// and its own user agent: https://opencode.ai/v2/docs/console/go/
function openCodeGo(apiKey: string, modelId: string, sdk: Sdk | undefined, chatId: string) {
  const headers = { 'x-opencode-session': `ses_${chatId.replace(/-/g, '')}`, 'user-agent': 'harbor/0.1 (+https://harbor.brayd-n.com)' };
  const baseURL = sdk?.api?.startsWith(OPENCODE_GO) ? sdk.api : `${OPENCODE_GO}openai/v1`;
  switch (sdk?.api?.startsWith(OPENCODE_GO) ? sdk.npm : '') {
    case '@ai-sdk/anthropic':
      return createAnthropic({ apiKey, baseURL, headers })(modelId);
    case '@ai-sdk/openai':
      return createOpenAI({ apiKey, baseURL, headers })(modelId);
    case '@ai-sdk/google':
      return createGoogleGenerativeAI({ apiKey, baseURL, headers })(modelId);
    default:
      return createOpenAICompatible({ name: 'opencode-go', apiKey, baseURL, headers, includeUsage: true })(modelId);
  }
}

export const PROVIDERS = {
  anthropic: { name: 'Anthropic', make: (apiKey: string, id: string) => createAnthropic({ apiKey })(id) },
  openai: { name: 'OpenAI', make: (apiKey: string, id: string) => createOpenAI({ apiKey })(id) },
  google: { name: 'Google', make: (apiKey: string, id: string) => createGoogleGenerativeAI({ apiKey })(id) },
  openrouter: { name: 'OpenRouter', make: (apiKey: string, id: string) => createOpenRouter({ apiKey })(id) },
  'opencode-go': { name: 'OpenCode Go', make: (apiKey: string, id: string, sdk: Sdk | undefined, chatId: string) => openCodeGo(apiKey, id, sdk, chatId) },
} as const;
export type ProviderId = keyof typeof PROVIDERS;
export const isProvider = (p: string): p is ProviderId => Object.hasOwn(PROVIDERS, p);

export const languageModel = (provider: ProviderId, modelId: string, apiKey: string, chatId: string): LanguageModel => {
  const sdk = catalog.find((m) => m.id === `${provider}:${modelId}`)?.sdk;
  return PROVIDERS[provider].make(apiKey, modelId, sdk, chatId) as LanguageModel;
};

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
  sdk?: Sdk; // per-model API style, only used for OpenCode Go
};

// Model list from models.dev, the open catalog OpenCode uses. Refreshed daily, kept in memory.
let catalog: CatalogModel[] = [];
export const getCatalog = () => catalog;

type DevModel = {
  id: string; name: string; status?: string; tool_call?: boolean; reasoning?: boolean; release_date?: string;
  modalities?: { input?: string[]; output?: string[] }; limit?: { context?: number }; cost?: { input?: number; output?: number };
  provider?: Sdk;
};

export function parseCatalog(data: Record<string, { models?: Record<string, DevModel> }>): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const provider of Object.keys(PROVIDERS) as ProviderId[]) {
    for (const m of Object.values(data[provider]?.models ?? {})) {
      if (m.status === 'deprecated' || !(m.modalities?.output ?? ['text']).includes('text')) continue;
      // Go's free models only answer requests from OpenCode itself.
      if (provider === 'opencode-go' && m.id.endsWith('-free')) continue;
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
        ...(provider === 'opencode-go' && m.provider?.npm ? { sdk: { npm: m.provider.npm, api: m.provider.api } } : {}),
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
