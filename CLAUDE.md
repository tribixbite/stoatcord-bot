# stoatcord-bot

Discord↔Stoat migration and message bridge bot built with Bun + TypeScript.

## Quick Start

```bash
cp .env.example .env
# Fill in DISCORD_TOKEN and STOAT_TOKEN
bun run start
```

## Commands

- `bun run start` — Run the bot
- `bun run dev` — Run with auto-reload (--watch)
- `bun run typecheck` — TypeScript type checking

## Architecture

```
src/
  index.ts          — Entry point, connects both platforms
  config.ts         — Environment config validation
  stoat/            — Stoat/Revolt REST client + WebSocket
  discord/          — Discord.js v14 client + slash commands
  bridge/           — Bidirectional message relay + format conversion
  migration/        — Channel/role migration wizard
  db/               — bun:sqlite persistence layer
```

## Key Notes

- Bun automatically loads .env — no dotenv needed
- Database uses `bun:sqlite` (WAL mode, synchronous API)
- Stoat auth uses `x-bot-token` header (bot tokens, not user sessions)
- Discord impersonation via webhooks, Stoat impersonation via masquerade
- Rate limits: 2.5s delay between server-bucket operations (channel/role creation)
- Install with `bun install --backend=copyfile` on Termux (SELinux blocks hardlinks)

## Bun APIs

- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Use `bun test` to run tests.
