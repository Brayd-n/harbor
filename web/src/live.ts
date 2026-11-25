// The WebSocket to the server: live chat events from the user's other windows, and on desktop the
// tool requests for turns this window started. Reconnects on its own.
import { useSyncExternalStore } from 'react';
import { accessToken, deviceInfo, getServer, isDesktop, toolCheck, toolRun, unlink, type Check, type ToolRequest } from './desktop.ts';

export type ChatEvent = { t: 'chat'; chatId: string; e: { t: string; [k: string]: unknown } };

let ws: WebSocket | null = null;
let connId: string | null = null;
let retry = 0;
const listeners = new Set<(e: ChatEvent) => void>();

export const currentConn = () => connId;
export function onChatEvent(fn: (e: ChatEvent) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function connect() {
  if (ws) return;
  const base = isDesktop ? getServer() : location.origin;
  const sock = (ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws'));
  sock.onopen = async () => {
    if (!isDesktop) return;
    const token = await accessToken();
    if (!token) return location.reload();
    sock.send(JSON.stringify({ t: 'auth', token }));
    sock.send(JSON.stringify({ t: 'info', info: await deviceInfo() })); // keeps OS and shell current
  };
  sock.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.t === 'hello') {
      connId = msg.connId;
      retry = 0;
    } else if (msg.t === 'chat') for (const l of listeners) l(msg);
    else if (msg.t === 'tool_request' && isDesktop) handleTool(sock, msg);
  };
  sock.onclose = async (e) => {
    ws = null;
    connId = null;
    if (e.code === 4001) {
      // This device was revoked.
      await unlink();
      return location.reload();
    }
    if (e.code === 4401 && isDesktop) await accessToken(true).catch(() => null);
    setTimeout(connect, Math.min(30_000, 500 * 2 ** retry++));
  };
}

// --- Tool requests and the approval queue ---

export type Approval = { req: ToolRequest; check: Check; answer: (ok: boolean) => void };
let approvals: Approval[] = [];
const approvalSubs = new Set<() => void>();
const setApprovals = (next: Approval[]) => {
  approvals = next;
  for (const s of approvalSubs) s();
};
export const useApprovals = () =>
  useSyncExternalStore(
    (fn) => {
      approvalSubs.add(fn);
      return () => void approvalSubs.delete(fn);
    },
    () => approvals,
  );

async function handleTool(sock: WebSocket, req: ToolRequest) {
  const reply = (r: object) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ t: 'tool_result', id: req.id, ...r }));
  try {
    await runTool(req, reply);
  } catch (e) {
    reply({ output: `The desktop app could not run this: ${e}`, isError: true, decision: 'policy_blocked' });
  }
}

async function runTool(req: ToolRequest, reply: (r: object) => void) {
  const check = await toolCheck(req);
  let approved = false;
  if (check.decision === 'ask') {
    approved = await new Promise<boolean>((resolve) => {
      const item: Approval = {
        req,
        check,
        answer: (ok) => {
          setApprovals(approvals.filter((a) => a !== item));
          resolve(ok);
        },
      };
      setApprovals([...approvals, item]);
    });
  }
  reply(await toolRun(req, approved));
}

/** Approvals for a chat that was stopped or closed are answered "no". */
export const dropApprovals = (chatId: string) => approvals.filter((a) => a.req.chatId === chatId).forEach((a) => a.answer(false));
