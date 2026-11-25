# Harbor

A self-hosted AI chat app with a coding agent. Sign in with Google, add your own API keys, and chat with models from Anthropic, OpenAI, Google, OpenRouter and your OpenCode Go plan in one place. Your history is stored on your own server, so it's the same on every device.

The desktop app (Windows and Linux) adds **Code mode**: an agent that reads, edits and runs commands in a project folder on the machine you're sitting at, with your approval for every write and command. Start a session on one computer and continue it on another.

"Harbor" is a working name.

## What it does

- **Bring your own keys.** Each user adds keys for the providers they use. Harbor never pays for anyone's usage and never shows a key again after it's saved.
- **Hundreds of models.** The model list comes from [models.dev](https://models.dev), the open catalog OpenCode uses, refreshed daily: Claude, GPT, Gemini, and everything on OpenRouter, with context sizes and prices.
- **OpenCode Go.** Use your Go subscription key. Each model is called through the API style OpenCode lists for it (OpenAI-compatible, Anthropic, OpenAI or Google), with a stable per-chat `x-opencode-session` ID and a Harbor user agent, as the [Go docs](https://opencode.ai/v2/docs/console/go/) ask. Keys are only ever sent to `opencode.ai/inference/go/`, even if the catalog says otherwise. Go's free models only work inside OpenCode, so they're hidden.
- **Saving toggles** (Settings → Saving), with a meter for what you spent and saved this month:
  - **Compact long chats** (on by default). Past ~24k tokens of history (or 40% of the model's context), older turns are folded into a summary by the cheapest model on the same key; the newest 6 messages are always sent word for word. The chat shows where the summary starts.
  - **Short answers.** Asks for replies without preamble, restating or closing filler. Code and exact details stay complete.
  - **Extended thinking** (off by default). Thinking is billed as output, so by default each reasoning model gets the lowest thinking level it accepts (models.dev lists them per model); turning this on asks for `high`.
  - Each reply records its cost and what caching and compaction saved. Savings are counted conservatively: history not resent is priced at the cached rate, and the summary call's cost is subtracted.
- **Prompt caching.** Each message resends the chat so far; Harbor turns on Anthropic's automatic caching (direct, through OpenRouter, and on Anthropic-style OpenCode Go models) so that part is billed at about a tenth of the input price. OpenAI, Google and most others cache on their own. Replies show how many input tokens were cached.
- **Streaming replies** with Markdown, code blocks, and the model's thinking when it shares it. Stop a reply at any point and keep what arrived.
- **Required two-factor sign-in** for every account, with recovery codes.
- **Export and delete.** Download all your chats as JSON, or delete your account and everything in it.
- **Owner admin page** to see accounts and disable one.
- **Image attachments**, shrunk in the app before upload (longest side 1568 px, WebP), since image tokens scale with pixels. Images go to the model only with the newest messages.

## Desktop app and Code mode

The desktop app is [Tauri 2](https://tauri.app): the same React UI as the web app (bundled into the app, not loaded from the server) plus a Rust side that runs the tools.

- **Linking.** The app shows a code and opens `/link` in your browser, where you're already signed in with 2FA; you approve the device there. The app gets a refresh token bound to that device, kept in the OS keychain (Secret Service on Linux, Credential Manager on Windows). No password is ever typed into the app. Access tokens last 15 minutes; refresh tokens rotate on every use, and presenting an old one revokes the device. Devices are listed and revocable in Settings → Devices; revoking one closes its connections at once.
- **Where commands run.** The app reports its OS, version, architecture, hostname, home folder and shell (PowerShell 7 `pwsh` on Windows, bash on Linux) when it links and every time it connects. The server puts an environment block for the device you're typing on into the system prompt, so the model writes commands for the right shell, and adds a note to the chat when you continue it on another machine. The top bar always shows the device, shell and folder.
- **Live sync.** A WebSocket hub streams every reply to all your open windows: start a turn on one machine and watch it on another.
- **Tools:** `read_file` (by line range), `edit_file` (exact string replace), `write_file`, `glob`, `grep` (both respect `.gitignore`), and `shell`. A project has a folder per device.
- **Token saving in Code mode.** Compaction, prompt caching and the savings meter work as in chat (every step of a tool loop is priced, and cache savings add up across steps). Shell output is cut to its first and last 15 KB. Tool use from earlier turns is replayed to the model as one line per call instead of the full output, since old file contents and logs are stale and are most of a coding chat's tokens.

### Tool safety

The agent loop runs on the server, so the server can *ask* your computer to run things. The design treats the server as untrusted for that purpose: **the desktop app is the enforcement point.**

| Rule | Where it's enforced |
|---|---|
| Tool requests go only to the window that sent your message, on the device that owns it, for a chat its user owns. A result from any other connection is ignored. | Server (hub), tested |
| The folder must be one you opened on that device with the native folder picker. The server names a folder; the app refuses any it didn't pick. | App (Rust) |
| Reads inside the folder run without asking. Every write and every command shows an approval card with the exact command or change, the folder and the shell. Nothing paraphrased by the model. | App |
| Paths are canonicalized (symlinks and junctions resolved) and must stay inside the folder. Never a string prefix check. | App, tested |
| Hard deny list: `.ssh`, `.gnupg`, cloud credentials, keyrings, browser profiles and Harbor's own policy file; commands like `rm -rf /`, `mkfs`, `Format-Volume`, registry edits, `curl … \| sh`. Approving can't override it. | App, tested |
| The permission policy is a local file (`~/.config/harbor/policy.json`, `%APPDATA%\harbor\policy.json`). The server has no way to change it. | App |
| Shell commands time out (2 min by default), kill their whole process tree, and keep only the head and tail of their output. | App, tested |
| Every request and its decision (auto, approved, declined, blocked) lands in an audit log, shown per chat. | Server |
| Tool output goes back to the model as data, and the system prompt says it is never an instruction. | Server |

The deny list for commands is a speed bump, not the boundary: a shell can always be talked into something a pattern misses. The boundary is that every command waits for your click. Known gaps, for later milestones: no sandbox around approved commands, and no checkpoint/undo for edits.

## Security

Anyone can sign up, so the design assumes some users are hostile.

| Threat | What stops it |
|---|---|
| One user reading another's chats or keys | Every query filters by user, and PostgreSQL **row-level security** enforces it again underneath: user-data queries run as a restricted role with the user id set per transaction, so a missing `WHERE` returns nothing. Tests sign in as one user and try to read, edit, delete and write into another's data, including with raw SQL. |
| Database or backup leak exposing API keys | **Envelope encryption.** Each user has a random data key, stored encrypted by a master key that lives only in a root-only file on the server. Provider keys and TOTP secrets are encrypted (AES-256-GCM) with the user's data key, bound to the user id and provider, so a ciphertext copied into another row won't decrypt. |
| Stolen Google session | **TOTP is required** after Google sign-in. A session can't reach the API until it passes 2FA; passing it replaces the session token. Codes can't be replayed (the used time step is stored atomically). 10 wrong codes in 15 minutes locks 2FA attempts. Recovery codes are stored as hashes and work once. |
| Session theft from the database | Only SHA-256 hashes of session tokens are stored. Cookies are `__Host-`, HttpOnly, Secure, SameSite=Lax. |
| CSRF | Every non-GET request must carry our own `Origin`. |
| A model reply running script in your browser | Replies are rendered with `react-markdown`: no raw HTML, no `javascript:` links, images shown as links. The CSP allows scripts only from our own origin, with no inline script. |
| Abuse | Per-route rate limits, at most two replies in progress per user, message size limits, a 200 MB image quota, and the owner can disable accounts. |
| One user reaching another's devices | Devices, projects, folders, images and the audit log are under the same row-level security; folder rows must point at a device of the same user (composite foreign key). Tests try to list, revoke, re-path and route through another user's devices. |
| A stolen desktop token | Refresh tokens are stored hashed, rotate on use, and reuse revokes the device. The desktop API uses bearer tokens only (no cookies), with CORS open to the app's own origin and nothing else. |
| Cross-site WebSocket hijacking | Browser sockets must come from our own origin; the desktop app authenticates its socket with a token in the first message, never in the URL. |
| A spoofed image | The type comes from the file's magic bytes, not its name or header. |
| Container escape / lateral movement | The app runs as a non-root user with a read-only filesystem, no Linux capabilities, `no-new-privileges`, and memory limits. Postgres has no published port. |

Sign-in uses the OpenID Connect authorization-code flow with PKCE, `state` and `nonce`, written directly against Node's standard library, as is TOTP (RFC 6238).

## Stack

| Part | Choice |
|---|---|
| Server | Node.js 26 + Fastify in TypeScript (Node runs the `.ts` files directly) |
| Database | PostgreSQL 17 with row-level security, plain SQL via `pg` |
| Models | [AI SDK](https://ai-sdk.dev) provider packages, catalog from models.dev |
| Frontend | React 19 + Vite, Geist and JetBrains Mono, no UI kit |
| Desktop | Tauri 2 (Rust): `keyring`, `ignore`/`globset`/`regex` for the file tools, std::process for the shell |
| Hosting | Docker Compose behind Caddy on a small VPS. The app container idles at about 85 MB. |

## Run it locally

```bash
docker run -d --name harbor-db -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=harbor -p 127.0.0.1:55432:5432 postgres:17-alpine
npm install
npm run build
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=dev PGDATABASE=harbor \
  MASTER_KEY=$(openssl rand -hex 32) PORT=3300 APP_ORIGIN=http://localhost:3300 npm start
```

Google sign-in needs an OAuth client (below). For local testing without one, `node scripts/dev-session.ts you@example.com` prints a session token you can set as the `__Host-session` cookie on `http://localhost:3300`.

### Desktop app

Needs Rust and, on Linux, the WebKitGTK build libraries:

```bash
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libgtk-3-dev librsvg2-dev
npm run desktop -- build --bundles deb   # or: npm run desktop -- dev
```

On first start, set the server (for local testing `http://localhost:3300`), then approve the code in the browser. Windows needs PowerShell 7 (`winget install Microsoft.PowerShell`).

Releases: pushing a `v*` tag builds the Windows installer, AppImage and .deb in GitHub Actions and attaches them to a draft release with Tauri updater signatures. It needs the repository secrets `TAURI_SIGNING_PRIVATE_KEY` (from `npx tauri signer generate`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the public key is in `apps/desktop/src-tauri/tauri.conf.json`. The builds aren't code-signed yet, so Windows shows a SmartScreen prompt on first install.

Tests need a Postgres they can wipe:

```bash
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=dev PGDATABASE=harbor npm test
cd apps/desktop/src-tauri && cargo test   # tool and policy tests
```

## Deploy

1. In Google Cloud, create an OAuth client (Web application) with the redirect URI `https://YOUR_DOMAIN/auth/google/callback`. Put the ID and secret on the server:
   ```bash
   sudo sh -c 'umask 077; printf "GOOGLE_CLIENT_ID=...\nGOOGLE_CLIENT_SECRET=...\n" > /etc/harbor/google.env'
   ```
2. Add a Caddy site block and reload Caddy:
   ```
   YOUR_DOMAIN {
       # Replies stream as server-sent events: flush each chunk right away and don't compress them.
       reverse_proxy 127.0.0.1:8083 {
           flush_interval -1
       }
       @compress not path /api/chats/*/messages /ws
       encode @compress zstd gzip
       header Strict-Transport-Security "max-age=31536000"
   }
   ```
3. `DOMAIN=YOUR_DOMAIN OWNER_EMAIL=you@gmail.com ./deploy.sh`

`deploy.sh` creates the database password and the master key on first run. **Back up `/etc/harbor/app.env`**: without `MASTER_KEY`, stored API keys and 2FA secrets can't be decrypted (users would need to re-add keys and you'd have to reset 2FA by hand).

## Roadmap

- **M0:** web chat, accounts, 2FA, bring-your-own-keys, row-level security.
- **M1 (this):** Tauri desktop app for Windows and Linux. Device linking, OS detection (PowerShell 7 or bash), a Code mode that edits files and runs commands in a project folder with approval prompts and an audit log, live sync between devices over WebSocket, image attachments.
- **M2:** Cowork mode, WSL bash on Windows, more providers, cost tracking, custom modes and system prompts, MCP tools, theme and keybind editors.
- **M3:** passkeys, shell sandboxing, voice input, signed auto-updates.

## License

MIT
