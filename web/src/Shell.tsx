import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, relativeDay, sendMessage, uploadImage, usd, type Block, type Chat, type ChatSummary, type Message, type Model, type Project, type StreamEvent, type User } from './api.ts';
import { Mark } from './Auth.tsx';
import { Approvals, AuditPanel, BlobImage, DeviceBadge, ProjectPicker, ToolRow } from './Code.tsx';
import { isDesktop, pickFolder } from './desktop.ts';
import { connect, dropApprovals, onChatEvent } from './live.ts';
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
  const [mode, setMode] = useState<'chat' | 'code'>(isDesktop ? 'code' : 'chat');

  const loadChats = useCallback(() => api<ChatSummary[]>('/api/chats').then(setChats), []);
  const loadModels = useCallback(() => api<Model[]>('/api/models').then(setModels), []);
  useEffect(() => {
    loadChats();
    loadModels();
    connect();
    // Another window started or finished a turn: the chat list order and titles change.
    const off = onChatEvent((e) => (e.e.t === 'user' || e.e.t === 'done') && loadChats());
    const onPop = () => {
      setChatId(chatIdFromPath());
      setViewKey((k) => k + 1);
    };
    addEventListener('popstate', onPop);
    return () => {
      off();
      removeEventListener('popstate', onPop);
    };
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

  // A chat you open switches the sidebar to its mode.
  const openChat = chats.find((c) => c.id === chatId);
  useEffect(() => {
    if (openChat) setMode(openChat.mode);
  }, [openChat?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const g = new Map<string, ChatSummary[]>();
    for (const c of chats.filter((c) => c.mode === mode)) g.set(relativeDay(c.updated_at), [...(g.get(relativeDay(c.updated_at)) ?? []), c]);
    return [...g];
  }, [chats, mode]);
  const hasCode = isDesktop || chats.some((c) => c.mode === 'code');

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="nav">
        <div className="nav-top">
          <span className="brand">
            <Mark /> Harbor
          </span>
          {hasCode && (
            <div className="modes" role="tablist" aria-label="Mode">
              {(['chat', 'code'] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  className={mode === m ? 'on' : ''}
                  onClick={() => {
                    setMode(m);
                    if (openChat && openChat.mode !== m) open(null);
                  }}
                >
                  {m === 'chat' ? 'Chat' : 'Code'}
                </button>
              ))}
            </div>
          )}
          <button className="btn btn-ghost new-chat" onClick={() => open(null)} title="New chat (Ctrl+Shift+O)">
            <PlusIcon /> {mode === 'code' ? 'New session' : 'New chat'}
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
        mode={mode}
        device={user.device ?? null}
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

// The reply being streamed: the same blocks a saved message has, in arrival order.
type Pending = { blocks: Block[]; compacting?: boolean } | null;

function addEvent(p: Pending, e: StreamEvent): Pending {
  if (!p) p = { blocks: [] };
  const blocks = [...p.blocks];
  const last = blocks[blocks.length - 1];
  if (e.t === 'compacting') return { ...p, compacting: true };
  if (e.t === 'text' || e.t === 'thinking') {
    const type = e.t;
    if (last && last.type === type) blocks[blocks.length - 1] = { type, text: last.text + e.d };
    else blocks.push({ type, text: e.d });
    return { blocks, compacting: false };
  }
  if (e.t === 'tool_call') blocks.push({ type: 'tool_call', id: e.id, name: e.name, input: e.input });
  if (e.t === 'tool_result') blocks.push({ type: 'tool_result', callId: e.callId, output: e.output, isError: e.isError, decision: e.decision });
  return { ...p, blocks };
}

function ChatView(props: {
  chatId: string | null;
  mode: 'chat' | 'code';
  device: User['device'];
  models: Model[] | null;
  onMenu: () => void;
  onCreated: (id: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
  openSettings: () => void;
}) {
  const { chatId, models, device } = props;
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [model, setModel] = useState(storedModel);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState('');
  const [project, setProject] = useState<Project | null>(null);
  const [audit, setAudit] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // The id the in-flight reply belongs to; a new chat gets its id mid-send, after this view mounted.
  const liveId = useRef(chatId);
  const sending = useRef(false);

  const reload = () => liveId.current && api<Chat>(`/api/chats/${liveId.current}`).then((c) => {
    setChat(c);
    setMessages(c.messages);
  });
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

  // Live sync: a turn running in another window shows up here as it streams.
  useEffect(
    () =>
      onChatEvent(({ chatId: id, e }) => {
        if (id !== liveId.current || sending.current) return;
        const ev = e as StreamEvent;
        if (ev.t === 'user') {
          setMessages((m) => [...m, ev.message]);
          setPending({ blocks: [] });
        } else if (ev.t === 'done') {
          setMessages((m) => [...m, ev.message]);
          setPending(null);
        } else setPending((p) => addEvent(p, ev));
      }),
    [],
  );

  // Pick a model the user can use if the remembered one isn't available.
  useEffect(() => {
    if (models?.length && !models.some((m) => m.id === model) && !chatId) setModel(models[0].id);
  }, [models]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, pending]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const isCode = chat ? chat.mode === 'code' : props.mode === 'code';

  const send = async (text: string, images: string[]) => {
    setError('');
    const ctl = new AbortController();
    abortRef.current = ctl;
    stick.current = true;
    sending.current = true;
    setPending({ blocks: [] });
    try {
      localStorage.setItem('model', model);
    } catch {}
    try {
      if (!liveId.current) {
        const created = await api<ChatSummary>('/api/chats', { method: 'POST', body: { model, ...(isCode && project && { project_id: project.id }) } });
        liveId.current = created.id;
        props.onCreated(created.id);
      }
      await sendMessage(liveId.current, text, model, images, ctl.signal, (e) => {
        if (e.t === 'user' || e.t === 'done') setMessages((m) => [...m, e.message]);
        if (e.t === 'done') setPending(null);
        else if (e.t !== 'user') setPending((p) => addEvent(p, e));
      });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      return text; // give the text back to the composer
    } finally {
      sending.current = false;
      setPending(null);
      abortRef.current = null;
      props.onChanged();
      // A chat created by this send has a title now; show it in the header.
      if (liveId.current) api<Chat>(`/api/chats/${liveId.current}`).then(setChat, () => {});
    }
  };

  const stop = async () => {
    abortRef.current?.abort();
    if (liveId.current) dropApprovals(liveId.current);
    // The server saves what arrived before Stop; reload to show it.
    if (liveId.current) setTimeout(reload, 400);
  };

  const chooseFolder = async () => {
    const path = await pickFolder();
    if (!path || !chat?.project_id) return;
    await api(`/api/projects/${chat.project_id}/path`, { method: 'PUT', body: { path } });
    reload();
  };

  const current = models?.find((m) => m.id === model);
  const summaryUntil = chat?.summary_until ?? null;
  const noKeys = models !== null && models.length === 0;
  const path = chat ? chat.path : project?.path;
  const blocked = isCode && (!isDesktop || (chat ? !chat.path : !project?.path));

  return (
    <main className={`main ${audit ? 'with-audit' : ''}`}>
      <header className="top">
        <button className="btn btn-ghost icon menu" onClick={props.onMenu} aria-label="Open chats">
          <MenuIcon />
        </button>
        {chat ? <Title chat={chat} onChanged={props.onChanged} /> : <span className="top-title muted">{isCode ? 'New session' : 'New chat'}</span>}
        {device && <DeviceBadge device={device} path={isCode ? path : null} />}
        {chat && isCode && (
          <button className={`btn btn-ghost btn-small ${audit ? 'on' : ''}`} onClick={() => setAudit(!audit)} aria-pressed={audit}>
            Audit
          </button>
        )}
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

      <div className="body">
        <div className="col">
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
                  ) : isCode && !chat ? (
                    <>
                      <h1>Project</h1>
                      <ProjectPicker value={project} onChange={setProject} />
                    </>
                  ) : (
                    <h1>What are we working on?</h1>
                  )}
                </div>
              )}
              {chat && isCode && isDesktop && !chat.path && (
                <div className="banner">
                  <span>{chat.project} has no folder on this device.</span>
                  <button className="btn btn-small btn-primary" onClick={chooseFolder}>Choose folder</button>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={m.id} className="msg-wrap">
                  {summaryUntil && i > 0 && m.created_at > summaryUntil && messages[i - 1].created_at <= summaryUntil && (
                    <div className="summarized">Earlier messages summarized</div>
                  )}
                  <MessageView m={m} models={models} />
                </div>
              ))}
              {pending && (
                <article className="msg assistant">
                  {pending.compacting && <div className="summarized">Summarizing earlier messages…</div>}
                  <Blocks blocks={pending.blocks} live />
                  {!pending.blocks.length && <span className="typing" aria-label="Waiting for reply" />}
                </article>
              )}
              {error && <p className="form-error">{error}</p>}
              <div ref={endRef} />
            </div>
          </div>

          <Approvals />
          <Composer
            disabled={noKeys || !current || blocked}
            placeholder={isCode && !isDesktop ? 'Code sessions run in the desktop app' : blocked ? 'Choose a project folder' : noKeys ? 'Add an API key to start' : 'Message'}
            vision={!!current?.vision}
            busy={!!pending}
            onSend={send}
            onStop={stop}
            picker={<ModelPicker models={models ?? []} value={model} onChange={setModel} />}
          />
        </div>
        {audit && chat && <AuditPanel chatId={chat.id} onClose={() => setAudit(false)} />}
      </div>
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
        {m.content.map((b, i) =>
          b.type === 'note' ? (
            <div key={i} className="summarized">{b.text}</div>
          ) : b.type === 'image' ? (
            <BlobImage key={i} id={b.blobId} />
          ) : b.type === 'text' ? (
            <p key={i}>{b.text}</p>
          ) : null,
        )}
      </article>
    );
  }
  const name = models?.find((x) => x.id === m.model)?.name ?? m.model?.split(':').slice(1).join(':');
  const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');
  return (
    <article className="msg assistant">
      <Blocks blocks={m.content} />
      <footer className="msg-meta">
        <span>{name}</span>
        {m.usage?.output != null && <span>{m.usage.output.toLocaleString()} tokens</span>}
        {!!m.usage?.cacheRead && <span title="Input tokens billed at the cached rate">{m.usage.cacheRead.toLocaleString()} cached</span>}
        {m.usage?.cost != null && m.usage.cost > 0 && <span>{usd(m.usage.cost)}</span>}
        {!!m.usage?.saved && m.usage.saved > 0 && <span className="saved">saved {usd(m.usage.saved)}</span>}
        {text && <CopyButton text={text} />}
      </footer>
    </article>
  );
}

