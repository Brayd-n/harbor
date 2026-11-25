import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, relativeDay, sendMessage, type Chat, type ChatSummary, type Message, type Model, type User } from './api.ts';
import { Mark } from './Auth.tsx';
import { Settings } from './Settings.tsx';

const chatIdFromPath = () => location.pathname.match(/^\/c\/([0-9a-f-]{36})$/)?.[1] ?? null;
const storedModel = () => {
  try {
    return localStorage.getItem('model') ?? '';
  } catch {
    return '';
  }
};

export function Shell({ user }: { user: User }) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [models, setModels] = useState<Model[] | null>(null);
  const [chatId, setChatId] = useState<string | null>(chatIdFromPath());
  const [settings, setSettings] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  const loadChats = useCallback(() => api<ChatSummary[]>('/api/chats').then(setChats), []);
  const loadModels = useCallback(() => api<Model[]>('/api/models').then(setModels), []);
  useEffect(() => {
    loadChats();
    loadModels();
    const onPop = () => {
      setChatId(chatIdFromPath());
      setViewKey((k) => k + 1);
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [loadChats, loadModels]);

  // The chat view remounts only when you switch chats, not when a new chat gets its id mid-reply.
  const [viewKey, setViewKey] = useState(0);
  const open = (id: string | null) => {
    history.pushState(null, '', id ? `/c/${id}` : '/');
    setChatId(id);
    setViewKey((k) => k + 1);
    setNavOpen(false);
  };

  // Ctrl/Cmd+Shift+O starts a new chat.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        open(null);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const groups = useMemo(() => {
    const g = new Map<string, ChatSummary[]>();
    for (const c of chats) g.set(relativeDay(c.updated_at), [...(g.get(relativeDay(c.updated_at)) ?? []), c]);
    return [...g];
  }, [chats]);

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="nav">
        <div className="nav-top">
          <span className="brand">
            <Mark /> Harbor
          </span>
          <button className="btn btn-ghost new-chat" onClick={() => open(null)} title="New chat (Ctrl+Shift+O)">
            <PlusIcon /> New chat
          </button>
        </div>
        <nav className="chat-list" aria-label="Chats">
          {groups.map(([label, items]) => (
            <section key={label}>
              <h2>{label}</h2>
              {items.map((c) => (
                <a
                  key={c.id}
                  href={`/c/${c.id}`}
                  className={c.id === chatId ? 'active' : ''}
                  aria-current={c.id === chatId ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    open(c.id);
                  }}
                >
                  {c.title || 'New chat'}
                </a>
              ))}
            </section>
          ))}
        </nav>
        <button className="nav-user" onClick={() => setSettings('providers')}>
          <span className="avatar" aria-hidden>{(user.name || user.email)[0].toUpperCase()}</span>
          <span className="nav-user-text">
            <span>{user.name || user.email}</span>
            <span className="muted">Settings</span>
          </span>
        </button>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} />
      <ChatView
        key={viewKey}
        chatId={chatId}
        models={models}
        onMenu={() => setNavOpen(true)}
        onCreated={(id) => {
          history.replaceState(null, '', `/c/${id}`);
          setChatId(id);
        }}
        onChanged={loadChats}
        onDeleted={() => {
          loadChats();
          open(null);
        }}
        openSettings={() => setSettings('providers')}
      />
      {settings && (
        <Settings
          user={user}
          tab={settings}
          setTab={setSettings}
          onClose={() => {
            setSettings(null);
            loadModels();
          }}
        />
      )}
    </div>
  );
}

type Pending = { text: string; thinking: string } | null;

