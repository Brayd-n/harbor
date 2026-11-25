import { authFetch, isDesktop } from './desktop.ts';
import { currentConn } from './live.ts';

export type Device = { id: string; name: string; os: string; os_version: string; arch: string; hostname: string; home_dir: string; shell: string; last_seen?: string; current?: boolean };
export type User = { email: string; name: string; role: 'owner' | 'user'; device?: Device | null };
export type AuthState = { step: 'signed_out' } | { step: 'enroll' | 'verify' | 'ready'; user: User };

export type Block =
  | { type: 'text' | 'thinking' | 'error' | 'note'; text: string }
  | { type: 'image'; blobId: string; mime: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; output: string; isError: boolean; decision: string };
export type Message = { id: string; role: 'user' | 'assistant'; content: Block[]; model?: string | null; usage?: { input: number | null; output: number | null; cacheRead?: number | null; cost?: number; saved?: number; compacted?: boolean } | null; created_at: string };
export type ChatSummary = { id: string; title: string; model: string; mode: 'chat' | 'code'; updated_at: string };
export type Chat = ChatSummary & { messages: Message[]; summary_until: string | null; project_id: string | null; project: string | null; path: string | null };
export type Project = { id: string; name: string; path: string | null };
export type ToolRun = { id: number; tool: string; input: Record<string, unknown>; decision: string; exit_code: number | null; duration_ms: number | null; is_error: boolean; created_at: string; device: string };
export type SavingSettings = { compact: boolean; short: boolean; thinkHard: boolean };
export type UsageTotals = { month_cost: number; month_saved: number; total_cost: number; total_saved: number };

export const usd = (v: number) => (v === 0 ? '$0' : Math.abs(v) < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
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
  const res = await authFetch(path, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path.startsWith('/api/')) {
      if (isDesktop) location.reload();
      else location.assign('/');
    }
    throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export type StreamEvent =
  | { t: 'user'; message: Message }
  | { t: 'text' | 'thinking'; d: string }
  | { t: 'compacting' }
  | { t: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { t: 'tool_result'; callId: string; output: string; isError: boolean; decision: string }
  | { t: 'done'; message: Message };

// Sends a message and calls onEvent for each server-sent event until the reply is saved.
export async function sendMessage(chatId: string, text: string, model: string, images: string[], signal: AbortSignal, onEvent: (e: StreamEvent) => void) {
  // x-harbor-conn names this window's WebSocket: Code mode tools run here, and other windows get the stream.
  const res = await authFetch(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(currentConn() && { 'x-harbor-conn': currentConn()! }) },
    body: JSON.stringify({ text, model, ...(images.length && { images }) }),
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

// Image tokens scale with pixels, so images are shrunk before upload: longest side 1568 px (past
// that, Anthropic downsizes anyway), re-encoded as WebP. Small images go up as they are.
const MAX_SIDE = 1568;
export async function uploadImage(file: Blob): Promise<{ id: string; mime: string }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  let body: Blob = file;
  if (scale < 1 || file.size > 400_000) {
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    body = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
    // WebKitGTK may not encode WebP; it then returns PNG, which can be bigger. Fall back to JPEG.
    if (body.type !== 'image/webp') body = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  }
  bmp.close();
  const res = await authFetch('/api/blobs', { method: 'POST', headers: { 'content-type': body.type || 'image/png' }, body });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Upload failed');
  return data;
}

const blobUrls = new Map<string, Promise<string>>();
/** Object URL for an uploaded image (fetched with the user's credentials, cached for the session). */
export function blobUrl(id: string) {
  if (!blobUrls.has(id)) blobUrls.set(id, authFetch(`/api/blobs/${id}`).then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : '')));
  return blobUrls.get(id)!;
}
