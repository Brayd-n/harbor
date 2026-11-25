// Device linking. Desktop: show a code and open the browser. Web: /link?code=… asks you to approve it.
import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api.ts';
import { Mark } from './Auth.tsx';
import { deviceInfo, getServer, setServer, startLink, waitForLink, type DeviceInfo } from './desktop.ts';

export function LinkDevice({ onLinked }: { onLinked: () => void }) {
  const [server, setServerField] = useState(getServer());
  const [name, setName] = useState('');
  const [code, setCode] = useState<{ user_code: string; verification_uri: string } | null>(null);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    deviceInfo().then((i) => setName(`${i.os === 'windows' ? 'Windows' : i.os === 'linux' ? 'Linux' : i.os} desktop`));
    return () => abort.current?.abort();
  }, []);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      setServer(server.trim());
      const c = await startLink(name.trim());
      setCode(c);
      openUrl(c.verification_uri).catch(() => {}); // the code is on screen either way
      abort.current = new AbortController();
      await waitForLink(c.device_code, c.interval, abort.current.signal);
      onLinked();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(err instanceof Error ? err.message : String(err));
      setCode(null);
    }
  };

  return (
    <main className="auth">
      <div className="auth-mark" aria-hidden>
        <Mark />
      </div>
      <h1 className="auth-title">Harbor</h1>
      {code ? (
        <div className="code-form">
          <label>Code</label>
          <output className="code-input link-code">{code.user_code}</output>
          <button className="btn btn-wide" onClick={() => openUrl(code.verification_uri).catch((e) => setError(String(e)))}>
            Open browser again
          </button>
          <button className="link muted" onClick={() => (abort.current?.abort(), setCode(null))}>
            Cancel
          </button>
          {error && <p className="form-error">{error}</p>}
        </div>
      ) : (
        <form className="code-form" onSubmit={start}>
          <label htmlFor="server">Server</label>
          <input id="server" className="text-input" value={server} onChange={(e) => setServerField(e.target.value)} spellCheck={false} />
          <label htmlFor="name">Device name</label>
          <input id="name" className="text-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <button className="btn btn-primary btn-wide" disabled={!name.trim() || !server.trim()}>
            Link this device
          </button>
          {error && <p className="form-error">{error}</p>}
        </form>
      )}
    </main>
  );
}

/** Web side: approve a device code. Shown at /link (the code comes from the URL, or is typed). */
export function ApproveLink({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState(new URLSearchParams(location.search).get('code') ?? '');
  const [found, setFound] = useState<{ name: string; info: Partial<DeviceInfo> } | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const look = async (e?: FormEvent) => {
    e?.preventDefault();
    setError('');
    try {
      const d = await api<{ name: string; info: Partial<DeviceInfo> }>(`/api/device-codes/${encodeURIComponent(code.trim())}`);
      setFound(d);
      setName(d.name);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    if (code) look();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async () => {
    try {
      await api('/api/devices/link', { method: 'POST', body: { code: code.trim(), name: name.trim() } });
      try {
        sessionStorage.removeItem('pending-link'); // done; later visits open the app as usual
      } catch {}
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="auth">
      <div className="auth-mark" aria-hidden>
        <Mark />
      </div>
      <h1 className="auth-h">Link a device</h1>
      {done ? (
        <>
          <p className="auth-lede">Linked. You can close this tab.</p>
          <button className="btn" onClick={onDone}>Open Harbor</button>
        </>
      ) : found ? (
        <div className="code-form">
          <section className="kv">
            <span className="muted">Code</span>
            <span className="mono">{code.toUpperCase()}</span>
            {found.info.os && (
              <>
                <span className="muted">System</span>
                <span>{`${found.info.os} ${found.info.os_version ?? ''} · ${found.info.arch ?? ''}`}</span>
              </>
            )}
            {found.info.hostname && (
              <>
                <span className="muted">Host</span>
                <span>{found.info.hostname}</span>
              </>
            )}
          </section>
          <label htmlFor="dname">Name</label>
          <input id="dname" className="text-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <p className="auth-note">Only approve a code shown by your own Harbor app.</p>
          <button className="btn btn-primary btn-wide" onClick={approve} disabled={!name.trim()}>
            Approve
          </button>
          <button className="link muted" onClick={onDone}>
            Cancel
          </button>
          {error && <p className="form-error">{error}</p>}
        </div>
      ) : (
        <form className="code-form" onSubmit={look}>
          <label htmlFor="code">Code from the app</label>
          <input id="code" className="code-input" value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" />
          <button className="btn btn-primary btn-wide" disabled={!code.trim()}>
            Continue
          </button>
          {error && <p className="form-error">{error}</p>}
        </form>
      )}
    </main>
  );
}