function ChatView(props: {
  chatId: string | null;
  models: Model[] | null;
  onMenu: () => void;
  onCreated: (id: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
  openSettings: () => void;
}) {
  const { chatId, models } = props;
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [model, setModel] = useState(storedModel);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // The id the in-flight reply belongs to; a new chat gets its id mid-send, after this view mounted.
  const liveId = useRef(chatId);

  useEffect(() => {
    if (!chatId) return;
    api<Chat>(`/api/chats/${chatId}`).then(
      (c) => {
        setChat(c);
        setMessages(c.messages);
        setModel(c.model);
      },
      (e) => setError(e.message),
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- remounted per chat via key

  // Pick a model the user can use if the remembered one isn't available.
  useEffect(() => {
    if (models?.length && !models.some((m) => m.id === model) && !chatId) setModel(models[0].id);
  }, [models]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, pending]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = async (text: string) => {
    setError('');
    const ctl = new AbortController();
    abortRef.current = ctl;
    stick.current = true;
    setPending({ text: '', thinking: '' });
    try {
      localStorage.setItem('model', model);
    } catch {}
    try {
      if (!liveId.current) {
        const created = await api<ChatSummary>('/api/chats', { method: 'POST', body: { model } });
        liveId.current = created.id;
        props.onCreated(created.id);
      }
      await sendMessage(liveId.current, text, model, ctl.signal, (e) => {
        if (e.t === 'user' || e.t === 'done') setMessages((m) => [...m, e.message]);
        if (e.t === 'done') setPending(null);
        if (e.t === 'text') setPending((p) => p && { ...p, text: p.text + e.d });
        if (e.t === 'thinking') setPending((p) => p && { ...p, thinking: p.thinking + e.d });
      });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      return text; // give the text back to the composer
    } finally {
      setPending(null);
      abortRef.current = null;
      props.onChanged();
      // A chat created by this send has a title now; show it in the header.
      if (!chat && liveId.current) api<Chat>(`/api/chats/${liveId.current}`).then(setChat, () => {});
    }
  };

  const stop = async () => {
    abortRef.current?.abort();
    // The server saves what arrived before Stop; reload to show it.
    if (liveId.current) setTimeout(() => api<Chat>(`/api/chats/${liveId.current}`).then((c) => setMessages(c.messages)), 400);
  };

  const current = models?.find((m) => m.id === model);
  const noKeys = models !== null && models.length === 0;

  return (
    <main className="main">
      <header className="top">
        <button className="btn btn-ghost icon menu" onClick={props.onMenu} aria-label="Open chats">
          <MenuIcon />
        </button>
        {chat ? <Title chat={chat} onChanged={props.onChanged} /> : <span className="top-title muted">New chat</span>}
        {chat && (
          <button
            className="btn btn-ghost icon"
            aria-label="Delete chat"
            title="Delete chat"
            onClick={async () => {
              if (!confirm(`Delete “${chat.title || 'New chat'}”? This can’t be undone.`)) return;
              await api(`/api/chats/${chat.id}`, { method: 'DELETE' });
              props.onDeleted();
            }}
          >
            <TrashIcon />
          </button>
        )}
      </header>

      <div
        className="scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="transcript">
          {!messages.length && !pending && (
            <div className="empty">
              {noKeys ? (
                <>
                  <h1>Add an API key to start</h1>
                  <button className="btn btn-primary" onClick={props.openSettings}>Add key</button>
                </>
              ) : (
                <h1>What are we working on?</h1>
              )}
            </div>
          )}
          {messages.map((m) => (
            <MessageView key={m.id} m={m} models={models} />
          ))}
          {pending && (
            <article className="msg assistant">
              {pending.thinking && <Thinking text={pending.thinking} live={!pending.text} />}
              {pending.text ? <Prose text={pending.text} /> : !pending.thinking && <span className="typing" aria-label="Waiting for reply" />}
            </article>
          )}
          {error && <p className="form-error">{error}</p>}
          <div ref={endRef} />
        </div>
      </div>

      <Composer
        disabled={noKeys || !current}
        busy={!!pending}
        onSend={send}
        onStop={stop}
        picker={<ModelPicker models={models ?? []} value={model} onChange={setModel} />}
      />
    </main>
  );
}

function Title({ chat, onChanged }: { chat: Chat; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const save = async () => {
    setEditing(false);
    if (title.trim() === chat.title) return;
    await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { title: title.trim() } });
    onChanged();
  };
  return editing ? (
    <input
      className="top-title-input"
      autoFocus
      value={title}
      maxLength={200}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') {
          setTitle(chat.title);
          setEditing(false);
        }
      }}
    />
  ) : (
    <button className="top-title" onClick={() => setEditing(true)} title="Rename">
      {title || 'New chat'}
    </button>
  );
}

function MessageView({ m, models }: { m: Message; models: Model[] | null }) {
  if (m.role === 'user') {
    return (
      <article className="msg user">
        <p>{m.content.map((b) => b.text).join('\n')}</p>
      </article>
    );
  }
  const name = models?.find((x) => x.id === m.model)?.name ?? m.model?.split(':').slice(1).join(':');
  const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
  return (
    <article className="msg assistant">
      {m.content.map((b, i) =>
        b.type === 'thinking' ? <Thinking key={i} text={b.text} /> : b.type === 'error' ? <p key={i} className="msg-error">{b.text}</p> : <Prose key={i} text={b.text} />,
      )}
      <footer className="msg-meta">
        <span>{name}</span>
        {m.usage?.output != null && <span>{m.usage.output.toLocaleString()} tokens</span>}
        {!!m.usage?.cacheRead && <span title="Input tokens billed at the cached rate">{m.usage.cacheRead.toLocaleString()} cached</span>}
        {text && <CopyButton text={text} />}
      </footer>
    </article>
  );
}