// Assistant blocks in order. A tool call and its result render as one row.
function Blocks({ blocks, live = false }: { blocks: Block[]; live?: boolean }) {
  const results = new Map(blocks.flatMap((b) => (b.type === 'tool_result' ? [[b.callId, b] as const] : [])));
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'thinking') return <Thinking key={i} text={b.text} live={live && i === blocks.length - 1} />;
        if (b.type === 'error') return <p key={i} className="msg-error">{b.text}</p>;
        if (b.type === 'text') return <Prose key={i} text={b.text} />;
        if (b.type === 'tool_call') return <ToolRow key={b.id} name={b.name} input={b.input} result={results.get(b.id)} />;
        return null;
      })}
    </>
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

function Composer(props: {
  disabled: boolean;
  placeholder: string;
  vision: boolean;
  busy: boolean;
  onSend: (t: string, images: string[]) => Promise<string | void>;
  onStop: () => void;
  picker: React.ReactNode;
}) {
  const { disabled, busy } = props;
  const [text, setText] = useState('');
  const [images, setImages] = useState<{ id: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
    el.style.overflowY = el.scrollHeight > 320 ? 'auto' : 'hidden';
  }, [text]);
  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  const attach = async (files: Iterable<File>) => {
    setError('');
    for (const f of [...files].filter((f) => f.type.startsWith('image/')).slice(0, 4 - images.length)) {
      setUploading((n) => n + 1);
      try {
        const { id } = await uploadImage(f);
        setImages((xs) => (xs.some((x) => x.id === id) ? xs : [...xs, { id, url: URL.createObjectURL(f) }]));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const submit = async () => {
    const t = text.trim();
    if (!t || busy || disabled || uploading) return;
    const sent = images;
    setText('');
    setImages([]);
    const back = await props.onSend(t, sent.map((i) => i.id));
    if (back) {
      setText(back);
      setImages(sent);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="composer-wrap">
      <div className="composer" onDragOver={(e) => props.vision && e.preventDefault()} onDrop={(e) => {
        if (!props.vision) return;
        e.preventDefault();
        attach(e.dataTransfer.files);
      }}>
        {!!images.length && (
          <div className="attachments">
            {images.map((im) => (
              <span key={im.id} className="thumb">
                <img src={im.url} alt="" />
                <button aria-label="Remove image" onClick={() => setImages((xs) => xs.filter((x) => x !== im))}>✕</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => {
            if (props.vision && e.clipboardData.files.length) {
              e.preventDefault();
              attach(e.clipboardData.files);
            }
          }}
          placeholder={props.placeholder}
          disabled={disabled}
          aria-label="Message"
          maxLength={100_000}
        />
        {error && <p className="form-error small">{error}</p>}
        <div className="composer-bar">
          <div className="row">
            {props.picker}
            {props.vision && (
              <>
                <button className="btn btn-ghost icon attach" onClick={() => fileRef.current?.click()} disabled={disabled || images.length >= 4} aria-label="Attach image" title="Attach image">
                  <ClipIcon />
                </button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => {
                  attach(e.target.files ?? []);
                  e.target.value = '';
                }} />
              </>
            )}
          </div>
          {busy ? (
            <button className="send stop" onClick={props.onStop} aria-label="Stop">
              <span className="stop-square" />
            </button>
          ) : (
            <button className="send" onClick={submit} disabled={!text.trim() || disabled || !!uploading} aria-label="Send">
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
const ClipIcon = () => <Icon d="M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15.5 7.6" size={17} />;
