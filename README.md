# Stoatcord Bot

Bidirectional Discord ↔ Stoat (Revolt) bridge and server migration bot. Built with [Bun](https://bun.sh) + TypeScript.

## Features

- **Message Bridge** — Real-time bidirectional message relay between linked Discord and Stoat channels. Discord messages appear in Stoat via masquerade; Stoat messages appear in Discord via webhooks. Echo prevention, attachment forwarding, and markdown conversion included.

- **Server Migration Wizard** — Interactive Discord slash command (`/migrate`) that replicates a Discord server's structure into Stoat: channels, categories, roles with permissions, emoji, server icon/banner. Supports dry-run preview, mid-flight cancellation, and three authorization paths (new server, claim code, live admin approval).

- **Push Notification Relay** — Forwards Stoat chat notifications to Android devices via Firebase Cloud Messaging (FCM HTTP v1) and to UnifiedPush/WebPush endpoints via VAPID-signed payloads. Mention detection, DM/group notification, and automatic device cleanup on token expiry.

- **HTTP API** — RESTful endpoints for bridge link management, push device registration, server diagnostics, and VAPID key distribution. Powers the [Stoatally](https://github.com/tribixbite/stoatally) Android client integration.

## Architecture

```
Discord ──webhook──┐                    ┌──masquerade── Stoat
                    │                    │
Discord.js v14 ────┤   stoatcord-bot    ├──── Stoat REST API
                    │   (Bun + SQLite)   │
Slash commands ────┤                    ├──── Stoat WebSocket
                    │                    │
HTTP API (3210) ───┘                    └──── FCM / WebPush
```

```
src/
  index.ts            Entry point, HTTP server, main orchestration
  config.ts           Environment config validation
  env.ts              Manual .env loader (Termux/grun compatibility)
  util.ts             Shared utilities
  stoat/
    client.ts         Stoat REST API client (users, channels, roles, emoji, messages)
    websocket.ts      Stoat WebSocket connection (Bonfire protocol)
    commands.ts       Stoat-side command handler (prefix commands, approval replies)
    types.ts          TypeScript interfaces for Stoat API schema
  discord/
    client.ts         Discord.js client setup
    commands.ts       Slash command registration (/migrate, /link, /unlink, /status)
    events.ts         Message relay + interaction handling
  bridge/
    relay.ts          Bidirectional message relay (echo prevention, user cache)
    format.ts         Markdown conversion (Discord ↔ Revolt syntax)
    webhooks.ts       Discord webhook creation and management
  migration/
    wizard.ts         Interactive /migrate wizard (auth, preview, 3-button UI)
    progress.ts       Dedup-aware executor (create/update/skip, abort, dry-run)
    channels.ts       Discord → Stoat channel mapping (topic, NSFW, permissions)
    roles.ts          Discord → Stoat role mapping (permissions, hoist, colour)
    snapshot.ts       Full server data snapshot (members, bans, pins, emoji)
    approval.ts       In-memory promise manager for live admin approvals
  db/
    schema.ts         SQLite table definitions and type interfaces
    store.ts          Database abstraction (queries, migrations, WAL mode)
  api/
    server.ts         HTTP endpoints: /api/guilds, /api/diag
    links.ts          HTTP endpoints: /api/links (CRUD bridge management)
  push/
    relay.ts          Notification router (Stoat WS → FCM/WebPush)
    fcm.ts            Firebase Cloud Messaging sender (HTTP v1 + JWT OAuth2)
    webpush.ts        WebPush/UnifiedPush sender (RFC 8291 + VAPID)
    store.ts          Push device registration persistence
```

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- A Discord bot token ([create one](https://discord.com/developers/applications))
- A Stoat/Revolt bot token (from server settings)
- Firebase service account JSON (for push notifications, optional)

## Setup

```bash
git clone https://github.com/tribixbite/stoatcord-bot.git
cd stoatcord-bot
cp .env.example .env
# Edit .env with your tokens
bun install
bun run start
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | — | Discord bot token |
| `STOAT_TOKEN` | Yes | — | Stoat/Revolt bot token |
| `STOAT_API_BASE` | No | `https://api.stoat.chat/0.8` | Stoat REST API base URL |
| `STOAT_WS_URL` | No | `wss://events.stoat.chat` | Stoat WebSocket URL |
| `STOAT_CDN_URL` | No | `https://cdn.stoatusercontent.com` | CDN for avatars and files |
| `STOAT_AUTUMN_URL` | No | `https://autumn.stoat.chat` | File upload service URL |
| `API_PORT` | No | `3210` | HTTP API server port |
| `PORT` | No | — | Railway/container port override |
| `API_KEY` | No | — | Shared secret for HTTP API auth |
| `DB_PATH` | No | `stoatcord.db` | SQLite database file path |
| `PUSH_ENABLED` | No | `true` | Enable push notification relay |
| `FIREBASE_SERVICE_ACCOUNT` | No | `firebase-service-account.json` | Path to Firebase SA JSON |
| `FIREBASE_SA_JSON` | No | — | Firebase SA JSON string (for containers) |
| `VAPID_PUBLIC_KEY` | No | — | VAPID public key for WebPush |
| `VAPID_PRIVATE_KEY` | No | — | VAPID private key for WebPush |
| `PUSH_BOT_API_URL` | No | `http://localhost:3210` | Public URL for push registration |

## Commands

```bash
bun run start       # Run the bot
bun run dev         # Run with auto-reload (--watch)
bun run typecheck   # TypeScript type checking
```

## Discord Slash Commands

| Command | Description |
|---------|-------------|
| `/migrate` | Interactive server migration wizard |
| `/link` | Link a Discord channel to a Stoat channel |
| `/unlink` | Remove a channel bridge link |
| `/status` | Show bridge and migration status |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/diag` | Bot diagnostics and health check |
| `GET` | `/api/guilds` | List linked Discord guilds |
| `GET` | `/api/guilds/:id/channels` | Get channels for a guild |
| `GET` | `/api/links` | List all bridge links |
| `POST` | `/api/links` | Create a bridge link |
| `DELETE` | `/api/links/:id` | Remove a bridge link |
| `POST` | `/api/push/register` | Register push device |
| `DELETE` | `/api/push/unregister` | Unregister push device |
| `GET` | `/api/push/status` | Check device registration |
| `GET` | `/api/push/vapid` | Get VAPID public key |

## Deployment

### Railway

The project includes Railway deployment configuration:

```bash
# Deploy to Railway
railway link
railway up
```

Set environment variables via `railway variables set KEY=VALUE`.

For SQLite persistence, add a volume mounted at `/data` and set `DB_PATH=/data/stoatcord.db`.

For Firebase push notifications in containers, set `FIREBASE_SA_JSON` to the full JSON string of your service account (instead of a file path).

### Docker

```bash
docker build -t stoatcord-bot .
docker run -d \
  --env-file .env \
  -p 3210:3210 \
  -v stoatcord-data:/data \
  stoatcord-bot
```

## Technical Notes

- Database uses `bun:sqlite` with WAL mode for crash safety and concurrent reads
- Stoat auth uses `x-bot-token` header (bot tokens, not user sessions)
- Discord user impersonation via webhooks, Stoat via masquerade API
- Migration rate limits: 2.5s delay between channel/role creation operations
- Push relay detects mentions via `<@USER_ID>` regex and DM channel recipients
- FCM uses OAuth2 JWT auth with Google service account (RS256)
- WebPush uses RFC 8291 encryption with VAPID signing via `web-push` package

## License

MIT
