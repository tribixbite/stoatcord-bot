# Discord Archive Migration — Feature Roadmap

## Current State

The existing migration wizard (`/migrate` slash command) copies **server structure only**:
- Channels (text, voice, announcements, forums) with categories
- Roles with permissions, colours, hoist/mentionable settings
- Channel permission overwrites
- Server properties (name, description, icon, banner)
- Emoji (uploaded to Autumn CDN)
- Pin snapshot (summary posted to #migration-log, not actual pin recreation)

**Message history is NOT copied.** Only a snapshot summary is posted to a #migration-log channel. This roadmap covers full message archive migration.

---

## Goal

Copy all existing Discord message history to Stoat, preserving:
- Message content and formatting
- Author identity (name + avatar via masquerade)
- Chronological order
- Attachments (re-hosted to Autumn CDN)
- Reply chain references
- Embeds and link previews

---

## Phase 1: Message History Export

**Complexity: Medium** | **Dependencies: None**

Paginated export of all messages from Discord channels.

### Implementation
1. Use `channel.messages.fetch({ limit: 100, before: cursor })` for cursor-based pagination
2. Process channels in order (oldest-created first)
3. Store messages in a SQLite staging table:
   ```sql
   CREATE TABLE archive_messages (
     discord_id TEXT PRIMARY KEY,
     discord_channel_id TEXT NOT NULL,
     author_id TEXT NOT NULL,
     author_name TEXT NOT NULL,
     author_avatar TEXT,
     author_bot INTEGER DEFAULT 0,
     content TEXT,
     timestamp INTEGER NOT NULL,
     edited_timestamp INTEGER,
     reference_id TEXT,          -- reply parent Discord message ID
     attachments TEXT,           -- JSON array of attachment objects
     embeds TEXT,                -- JSON array of embed objects
     reactions TEXT,             -- JSON array of reaction summaries
     pinned INTEGER DEFAULT 0,
     type INTEGER DEFAULT 0,    -- Discord message type enum
     stoat_id TEXT,              -- populated after import
     stoat_channel_id TEXT,
     exported_at INTEGER DEFAULT (unixepoch()),
     imported_at INTEGER         -- populated after import
   );
   CREATE INDEX idx_archive_channel ON archive_messages(discord_channel_id, timestamp);
   CREATE INDEX idx_archive_reference ON archive_messages(reference_id);
   ```
4. Track export progress per channel:
   ```sql
   CREATE TABLE archive_progress (
     discord_channel_id TEXT PRIMARY KEY,
     stoat_channel_id TEXT,
     total_messages INTEGER DEFAULT 0,
     exported_count INTEGER DEFAULT 0,
     imported_count INTEGER DEFAULT 0,
     last_cursor TEXT,           -- Discord message ID cursor
     status TEXT DEFAULT 'pending',  -- pending, exporting, exported, importing, done, error
     error_message TEXT,
     started_at INTEGER,
     completed_at INTEGER
   );
   ```

### Rate Limits
- Discord: 50 requests per second globally, `channel.messages.fetch` returns max 100 messages
- Effective throughput: ~5,000 messages per minute per channel
- A 100K-message channel takes ~20 minutes to export

### Considerations
- Skip system messages (join, boost, pin notifications) or convert to metadata
- Handle deleted authors gracefully (use `[Deleted User]` placeholder)
- Store raw Discord snowflake timestamps for precision
- Support resume: if interrupted, restart from `last_cursor`

---

## Phase 2: Stoat Bulk Import

**Complexity: High** | **Dependencies: Phase 1**

Post archived messages to Stoat channels in chronological order.

### Implementation
1. Read from `archive_messages` ordered by `timestamp ASC`
2. For each message, `POST /channels/{stoat_ch}/messages`:
   ```json
   {
     "content": "message content",
     "masquerade": {
       "name": "OriginalAuthor",
       "avatar": "https://cdn.discordapp.com/avatars/..."
     }
   }
   ```
3. Store returned Stoat message ID in `archive_messages.stoat_id`
4. Update `archive_progress.imported_count` after each batch

### Rate Limits
- Stoat API: estimated 2-3 messages per second (needs testing)
- With 2s delay: ~1,800 messages per hour, ~43,200 per day
- A 100K-message server: ~2.3 days for full import

### Considerations
- Masquerade preserves author identity without creating Stoat accounts
- Discord avatar CDN URLs may expire — re-host to Autumn first (Phase 4)
- Message content formatting: run through `discordToRevolt()` converter
- Empty messages (attachment-only): append `[attachment]` placeholder
- Batch size: process 50 messages at a time, commit progress to DB

---

## Phase 3: Timestamp Preservation

**Complexity: Low** | **Dependencies: Phase 2**

Stoat's message API doesn't support custom timestamps. Preserve original timestamps via content embedding.

### Implementation
1. Prepend a formatted timestamp header to each imported message:
   ```
   ━━ 2024-01-15 14:30 UTC ━━
   Original message content here
   ```
2. Use a configurable format:
   - `header`: Prepend timestamp line (default)
   - `footer`: Append timestamp line
   - `inline`: Prefix with `[14:30]` only
   - `none`: No timestamp (rely on Stoat's own message timestamps)

### Considerations
- Stoat message IDs are ULIDs which encode creation time — imported messages will have import-time ULIDs, not original timestamps
- The timestamp header adds visual noise but preserves critical temporal context
- Consider a dedicated `#archive-` channel prefix to distinguish imported content
- Timezone: store as UTC, let clients render in local time

---

## Phase 4: Attachment Re-hosting

**Complexity: Medium** | **Dependencies: Phase 1**

Download Discord attachments and re-upload to Stoat's Autumn CDN.

### Implementation
1. For each message with attachments in `archive_messages`:
   - Parse attachment JSON: `{ url, filename, size, content_type, width, height }`
   - Download from Discord CDN URL
   - Upload to Autumn: `POST /autumn/attachments` (multipart form)
   - Store Autumn file ID in a mapping table
2. When importing (Phase 2), attach Autumn file IDs to the Stoat message

### API Endpoints
- Download: `GET https://cdn.discordapp.com/attachments/{ch}/{id}/{filename}`
- Upload: `POST https://autumn.stoat.chat/attachments` (multipart, returns `{ id }`)
- Attach: Include `attachments: ["autumn_file_id"]` in message POST

### Rate Limits
- Discord CDN: generally unrestricted for bot downloads
- Autumn CDN: unknown rate limit, estimate 1 upload per second
- File size limit: Stoat default is 20MB per file

### Considerations
- Large files may exceed Stoat limits — skip with warning
- Track download/upload progress for resume capability
- Disk space: temporary storage needed for downloads before re-upload
- Consider streaming (pipe download directly to upload) to reduce disk usage
- Image thumbnails: preserve width/height metadata

---

## Phase 5: Thread/Reply Chain Reconstruction

**Complexity: High** | **Dependencies: Phase 2**

Preserve message reply relationships and thread structure.

### Implementation
1. **Reply chains**:
   - `archive_messages.reference_id` stores the Discord parent message ID
   - After all messages are imported, look up the Stoat ID of the parent
   - Update the child message with `replies: [{ id: stoat_parent_id, mention: false }]`
   - Alternative: since messages are imported in order, queue reply references and resolve as parents are imported
2. **Threads**:
   - Discord threads → create Stoat text channels (name: `thread-{original_name}`)
   - Import thread messages into the new Stoat channel
   - Link thread starter message to the thread channel

### Considerations
- Two-pass approach: first import all messages, then patch reply references
- Thread archives: Discord auto-archives threads after inactivity — import archived threads too
- Forum posts: each forum post is effectively a thread — import as separate channels
- Cross-channel replies: not supported, skip with warning

---

## Phase 6: Embed/Reaction Metadata Preservation

**Complexity: Medium** | **Dependencies: Phase 2**

Preserve rich embeds and reaction summaries.

### Implementation
1. **Embeds**:
   - Convert Discord embed objects to Stoat `SendableEmbed`:
     ```json
     {
       "title": "...",
       "description": "...",
       "url": "...",
       "icon_url": "...",
       "colour": "#hex"
     }
     ```
   - Stoat supports one embed per message — merge multiple Discord embeds
   - Link preview embeds: include URL in content, let Stoat generate its own preview
2. **Reactions**:
   - Reactions can't be backdated — instead, append a reaction summary:
     ```
     Reactions: 👍 12 · ❤️ 5 · 🎉 3
     ```
   - Only include if message has 3+ total reactions (avoid noise)

### Considerations
- Discord embed types: rich, image, video, gifv, article, link — only `rich` maps to Stoat
- Video/gifv embeds: include as plain URL links
- Reaction counts may be inaccurate for messages with >100 reactions (Discord API limitation)

---

## Phase 7: Progress Tracking & Resume

**Complexity: Medium** | **Dependencies: All phases**

Robust progress UI and interrupt handling.

### Implementation
1. **Discord command UI**: Extend `/migrate` with an `archive` subcommand:
   - `/migrate archive` — start/resume message archive migration
   - Show progress embed with per-channel status bars
   - Update embed every 30 seconds with counts
   - Support cancel button (AbortSignal, same as existing wizard)
2. **Resume capability**:
   - `archive_progress` table tracks cursor position per channel
   - On restart, check `status` field and resume from `last_cursor`
   - Skip already-imported messages (check `imported_at IS NOT NULL`)
3. **Error recovery**:
   - On API error: retry 3 times with exponential backoff (1s, 2s, 4s)
   - On persistent error: mark channel as `error`, log message, continue with next
   - Manual retry: `/migrate archive --channel #specific-channel`

### Considerations
- Long-running operation (hours to days) — must survive bot restarts
- Progress should be visible in both Discord (embed) and bot logs
- Consider a web dashboard endpoint: `GET /api/archive/status`

---

## Estimates

| Server Size | Export Time | Import Time | Storage |
|-------------|-----------|-------------|---------|
| 10K messages | ~2 min | ~1.5 hours | ~10 MB |
| 50K messages | ~10 min | ~7 hours | ~50 MB |
| 100K messages | ~20 min | ~14 hours | ~100 MB |
| 500K messages | ~1.5 hours | ~3 days | ~500 MB |
| 1M messages | ~3 hours | ~6 days | ~1 GB |

*Import time assumes 2 messages/second to Stoat. Actual throughput depends on Stoat rate limits, attachment sizes, and network conditions.*

---

## Implementation Order

| Phase | Feature | Complexity | Priority |
|-------|---------|------------|----------|
| 1 | Message History Export | Medium | Critical |
| 2 | Stoat Bulk Import | High | Critical |
| 3 | Timestamp Preservation | Low | High |
| 7 | Progress Tracking & Resume | Medium | High |
| 4 | Attachment Re-hosting | Medium | Medium |
| 5 | Thread/Reply Reconstruction | High | Medium |
| 6 | Embed/Reaction Metadata | Medium | Low |

Phases 1-3 and 7 form the minimum viable archive migration. Phases 4-6 are enhancements that improve fidelity but aren't required for basic message preservation.
