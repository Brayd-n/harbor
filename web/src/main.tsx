import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { api, type AuthState } from './api.ts';
import { Enroll, SignIn, Verify } from './Auth.tsx';
import { Shell } from './Shell.tsx';

function App() {
  const [state, setState] = useState<AuthState | null>(null);
  const load = () => api<AuthState>('/auth/state').then(setState, () => setState({ step: 'signed_out' }));
  useEffect(() => {
    load();
  }, []);

  if (!state) return null;
  if (state.step === 'signed_out') return <SignIn />;
  if (state.step === 'enroll') return <Enroll user={state.user} onDone={load} />;
  if (state.step === 'verify') return <Verify user={state.user} onDone={load} />;
  return <Shell user={state.user} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
