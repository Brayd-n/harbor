// Desktop app (Tauri) glue. The same UI runs in the browser, where none of this is used: there the
// session cookie authenticates, and Code mode isn't available.
import { invoke } from '@tauri-apps/api/core';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const DEFAULT_SERVER = 'https://harbor.brayd-n.com';
export const getServer = () => {
  try {
    return localStorage.getItem('server') || DEFAULT_SERVER;
  } catch {
    return DEFAULT_SERVER;
  }
};
export const setServer = (s: string) => localStorage.setItem('server', s.replace(/\/+$/, ''));

/** Absolute URL for an API path: same origin on the web, the linked server on desktop. */
export const url = (path: string) => (isDesktop ? getServer() + path : path);

export type DeviceInfo = { os: string; os_version: string; arch: string; hostname: string; home_dir: string; shell: string };
export const deviceInfo = () => invoke<DeviceInfo>('device_info');
export const pickFolder = () => invoke<string | null>('pick_folder');
export const policyGet = () => invoke<[{ workspaces: string[]; allow_commands: string[]; deny_commands: string[] }, string]>('policy_get');

// --- Tokens: the refresh token lives in the OS keychain; the 15-minute access token only in memory. ---

let access: { token: string; until: number } | null = null;
let refreshing: Promise<string | null> | null = null;

export const hasLink = async () => !!(await invoke<string | null>('token_get', { server: getServer() }));

export async function saveTokens(t: { access_token: string; refresh_token: string; expires_in: number }) {
  await invoke('token_set', { server: getServer(), token: t.refresh_token });
  access = { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 };
}

export async function unlink() {
  access = null;
  await invoke('token_clear', { server: getServer() });
}

// One refresh at a time: refresh tokens work once, and a second use of the same one revokes the device.
export function accessToken(force = false): Promise<string | null> {
  if (!force && access && access.until > Date.now()) return Promise.resolve(access.token);
  refreshing ??= (async () => {
    try {
      const refresh = await invoke<string | null>('token_get', { server: getServer() });
      if (!refresh) return null;
      const res = await fetch(url('/auth/device/refresh'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      });
      if (res.status === 401) {
        await unlink();
        return null;
      }
      if (!res.ok) throw new Error(`Could not reach ${getServer()}`);
      await saveTokens(await res.json());
      return access!.token;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** fetch() with the device token on desktop, retried once after a refresh if it was stale. */
export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!isDesktop) return fetch(path, init);
  for (const force of [false, true]) {
    const token = await accessToken(force);
    if (!token) return new Response(JSON.stringify({ error: 'Link this device again.' }), { status: 401 });
    const res = await fetch(url(path), { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
    if (res.status !== 401 || force) return res;
  }
  throw new Error('unreachable');
}

// --- Device-code linking ---

export async function startLink(name: string) {
  const res = await fetch(url('/auth/device/start'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, info: await deviceInfo() }),
  }).catch(() => {
    throw new Error(`Can't reach ${getServer()}`);
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Could not reach ${getServer()}`);
  return data as { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };
}

/** Polls until the code is approved in the browser. Resolves once tokens are stored. */
export async function waitForLink(deviceCode: string, interval: number, signal: AbortSignal) {
  while (!signal.aborted) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await fetch(url('/auth/device/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
      signal,
    }).catch((e) => {
      if (signal.aborted) throw e;
      return null; // a network blip; keep waiting until the code expires
    });
    if (!res || res.status === 428) continue;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await saveTokens(data);
    return;
  }
}

// --- Code mode tools ---

export type ToolRequest = { id: string; chatId: string; tool: string; input: Record<string, unknown>; root: string };
export type Check = { decision: 'auto' | 'ask' | 'deny'; reason: string | null; cwd: string; shell: string; detail: string };
export type ToolResult = { output: string; isError: boolean; decision: string; exitCode: number | null; durationMs: number };

const strip = ({ tool, input, root }: ToolRequest) => ({ tool, input, root });
export const toolCheck = (r: ToolRequest) => invoke<Check>('tool_check', { req: strip(r) });
export const toolRun = (r: ToolRequest, approved: boolean) => invoke<ToolResult>('tool_run', { req: strip(r), approved });
