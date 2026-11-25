# Harbor

Self-hosted AI chat with a coding agent. Users bring their own API keys for Anthropic, OpenAI, Google, OpenRouter or OpenCode Go, and chat history is stored on the server so it is shared across devices.

The desktop app for Windows and Linux adds Code mode, an agent that works in a local project folder. File writes and shell commands require approval on the device.

## Features

- Web chat with streaming, Markdown and model selection from the [models.dev](https://models.dev) catalog
- Google sign-in with required TOTP two-factor authentication
- Per-user provider keys, encrypted at rest
- Cost reduction: prompt caching, automatic compaction of long chats, a thinking budget and a short-answer mode, with a monthly spend and savings meter
- Image attachments, resized on the client before upload
- Desktop app (Tauri) with device linking, live sync between devices and Code mode
- Code mode tools: `read_file`, `edit_file`, `write_file`, `glob`, `grep`, `shell` (PowerShell 7 on Windows, bash on Linux)
- Account export and deletion, and an admin page for the instance owner

## Security

| Area | Approach |
|---|---|
| Tenant isolation | PostgreSQL row-level security on all user data, covered by cross-user tests |
| Secrets | Envelope encryption (AES-256-GCM) with a per-user data key wrapped by a server master key |
| Sessions | Hashed tokens, `__Host-` cookies, origin-checked writes, strict CSP |
| Desktop auth | Device-code linking; rotating refresh tokens stored in the OS keychain, with reuse detection |
| Tool execution | Enforced by the desktop app, not the server: a local policy file, workspace path checks after symlink resolution, a deny list, approval for every write and command, shell timeouts, and an audit log |
| Tool routing | Requests go only to the window that sent the message, on the user's own device |

## Stack

Node.js 26, Fastify, PostgreSQL 17, AI SDK, React 19 and Vite, Tauri 2 (Rust), Docker Compose behind Caddy.

## Development

```bash
docker run -d --name harbor-db -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=harbor -p 127.0.0.1:55432:5432 postgres:17-alpine
npm install
npm run build
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=dev PGDATABASE=harbor \
  MASTER_KEY=$(openssl rand -hex 32) PORT=3300 APP_ORIGIN=http://localhost:3300 npm start
```

Without a Google OAuth client, `node scripts/dev-session.ts you@example.com` prints a session token to set as the `__Host-session` cookie.

Tests (the database is wiped):

```bash
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=dev PGDATABASE=harbor npm test
cd apps/desktop/src-tauri && cargo test
```

### Desktop app

Requires Rust. On Linux, also install the WebKitGTK development packages:

```bash
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libgtk-3-dev librsvg2-dev
npm run desktop -- dev
```

Windows requires PowerShell 7 (`winget install Microsoft.PowerShell`).

Pushing a `v*` tag builds the Windows installer, AppImage and .deb and attaches them to a draft GitHub release. This requires the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. Builds are not code-signed yet.

## Deployment

1. Create a Google OAuth client with the redirect URI `https://YOUR_DOMAIN/auth/google/callback` and save its credentials on the server:
   ```bash
   sudo sh -c 'umask 077; printf "GOOGLE_CLIENT_ID=...\nGOOGLE_CLIENT_SECRET=...\n" > /etc/harbor/google.env'
   ```
2. Add a Caddy site block:
   ```
   YOUR_DOMAIN {
       reverse_proxy 127.0.0.1:8083 {
           flush_interval -1
       }
       @compress not path /api/chats/*/messages /ws
       encode @compress zstd gzip
       header Strict-Transport-Security "max-age=31536000"
   }
   ```
3. Run `DOMAIN=YOUR_DOMAIN OWNER_EMAIL=you@example.com ./deploy.sh`.

The first deploy generates the database password and master key in `/etc/harbor/app.env`. Back up this file. Stored API keys and 2FA secrets cannot be decrypted without it.

## Roadmap

- Cowork mode and WSL bash on Windows
- More providers, MCP tools, custom modes
- Passkeys, shell sandboxing, signed auto-updates

## License

MIT
