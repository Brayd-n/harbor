export type User = { email: string; name: string; role: 'owner' | 'user' };
export type AuthState = { step: 'signed_out' } | { step: 'enroll' | 'verify' | 'ready'; user: User };

export type Block = { type: 'text' | 'thinking' | 'error'; text: string };
export type Message = { id: string; role: 'user' | 'assistant'; content: Block[]; model?: string | null; usage?: { input: number | null; output: number | null } | null; created_at: string };
export type ChatSummary = { id: string; title: string; model: string; updated_at: string };
export type Chat = ChatSummary & { messages: Message[] };
export type Model = { id: string; provider: string; name: string; vision: boolean; reasoning: boolean; tools: boolean; context: number | null; cost: { input: number; output: number } | null };
export type Provider = { id: string; name: string; key: { last4: string; created_at: string } | null };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path.startsWith('/api/')) location.assign('/');
    throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export type StreamEvent =
  | { t: 'user'; message: Message }
  | { t: 'text' | 'thinking'; d: string }
  | { t: 'done'; message: Message };

// Sends a message and calls onEvent for each server-sent event until the reply is saved.
export async function sendMessage(chatId: string, text: string, model: string, signal: AbortSignal, onEvent: (e: StreamEvent) => void) {
  const res = await fetch(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, model }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

export const PROVIDER_HELP: Record<string, { url: string; hint: string }> = {
  anthropic: { url: 'https://console.anthropic.com/settings/keys', hint: 'Starts with sk-ant-' },
  openai: { url: 'https://platform.openai.com/api-keys', hint: 'Starts with sk-' },
  google: { url: 'https://aistudio.google.com/apikey', hint: 'From Google AI Studio' },
  openrouter: { url: 'https://openrouter.ai/settings/keys', hint: 'Starts with sk-or-' },
  'opencode-go': { url: 'https://opencode.ai/auth', hint: 'API key from your OpenCode workspace (Go plan)' },
};

export function relativeDay(iso: string) {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1 && d.getDate() === new Date().getDate()) return 'Today';
  if (days < 7) return 'This week';
  if (days < 30) return 'This month';
  return 'Older';
}
