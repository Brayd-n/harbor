// WebSocket hub: every open window of a user gets live chat events, and tool requests go to exactly
// one connection, the window that sent the user's message, on the device that owns it.
import { randomUUID } from 'node:crypto';

export type Conn = { id: string; userId: string; deviceId: string | null; send: (o: object) => void; close: () => void };
export type ToolRequest = { chatId: string; tool: string; input: unknown; root: string };
export type ToolResult = {
  output: string;
  isError: boolean;
  decision: 'auto' | 'approved' | 'denied' | 'policy_blocked' | 'unavailable';
  exitCode?: number | null;
  durationMs?: number | null;
};

const DECISIONS = new Set(['auto', 'approved', 'denied', 'policy_blocked']);

export class Hub {
  private conns = new Map<string, Conn>();
  private pending = new Map<string, { conn: Conn; done: (r: ToolResult) => void }>();

  add(conn: Omit<Conn, 'id'>): Conn {
    const c = { ...conn, id: randomUUID() };
    this.conns.set(c.id, c);
    return c;
  }

  remove(conn: Conn) {
    this.conns.delete(conn.id);
    for (const [id, p] of this.pending) if (p.conn === conn) this.finish(id, unavailable('The desktop app disconnected.'));
  }

  // The connection a turn's tools run on: it must belong to this user and this device.
  find(connId: string | undefined, userId: string, deviceId: string): Conn | undefined {
    const c = connId ? this.conns.get(connId) : undefined;
    return c && c.userId === userId && c.deviceId === deviceId ? c : undefined;
  }

  broadcast(userId: string, event: object, exceptConnId?: string) {
    for (const c of this.conns.values()) if (c.userId === userId && c.id !== exceptConnId) c.send(event);
  }

  kickDevice(deviceId: string) {
    for (const c of this.conns.values()) if (c.deviceId === deviceId) c.close();
  }

  kickUser(userId: string) {
    for (const c of this.conns.values()) if (c.userId === userId) c.close();
  }

  // Sends a tool request and waits for that same connection to answer. Results from any other
  // connection, even the same user's other device, are ignored.
  request(conn: Conn, req: ToolRequest, timeoutMs: number, signal: AbortSignal): Promise<ToolResult> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(id, unavailable('No answer from the desktop app in time.')), timeoutMs);
      const onAbort = () => this.finish(id, unavailable('Stopped.'));
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        conn,
        done: (r) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(r);
        },
      });
      if (signal.aborted) return onAbort();
      conn.send({ t: 'tool_request', id, ...req });
    });
  }

  onResult(conn: Conn, msg: { id?: unknown; output?: unknown; isError?: unknown; decision?: unknown; exitCode?: unknown; durationMs?: unknown }) {
    const p = typeof msg.id === 'string' ? this.pending.get(msg.id) : undefined;
    if (!p || p.conn !== conn) return;
    this.finish(msg.id as string, {
      output: String(msg.output ?? '').slice(0, 200_000),
      isError: msg.isError === true,
      decision: DECISIONS.has(msg.decision as string) ? (msg.decision as ToolResult['decision']) : 'denied',
      exitCode: Number.isInteger(msg.exitCode) ? (msg.exitCode as number) : null,
      durationMs: Number.isInteger(msg.durationMs) ? (msg.durationMs as number) : null,
    });
  }

  private finish(id: string, r: ToolResult) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.done(r);
  }
}

const unavailable = (output: string): ToolResult => ({ output, isError: true, decision: 'unavailable' });
