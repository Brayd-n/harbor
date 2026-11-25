import { useEffect, useState, type FormEvent } from 'react';
import { api, type User } from './api.ts';

const loginError: Record<string, string> = {
  failed: 'Google sign-in didn’t finish. Try again.',
  disabled: 'This account has been disabled.',
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-mark" aria-hidden>
        <Mark />
      </div>
      {children}
      <footer className="auth-foot">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="https://github.com/Brayd-n">Source</a>
      </footer>
    </main>
  );
}

export function Mark() {
  return (
    <svg viewBox="0 0 32 32" width="32" height="32">
      <circle cx="16" cy="16" r="15" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M16 6v20M9 19a7 7 0 0 0 14 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="16" cy="9" r="2.5" fill="var(--accent)" />
    </svg>
  );
}

export function SignIn() {
  const err = new URLSearchParams(location.search).get('login');
  return (
    <Frame>
      <h1 className="auth-title">Harbor</h1>
      {err && <p className="form-error">{loginError[err] ?? loginError.failed}</p>}
      <a className="btn btn-primary btn-wide" href="/auth/google">
        <GoogleIcon /> Continue with Google
      </a>
    </Frame>
  );
}

export function CodeForm({ label, submit, placeholder, autoFocus = true }: { label: string; submit: (code: string) => Promise<void>; placeholder: string; autoFocus?: boolean }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await submit(code);
    } catch (err) {
      setError((err as Error).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="code-form" onSubmit={onSubmit}>
      <label htmlFor="code">{label}</label>
      <input
        id="code"
        className="code-input"
        inputMode={placeholder.includes('-') ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        maxLength={20}
      />
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn-primary btn-wide" disabled={busy || code.trim().length < 6}>
        {busy ? 'Checking…' : 'Continue'}
      </button>
    </form>
  );
}

export function Verify({ user, onDone }: { user: User; onDone: () => void }) {
  const [recovery, setRecovery] = useState(false);
  return (
    <Frame>
      <h1 className="auth-h">Two-factor check</h1>
      <p className="auth-lede">Signed in with Google as {user.email}.</p>
      <CodeForm
        key={String(recovery)}
        label={recovery ? 'Recovery code' : 'Code from your authenticator app'}
        placeholder={recovery ? 'abcd-efgh' : '123 456'}
        submit={async (code) => {
          await api('/auth/2fa/verify', { method: 'POST', body: { code } });
          onDone();
        }}
      />
      <button className="link" onClick={() => setRecovery(!recovery)}>
        {recovery ? 'Use your authenticator app' : 'Use a recovery code'}
      </button>
      <SignOutLink />
    </Frame>
  );
}

function SignOutLink() {
  return (
    <button className="link muted" onClick={() => api('/auth/logout', { method: 'POST' }).then(() => location.assign('/'))}>
      Sign out
    </button>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
