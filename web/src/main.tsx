import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { api, type AuthState, type User } from './api.ts';
import { Enroll, SignIn, Verify } from './Auth.tsx';
import { hasLink, isDesktop } from './desktop.ts';
import { ApproveLink, LinkDevice } from './Link.tsx';
import { Shell } from './Shell.tsx';

// A /link?code=… visit survives the Google sign-in round trip.
const LINK_KEY = 'pending-link';
if (location.pathname === '/link') {
  try {
    sessionStorage.setItem(LINK_KEY, location.search);
  } catch {}
}

function WebApp() {
  const [state, setState] = useState<AuthState | null>(null);
  const [linking, setLinking] = useState(() => {
    try {
      return sessionStorage.getItem(LINK_KEY);
    } catch {
      return null;
    }
  });
  const load = () => api<AuthState>('/auth/state').then(setState, () => setState({ step: 'signed_out' }));
  useEffect(() => {
    load();
  }, []);

  if (!state) return null;
  if (state.step === 'signed_out') return <SignIn />;
  if (state.step === 'enroll') return <Enroll user={state.user} onDone={load} />;
  if (state.step === 'verify') return <Verify user={state.user} onDone={load} />;
  if (linking !== null) {
    if (location.pathname !== '/link') history.replaceState(null, '', `/link${linking}`);
    return (
      <ApproveLink
        onDone={() => {
          sessionStorage.removeItem(LINK_KEY);
          history.replaceState(null, '', '/');
          setLinking(null);
        }}
      />
    );
  }
  return <Shell user={state.user} />;
}

function DesktopApp() {
  const [user, setUser] = useState<User | 'link' | null>(null);
  const load = async () => setUser((await hasLink()) ? await api<User>('/api/me').catch(() => 'link' as const) : 'link');
  useEffect(() => {
    load();
  }, []);
  if (!user) return null;
  if (user === 'link') return <LinkDevice onLinked={load} />;
  return <Shell user={user} />;
}

const App = isDesktop ? DesktopApp : WebApp;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
