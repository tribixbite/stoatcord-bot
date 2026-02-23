# Discord Archive Migration — Feature Roadmap

## Current State (February 2026)

The archive system is fully operational with export, import, pause/resume, and progress tracking.

### Implemented

**Discord Slash Commands:**
- `/archive start [stoat_channel_id] [rehost_attachments] [preserve_embeds]` — export channel history, optionally import to Stoat
- `/archive status` — view all jobs for the guild (10 most recent)
- `/archive pause [job_id]` — pause a running job via shared AbortController
- `/archive resume [job_id]` — resume from last checkpoint

**Stoat Commands:**
- `!stoatcord archive` — view archive job status for the linked guild

**HTTP API (guild-scoped Bearer token auth):**
- `GET /api/archive/status` — query by guild (auto-scoped) or job ID
- `POST /api/archive/start` — start export with channel ownership validation
- `POST /api/archive/pause` — abort and pause via shared manager
- `POST /api/archive/resume` — resume export or import from checkpoint

**Database Schema (V5):**
```sql
archive_jobs (
  id TEXT PRIMARY KEY,         -- 8-char UUID prefix
  guild_id TEXT NOT NULL,
  discord_channel_id TEXT NOT NULL,
  discord_channel_name TEXT,
  stoat_channel_id TEXT,       -- null for export-only
  direction TEXT NOT NULL,     -- 'export' | 'import'
  status TEXT DEFAULT 'pending', -- pending/running/paused/completed/failed
  total_messages INTEGER,
  processed_messages INTEGER,
  last_message_id TEXT,        -- cursor for resume
  started_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  created_at INTEGER
)

archive_messages (
  id INTEGER PRIMARY KEY,
  job_id TEXT REFERENCES archive_jobs(id),
  discord_message_id TEXT NOT NULL,
  author_id TEXT, author_name TEXT, author_avatar_url TEXT,
  content TEXT, timestamp TEXT, edited_timestamp TEXT,
  reply_to_id TEXT,            -- Discord parent message ID
  attachments_json TEXT,       -- JSON array
  embeds_json TEXT,            -- JSON array
  stoat_message_id TEXT,       -- populated after import
  imported_at INTEGER
)
```

**Architecture:**
```
/archive start → events.ts handleArchiveStart()
  ├── Creates archive_job (direction: export)
  ├── Registers AbortController in archive/manager.ts
  ├── Runs exportDiscordChannel() in background
  │   ├── cursor-based pagination (100 msgs/batch)
  │   ├── Stores in archive_messages via storeArchiveMessages()
  │   └── Updates job progress (total_messages, processed_messages, last_message_id)
  └── On export complete, if stoat_channel_id provided:
      ├── Creates second archive_job (direction: import)
      └── Runs importToStoat() in background
          ├── Reads unimported messages in batches of 50
          ├── Posts to Stoat via masquerade (author name + avatar)
          ├── Reconstructs reply chains using imported message ID map
          └── Marks each message imported (stoat_message_id, imported_at)

/archive pause → abortJob() → AbortController.abort() → running process exits cleanly
/archive resume → registerJob() → new AbortController → resumes from last_message_id
```

### Security
- HTTP API requires `Authorization: Bearer <guild-token>` on all archive endpoints
- Per-guild token auto-generated on `/migrate`, viewable via `/token`
- Guild scoping: jobs validated against authed guild, channels verified for ownership
- Slash commands gated by Discord Administrator permission

---

## Remaining Work

### Timestamp Embedding (Low Complexity)

Stoat messages get the import-time ULID as their timestamp, not the original Discord timestamp. Options:

1. **Header format** (recommended):
   ```
   ━━ 2024-01-15 14:30 UTC ━━
   Original message content
   ```
2. **Inline format**: `[14:30] Original message content`
3. **Footer format**: append `— Jan 15, 2024 2:30 PM`
4. **None**: rely on Stoat's own timestamps (lossy but clean)

Should be a per-job option: `timestamp_format: header | inline | footer | none`

### Attachment Re-hosting Improvements (Medium Complexity)

The `rehost_attachments` option exists but needs:
- Streaming download→upload pipeline (avoid disk buffering)
- File size limit handling (skip >20MB with warning)
- Image dimension metadata preservation
- Progress tracking per attachment
- Retry logic for CDN download failures (Discord URLs can expire for old messages)

### Embed Conversion (Medium Complexity)

The `preserve_embeds` option exists but needs full implementation:
- Discord rich embed → Stoat SendableEmbed conversion
- Handle multiple embeds (Stoat supports one per message)
- Video/gifv → plain URL fallback
- Link preview embeds → include URL, let Stoat auto-preview

### Reaction Summary Append (Low Complexity)

Reactions can't be backdated on Stoat. Append a summary line:
```
Reactions: 👍 12 · ❤️ 5 · 🎉 3
```
Only for messages with 3+ total reactions to reduce noise.

### Thread/Forum Export (High Complexity)

Discord threads and forum posts are separate message lists not captured by channel export.

**Approach:**
1. After channel export, enumerate threads via `channel.threads.fetch()`
2. Export each thread as a separate archive job
3. Import into Stoat as a text channel or flattened into parent

### Bulk Progress UI (Medium Complexity)

Current `/archive status` shows a list. Could improve with:
- Live-updating embed with progress bars per channel
- ETA calculation based on throughput
- Webhook notification on completion

### Web Dashboard (Low Priority)

The HTTP API supports all operations but a web UI could help for:
- Visual progress monitoring
- One-click start for all channels
- Download exported data as JSON/CSV

---

## Performance Characteristics

| Server Size | Export Time | Import Time | DB Storage |
|-------------|-----------|-------------|------------|
| 10K messages | ~2 min | ~1.5 hours | ~10 MB |
| 50K messages | ~10 min | ~7 hours | ~50 MB |
| 100K messages | ~20 min | ~14 hours | ~100 MB |
| 500K messages | ~1.5 hours | ~3 days | ~500 MB |

*Import time assumes 2 messages/second to Stoat. Export is limited by Discord API rate limits (~5,000 messages/minute).*

---

## Priority Order

| Feature | Complexity | Impact | Status |
|---------|------------|--------|--------|
| Message export (paginated) | Medium | Critical | Done |
| Stoat import (masquerade) | High | Critical | Done |
| Reply chain reconstruction | Medium | High | Done |
| Pause/resume/abort | Medium | High | Done |
| Progress tracking | Medium | High | Done |
| HTTP API with auth | Medium | High | Done |
| Slash command interface | Low | High | Done |
| Timestamp embedding | Low | Medium | Planned |
| Attachment re-hosting | Medium | Medium | Partial |
| Embed conversion | Medium | Low | Partial |
| Reaction summary | Low | Low | Planned |
| Thread/forum export | High | Medium | Planned |
| Bulk progress UI | Medium | Low | Planned |
| Web dashboard | Medium | Low | Deferred |
