import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, PROVIDER_HELP, usd, type Provider, type SavingSettings, type UsageTotals, type User } from './api.ts';

export function Settings({ user, tab, setTab, onClose }: { user: User; tab: string; setTab: (t: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const tabs: [string, string][] = [
    ['providers', 'API keys'],
    ['saving', 'Saving'],
    ['account', 'Account'],
    ...(user.role === 'owner' ? [['admin', 'Users'] as [string, string]] : []),
  ];
  return (
    <dialog ref={ref} className="settings" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}>
      <div className="settings-inner">
        <header className="settings-head">
          <h1>Settings</h1>
          <button className="btn btn-ghost icon" onClick={() => ref.current?.close()} aria-label="Close settings">
            ✕
          </button>
        </header>
        <div className="tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="settings-body">
          {tab === 'providers' && <Providers />}
          {tab === 'saving' && <Saving />}
          {tab === 'account' && <Account user={user} />}
          {tab === 'admin' && <Admin />}
        </div>
      </div>
    </dialog>
  );
}

const SWITCHES: [keyof SavingSettings, string][] = [
  ['compact', 'Compact long chats'],
  ['short', 'Short answers'],
  ['thinkHard', 'Extended thinking'],
];

function Saving() {
  const [s, setS] = useState<SavingSettings | null>(null);
  const [u, setU] = useState<UsageTotals | null>(null);
  useEffect(() => {
    api<SavingSettings>('/api/settings').then(setS);
    api<UsageTotals>('/api/usage').then(setU);
  }, []);
  const flip = async (key: keyof SavingSettings) => {
    if (!s) return;
    setS({ ...s, [key]: !s[key] });
    setS(await api<SavingSettings>('/api/settings', { method: 'PUT', body: { [key]: !s[key] } }));
  };
  return (
    <div className="stack">
      {u && (
        <section className="meter">
          <div>
            <span className="meter-value">{usd(u.month_cost)}</span>
            <span className="muted">Spent this month</span>
          </div>
          <div>
            <span className="meter-value saved">{usd(Math.max(0, u.month_saved))}</span>
            <span className="muted">Saved this month</span>
          </div>
        </section>
      )}
      {s && (
        <section className="switches">
          {SWITCHES.map(([key, label]) => (
            <label key={key} className="switch-row">
              <span>{label}</span>
              <button role="switch" aria-checked={s[key]} className="switch" onClick={() => flip(key)} />
            </label>
          ))}
        </section>
      )}
    </div>
  );
}

function Providers() {
  const [list, setList] = useState<Provider[]>([]);
  const load = () => api<Provider[]>('/api/providers').then(setList);
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="stack">
      {list.map((p) => (
        <ProviderRow key={p.id} p={p} onChange={load} />
      ))}
    </div>
  );
}

function ProviderRow({ p, onChange }: { p: Provider; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api(`/api/providers/${p.id}`, { method: 'PUT', body: { key: key.trim() } });
      setKey('');
      setEditing(false);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="provider">
      <div className="provider-head">
        <span className={`dot p-${p.id}`} aria-hidden />
        <strong>{p.name}</strong>
        <span className="muted">{p.key ? `Key ending in ${p.key.last4}` : 'No key'}</span>
        <span className="spacer" />
        {!editing && (
          <button className="btn btn-small" onClick={() => setEditing(true)}>
            {p.key ? 'Replace' : 'Add key'}
          </button>
        )}
        {p.key && !editing && (
          <button
            className="btn btn-small btn-danger-ghost"
            onClick={async () => {
              if (!confirm(`Remove your ${p.name} key?`)) return;
              await api(`/api/providers/${p.id}`, { method: 'DELETE' });
              onChange();
            }}
          >
            Remove
          </button>
        )}
      </div>
      {editing && (
        <form className="provider-form" onSubmit={save}>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder={PROVIDER_HELP[p.id]?.hint}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label={`${p.name} API key`}
          />
          <button className="btn btn-primary btn-small" disabled={key.trim().length < 8}>
            Save key
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
          {error && <p className="form-error">{error}</p>}
          <a className="small" href={PROVIDER_HELP[p.id]?.url} target="_blank" rel="noopener noreferrer">
            Get a {p.name} key
          </a>
        </form>
      )}
    </section>
  );
}

const eventLabel: Record<string, string> = {
  sign_in: 'Signed in with Google',
  '2fa_enabled': 'Turned on two-factor',
  '2fa_passed': 'Passed two-factor check',
  '2fa_failed': 'Wrong two-factor code',
  recovery_code_used: 'Used a recovery code',
};

function Account({ user }: { user: User }) {
  const [events, setEvents] = useState<{ kind: string; ip: string; user_agent: string; created_at: string }[]>([]);
  useEffect(() => {
    api<typeof events>('/api/account/events').then(setEvents);
  }, []);
  return (
    <div className="stack">
      <section className="kv">
        <span className="muted">Signed in as</span>
        <span>{user.email}</span>
        <span className="muted">Two-factor</span>
        <span>On</span>
      </section>

      <section>
        <h2>Recent sign-in activity</h2>
        <table className="events">
          <tbody>
            {events.map((e, i) => (
              <tr key={i} className={e.kind === '2fa_failed' ? 'warn' : ''}>
                <td>{eventLabel[e.kind] ?? e.kind}</td>
                <td className="muted">{e.ip}</td>
                <td className="muted">{new Date(e.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="actions">
        <button className="btn" onClick={() => api('/auth/logout', { method: 'POST' }).then(() => location.assign('/'))}>
          Sign out
        </button>
        <button
          className="btn"
          onClick={async () => {
            if (!confirm('Sign out on every device, including this one?')) return;
            await api('/api/account/sign-out-everywhere', { method: 'POST' });
            location.assign('/');
          }}
        >
          Sign out everywhere
        </button>
        <a className="btn" href="/api/account/export" download>
          Export my data
        </a>
      </section>

      <section className="danger-zone">
        <h2>Delete account</h2>
        <p className="muted">Deletes everything. This can’t be undone.</p>
        <button
          className="btn btn-danger"
          onClick={async () => {
            const typed = prompt(`Type your email (${user.email}) to delete your account.`);
            if (typed?.trim().toLowerCase() !== user.email.toLowerCase()) return;
            await api('/api/account', { method: 'DELETE' });
            location.assign('/');
          }}
        >
          Delete my account
        </button>
      </section>
    </div>
  );
}

type AdminUser = { id: string; email: string; name: string; role: string; created_at: string; disabled_at: string | null; has_2fa: boolean; chats: number; messages: number; last_seen: string | null };

function Admin() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const load = () => api<AdminUser[]>('/api/admin/users').then(setUsers);
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="stack">
      <table className="events admin">
        <thead>
          <tr>
            <th>Account</th>
            <th>Chats</th>
            <th>Messages</th>
            <th>Last seen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.disabled_at ? 'disabled' : ''}>
              <td>
                {u.email}
                {u.role === 'owner' && <span className="tag">owner</span>}
                {!u.has_2fa && <span className="tag">no 2FA yet</span>}
              </td>
              <td>{u.chats}</td>
              <td>{u.messages}</td>
              <td className="muted">{u.last_seen ? new Date(u.last_seen).toLocaleDateString() : ''}</td>
              <td>
                {u.role !== 'owner' && (
                  <button
                    className="btn btn-small"
                    onClick={async () => {
                      await api(`/api/admin/users/${u.id}/disabled`, { method: 'POST', body: { disabled: !u.disabled_at } });
                      load();
                    }}
                  >
                    {u.disabled_at ? 'Enable' : 'Disable'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
