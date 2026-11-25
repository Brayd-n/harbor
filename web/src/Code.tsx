// Code mode pieces: device badge, tool call rows, approval cards, the audit log, the project picker.
import { useEffect, useState } from 'react';
import { api, blobUrl, type Device, type Project, type ToolRun } from './api.ts';
import { pickFolder } from './desktop.ts';
import { useApprovals } from './live.ts';

const shorten = (p: string, home: string) => {
  const rel = home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  const parts = rel.split(/[\\/]/);
  return parts.length > 4 ? `${parts[0]}${rel.includes('\\') ? '\\' : '/'}…${rel.includes('\\') ? '\\' : '/'}${parts.slice(-2).join(rel.includes('\\') ? '\\' : '/')}` : rel;
};
const shellShort = (s: string) => (s.includes('pwsh') ? 'pwsh' : s.split(' ')[0] || 'shell');

/** Always visible on desktop: where commands from this window run. */
export function DeviceBadge({ device, path }: { device: Device; path?: string | null }) {
  return (
    <span className="device-badge" title={`${device.os} ${device.os_version} · ${device.shell}${path ? ` · ${path}` : ''}`}>
      <span className="device-dot" aria-hidden />
      {device.name}
      <span className="device-sep">·</span>
      {shellShort(device.shell)}
      {path && (
        <>
          <span className="device-sep">·</span>
          {shorten(path, device.home_dir)}
        </>
      )}
    </span>
  );
}

const target = (input: Record<string, unknown>) => String(input.command ?? input.path ?? input.pattern ?? '');
const decisionLabel: Record<string, string> = { auto: 'auto', approved: 'approved', denied: 'declined', policy_blocked: 'blocked', unavailable: 'not run' };

/** One line per tool call; click to see the input and output. */
export function ToolRow({ name, input, result }: { name: string; input: Record<string, unknown>; result?: { output: string; isError: boolean; decision: string } }) {
  const status = !result ? 'running' : result.decision !== 'auto' && result.decision !== 'approved' ? decisionLabel[result.decision] : result.isError ? 'error' : 'ok';
  return (
    <details className={`tool-row ${status}`}>
      <summary>
        <span className="tool-name">{name}</span>
        <span className="tool-target">{target(input)}</span>
        <span className="tool-status">{status}</span>
      </summary>
      {name === 'edit_file' ? (
        <pre className="tool-out">
          <span className="del">{String(input.old_string)}</span>
          {'\n'}
          <span className="add">{String(input.new_string)}</span>
        </pre>
      ) : name === 'write_file' ? (
        <pre className="tool-out">{String(input.content)}</pre>
      ) : null}
      {result && <pre className="tool-out">{result.output}</pre>}
    </details>
  );
}

const verb: Record<string, string> = { shell: 'Run command', edit_file: 'Edit file', write_file: 'Write file' };

/** Approval cards: the exact command or change, the folder and the shell. Nothing paraphrased by the model. */
export function Approvals() {
  const list = useApprovals();
  if (!list.length) return null;
  return (
    <div className="approvals" role="region" aria-label="Approvals">
      {list.map((a) => (
        <section key={a.req.id} className="approval" role="alertdialog" aria-label={verb[a.req.tool] ?? a.req.tool}>
          <header>
            <strong>{verb[a.req.tool] ?? a.req.tool}</strong>
            <span className="muted mono">{a.check.cwd}</span>
            <span className="tag">{a.check.shell}</span>
          </header>
          <pre className="approval-detail">{a.check.detail}</pre>
          <div className="actions">
            <button className="btn btn-primary btn-small" onClick={() => a.answer(true)}>
              Approve
            </button>
            <button className="btn btn-small" onClick={() => a.answer(false)}>
              Decline
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}

export function AuditPanel({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const [runs, setRuns] = useState<ToolRun[] | null>(null);
  useEffect(() => {
    const load = () => api<ToolRun[]>(`/api/chats/${chatId}/tool-runs`).then(setRuns);
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [chatId]);
  return (
    <aside className="audit" aria-label="Audit log">
      <header>
        <h2>Audit log</h2>
        <button className="btn btn-ghost icon" onClick={onClose} aria-label="Close audit log">
          ✕
        </button>
      </header>
      <table className="events">
        <thead>
          <tr>
            <th>Time</th>
            <th>Tool</th>
            <th>Decision</th>
            <th>Exit</th>
            <th>ms</th>
          </tr>
        </thead>
        <tbody>
          {runs?.map((r) => (
            <tr key={r.id} className={r.decision === 'policy_blocked' || r.decision === 'denied' ? 'warn' : ''}>
              <td className="muted">{new Date(r.created_at).toLocaleTimeString()}</td>
              <td>
                <span className="mono">{r.tool}</span>
                <div className="audit-target mono">{target(r.input)}</div>
                <div className="muted small">{r.device}</div>
              </td>
              <td>{decisionLabel[r.decision] ?? r.decision}</td>
              <td className="mono">{r.exit_code ?? ''}</td>
              <td className="mono">{r.duration_ms ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {runs?.length === 0 && <p className="muted small">No tool runs yet.</p>}
    </aside>
  );
}

/** Projects on this account; a project without a folder on this device asks for one. */
export function ProjectPicker({ value, onChange }: { value: Project | null; onChange: (p: Project) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Project[]>('/api/projects').then((ps) => {
      setProjects(ps);
      if (!value) {
        const first = ps.find((p) => p.path);
        if (first) onChange(first);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async () => {
    setError('');
    try {
      const path = await pickFolder();
      if (!path) return;
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      const p = await api<Project>('/api/projects', { method: 'POST', body: { name, path } });
      setProjects((ps) => [p, ...ps]);
      onChange(p);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const locate = async (p: Project) => {
    const path = await pickFolder();
    if (!path) return;
    await api(`/api/projects/${p.id}/path`, { method: 'PUT', body: { path } });
    const next = { ...p, path };
    setProjects((ps) => ps.map((x) => (x.id === p.id ? next : x)));
    onChange(next);
  };

  return (
    <div className="projects">
      <ul>
        {projects.map((p) => (
          <li key={p.id}>
            <button className={`project ${value?.id === p.id ? 'on' : ''}`} onClick={() => (p.path ? onChange(p) : locate(p))}>
              <span>{p.name}</span>
              <span className="muted mono small">{p.path ?? 'Choose folder'}</span>
            </button>
          </li>
        ))}
      </ul>
      <button className="btn btn-small" onClick={open}>
        Open folder
      </button>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

export function BlobImage({ id, alt = 'image' }: { id: string; alt?: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    blobUrl(id).then(setSrc);
  }, [id]);
  return src ? <img className="msg-image" src={src} alt={alt} /> : <span className="msg-image placeholder" />;
}