function Thinking({ text, live = false }: { text: string; live?: boolean }) {
  return (
    <details className="thinking" open={live}>
      <summary>{live ? 'Thinking…' : 'Thought process'}</summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

// Model output is untrusted: react-markdown renders no raw HTML and drops javascript: links.
// Images become links, so a reply can't load tracking pixels.
function Prose({ text }: { text: string }) {
  return (
    <div className="prose">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noopener noreferrer">
              {alt || 'image'}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const lang = (children as { props?: { className?: string } })?.props?.className?.replace('language-', '') ?? '';
  return (
    <div className="code">
      <div className="code-bar">
        <span>{lang}</span>
        <CopyButton getText={() => ref.current?.innerText ?? ''} />
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

function CopyButton({ text, getText }: { text?: string; getText?: () => string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      onClick={() => {
        navigator.clipboard.writeText(text ?? getText?.() ?? '');
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function Composer({ disabled, busy, onSend, onStop, picker }: { disabled: boolean; busy: boolean; onSend: (t: string) => Promise<string | void>; onStop: () => void; picker: React.ReactNode }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
    el.style.overflowY = el.scrollHeight > 320 ? 'auto' : 'hidden';
  }, [text]);
  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy || disabled) return;
    setText('');
    const back = await onSend(t);
    if (back) setText(back);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={disabled ? 'Add an API key to start' : 'Message'}
          disabled={disabled}
          aria-label="Message"
          maxLength={100_000}
        />
        <div className="composer-bar">
          {picker}
          {busy ? (
            <button className="send stop" onClick={onStop} aria-label="Stop">
              <span className="stop-square" />
            </button>
          ) : (
            <button className="send" onClick={submit} disabled={!text.trim() || disabled} aria-label="Send">
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const providerName: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', openrouter: 'OpenRouter', 'opencode-go': 'OpenCode Go' };

function ModelPicker({ models, value, onChange }: { models: Model[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.id === value);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return models.filter((m) => words.every((w) => `${m.name} ${m.id}`.toLowerCase().includes(w))).slice(0, 200);
  }, [models, q]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !boxRef.current?.contains(e.target as Node) && setOpen(false);
    addEventListener('mousedown', close);
    return () => removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => setHi(0), [q]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQ('');
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') setHi((h) => Math.min(h + 1, list.length - 1));
    else if (e.key === 'ArrowUp') setHi((h) => Math.max(h - 1, 0));
    else if (e.key === 'Enter' && list[hi]) pick(list[hi].id);
    else if (e.key === 'Escape') setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="picker" ref={boxRef}>
      <button className="model-chip" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="listbox" disabled={!models.length}>
        <span className={`dot p-${current?.provider ?? 'none'}`} aria-hidden />
        {current?.name ?? (models.length ? 'Choose a model' : 'No models')}
        <ChevronIcon />
      </button>
      {open && (
        <div className="picker-pop" onKeyDown={onKey}>
          <input autoFocus className="picker-search" placeholder={`Search ${models.length} models`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" />
          <ul role="listbox" aria-label="Models">
            {list.map((m, i) => (
              <li
                key={m.id}
                role="option"
                aria-selected={m.id === value}
                className={`${i === hi ? 'hi' : ''} ${m.id === value ? 'sel' : ''}`}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(m.id)}
              >
                <span className={`dot p-${m.provider}`} aria-hidden />
                <span className="picker-name">{m.name}</span>
                <span className="picker-meta">{providerName[m.provider]}</span>
                <span className="picker-price" title="$ per million tokens, in / out">{m.cost ? `$${m.cost.input} / $${m.cost.output}` : ''}</span>
              </li>
            ))}
            {!list.length && <li className="picker-none">No models match “{q}”</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const PlusIcon = () => <Icon d="M12 5v14M5 12h14" size={16} />;
const MenuIcon = () => <Icon d="M4 7h16M4 12h16M4 17h10" />;
const TrashIcon = () => <Icon d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" size={17} />;
const SendIcon = () => <Icon d="M12 19V5M5 12l7-7 7 7" />;
const ChevronIcon = () => <Icon d="m7 10 5 5 5-5" size={14} />;
