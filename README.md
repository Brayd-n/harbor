# Harbor

A self-hosted AI chat app. Sign in with Google, add your own API keys, and chat with models from Anthropic, OpenAI, Google, OpenRouter and your OpenCode Go plan in one place. Your history is stored on your own server, so it's the same on every device.

This is the first milestone (web chat). Next comes a desktop app with an agent mode that works on files and a coding mode for project folders, with tools that run on your own machine. See the roadmap below.

"Harbor" is a working name.

## What it does

- **Bring your own keys.** Each user adds keys for the providers they use. Harbor never pays for anyone's usage and never shows a key again after it's saved.
- **Hundreds of models.** The model list comes from [models.dev](https://models.dev), the open catalog OpenCode uses, refreshed daily: Claude, GPT, Gemini, and everything on OpenRouter, with context sizes and prices.
- **OpenCode Go.** Use your Go subscription key. Each model is called through the API style OpenCode lists for it (OpenAI-compatible, Anthropic, OpenAI or Google), with a stable per-chat `x-opencode-session` ID and a Harbor user agent, as the [Go docs](https://opencode.ai/v2/docs/console/go/) ask. Keys are only ever sent to `opencode.ai/inference/go/`, even if the catalog says otherwise. Go's free models only work inside OpenCode, so they're hidden.
- **Prompt caching.** Each message resends the chat so far; Harbor turns on Anthropic's automatic caching (direct, through OpenRouter, and on Anthropic-style OpenCode Go models) so that part is billed at about a tenth of the input price. OpenAI, Google and most others cache on their own. Replies show how many input tokens were cached.
- **Streaming replies** with Markdown, code blocks, and the model's thinking when it shares it. Stop a reply at any point and keep what arrived.
- **Required two-factor sign-in** for every account, with recovery codes.
- **Export and delete.** Download all your chats as JSON, or delete your account and everything in it.
- **Owner admin page** to see accounts and disable one.

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
| Abuse | Per-route rate limits, at most two replies in progress per user, message size limits, and the owner can disable accounts. |
| Container escape / lateral movement | The app runs as a non-root user with a read-only filesystem, no Linux capabilities, `no-new-privileges`, and memory limits. Postgres has no published port. |

Sign-in uses the OpenID Connect authorization-code flow with PKCE, `state` and `nonce`, written directly against Node's standard library, as is TOTP (RFC 6238).

## Stack

| Part | Choice |
|---|---|
| Server | Node.js 26 + Fastify in TypeScript (Node runs the `.ts` files directly) |
| Database | PostgreSQL 17 with row-level security, plain SQL via `pg` |
| Models | [AI SDK](https://ai-sdk.dev) provider packages, catalog from models.dev |
| Frontend | React 19 + Vite, Geist and JetBrains Mono, no UI kit |
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

Tests need a Postgres they can wipe:

```bash
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=dev PGDATABASE=harbor npm test
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
       @compress not path /api/chats/*/messages
       encode @compress zstd gzip
       header Strict-Transport-Security "max-age=31536000"
   }
   ```
3. `DOMAIN=YOUR_DOMAIN OWNER_EMAIL=you@gmail.com ./deploy.sh`

`deploy.sh` creates the database password and the master key on first run. **Back up `/etc/harbor/app.env`**: without `MASTER_KEY`, stored API keys and 2FA secrets can't be decrypted (users would need to re-add keys and you'd have to reset 2FA by hand).

## Roadmap

- **M0 (this):** web chat, accounts, 2FA, bring-your-own-keys, row-level security.
- **M1:** Tauri desktop app for Windows and Linux. Device linking, OS detection (PowerShell 7 or bash), a Code mode that edits files and runs commands in a project folder with approval prompts and an audit log, live sync between devices over WebSocket, image attachments.
- **M2:** Cowork mode, WSL bash on Windows, more providers, cost tracking, custom modes and system prompts, MCP tools, theme and keybind editors.
- **M3:** passkeys, shell sandboxing, voice input, signed auto-updates.

## License

MIT
