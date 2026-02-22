# Stoatcord Bot — Comprehensive Systems Analysis

**Date**: 2026-02-21
**Scope**: Bidirectional Bridge, Server Migration, Historical Message Backlog
**Source files analyzed**: 29 bot source files, 2 roadmap docs, 3 Android app source files, Revolt/Stoat API docs

---

## Table of Contents

1. [System 1: Bidirectional Bridge](#system-1-bidirectional-bridge)
2. [System 2: Migration System (Server Structure)](#system-2-migration-system-server-structure)
3. [System 3: Historical Message Backlog Cloning](#system-3-historical-message-backlog-cloning)
4. [Cross-System Dependencies](#cross-system-dependencies)
5. [API Reference Summary](#api-reference-summary)
6. [Appendix: Database Schema](#appendix-database-schema)

---

## System 1: Bidirectional Bridge

### 1.1 Current State (What Works)

The bridge is implemented across three files:
- `/src/bridge/relay.ts` — Core relay logic, echo prevention, user cache
- `/src/bridge/format.ts` — Markdown/spoiler conversion between platforms
- `/src/bridge/webhooks.ts` — Discord webhook management

**Working features:**
- **Discord-to-Stoat relay**: Listens for `MessageCreate` events. Converts content via `discordToRevolt()`, appends attachment URLs, sends to Stoat with masquerade (original Discord user's name and avatar). Returns Stoat message ID and marks it as "bridged" to prevent echo.
- **Stoat-to-Discord relay**: Listens for Stoat WebSocket `Message` events. Skips masqueraded messages (echo prevention). Resolves Stoat user display name/avatar via cached API lookups. Sends to Discord via webhook with matching username and avatar.
- **Markdown conversion**: Spoilers (`||text||` to `!!text!!` and back). Mentions, channel refs, and custom emoji are stripped and replaced with generic placeholders.
- **Echo prevention**: `recentBridgedIds` Set with 60-second TTL. Messages with masquerade set are skipped (Stoat side). Bot/system messages are skipped (Discord side).
- **2000-char truncation**: Both platforms enforce 2000-char limit with `...` ellipsis.
- **User identity forwarding**: Discord avatar/name via masquerade on Stoat; Stoat avatar/name via webhook on Discord.
- **Attachment forwarding**: URLs are appended to message content (not re-hosted).

**Not working / missing:**
- No message edit sync
- No message delete sync
- No reaction forwarding
- No reply chain preservation
- No thread mirroring
- No attachment re-hosting (URLs only)
- No cross-platform user/channel mention mapping
- No custom emoji mapping
- No typing indicators
- No channel metadata sync
- No outage recovery / gap detection
- No message ID pair tracking (no `bridge_messages` table)

### 1.2 Channel:Thread Mapping System Design

**Current state**: No thread support whatsoever. Discord threads and forum posts are ignored by the bridge relay (only `GuildText`, `GuildAnnouncement` are bridged).

**Proposed design:**

| Discord concept | Stoat mapping | Notes |
|---|---|---|
| Text channel | Text channel | 1:1 link, works today |
| Thread | New text channel | Stoat has no thread concept; a new channel is created |
| Forum post | New text channel | Each post becomes a standalone Stoat channel |
| Thread archive/close | No Stoat action | Log a status message; Stoat channels are always open |

**Technical approach:**
1. Listen for Discord `threadCreate` event. Create a Stoat text channel named `thread-{threadName}`.
2. Store the mapping in `channel_links` with a new `is_thread` flag.
3. Relay messages within the thread to the new Stoat channel.
4. On `threadDelete`, post a notice in the Stoat channel. Optionally archive it.
5. Thread-to-channel links should auto-unlink after 30 days of inactivity.

**Complexity**: L (Large)
**Dependencies**: `bridge_messages` table (for reply chain resolution across threads)
**Blocker**: Stoat has no thread concept; UI will show these as regular channels.

### 1.3 Message Edit Sync

**Technical approach:**
1. Create `bridge_messages` table mapping discord_message_id to stoat_message_id.
2. On relay, insert mapping row.
3. Discord `messageUpdate` event: Look up Stoat counterpart, call `PATCH /channels/{ch}/messages/{msg}` with `{ content }`.
4. Stoat `MessageUpdate` WS event: Look up Discord counterpart, edit via Discord.js `Message.edit()`.
5. Debounce rapid edits (1-second cooldown).

**API endpoints:**
- Stoat: `PATCH /channels/{channel_id}/messages/{message_id}` (edit message content)
- Discord: `messageUpdate` event, `Message.edit()` method
- Stoat WS: `MessageUpdate` event already parsed in `websocket.ts`

**Known limitations:**
- Webhook messages on Discord cannot be edited via the bot's Message object. Must use webhook API: `PATCH /webhooks/{id}/{token}/messages/{message_id}`.
- Stoat `MessageUpdate` WS event handler exists but the relay does not act on it.

**Complexity**: M (Medium)
**Dependencies**: New `bridge_messages` DB table

### 1.4 Message Delete Sync

**Technical approach:**
1. Discord `messageDelete` event: Look up Stoat counterpart, call `DELETE /channels/{ch}/messages/{msg}`.
2. Stoat `MessageDelete` WS event: Look up Discord counterpart, delete via webhook API.
3. Clean up `bridge_messages` row after deletion.
4. Handle Discord `messageDeleteBulk` (rate-limit the Stoat-side deletions).

**API endpoints:**
- Stoat: `DELETE /channels/{channel_id}/messages/{message_id}`
- Stoat: `DELETE /channels/{channel_id}/messages/bulk` (messages < 1 week old, needs ManageMessages perm)
- Discord: `messageDelete`, `messageDeleteBulk` events

**Known limitations:**
- Stoat bulk delete only works for messages < 7 days old.
- Must mark bot-initiated deletes to prevent echo.

**Complexity**: S (Small)
**Dependencies**: Phase 1 (`bridge_messages` table)

### 1.5 Reaction Sync

**Technical approach:**
1. Unicode emoji: Direct 1:1 mapping between platforms.
2. Custom emoji: Match by name (`:stoat:` on Discord maps to `:stoat:` on Stoat). Unmapped custom emoji are skipped.
3. Discord `messageReactionAdd`/`messageReactionRemove` events: Look up Stoat message, call `PUT/DELETE /channels/{ch}/messages/{msg}/reactions/{emoji}`.
4. Stoat `MessageReact`/`MessageUnreact` WS events (need to add handler): Look up Discord message, add/remove reaction.

**API endpoints:**
- Stoat: `PUT /channels/{ch}/messages/{msg}/reactions/{emoji}` (add reaction)
- Stoat: `DELETE /channels/{ch}/messages/{msg}/reactions/{emoji}` (remove, with optional `user_id` or `remove_all`)
- Discord: `Message.react(emoji)`, `MessageReaction.users.remove(userId)`

**Known limitations:**
- Reactions are heavily rate-limited on both platforms.
- Bot must have `React` permission (bit 29) in Stoat.
- No way to "react as" another user on either platform without their token.
- All bridged reactions will appear from the bot account on both sides.

**Complexity**: L (Large) — due to emoji mapping complexity and rate limit constraints
**Dependencies**: `bridge_messages` table

### 1.6 Reply/Thread Mirroring

**Technical approach:**
1. When a Discord message has `message_reference`, look up the referenced message in `bridge_messages`.
2. If found, set `replies: [{ id: stoatMessageId, mention: false }]` on the Stoat message.
3. Reverse: When a Stoat message has `replies[]`, look up the Discord counterpart and set `message_reference`.
4. If the referenced message is not in `bridge_messages`, fall back to a quote-style prefix.

**API endpoints:**
- Stoat: `POST /channels/{ch}/messages` with `replies: [{ id, mention }]`
- Discord: `channel.send({ reply: { messageReference: id } })`

**Known limitations:**
- Webhook messages on Discord cannot use `message_reference` directly. Must use the webhook API's `flags` and custom content formatting as fallback.
- Cross-channel replies are not supported.
- Quote fallback format: `> *Replying to @username*: first 100 chars...`

**Complexity**: L (Large)
**Dependencies**: `bridge_messages` table

### 1.7 Attachment Re-hosting

**Technical approach:**
1. **Discord-to-Stoat**: Download attachment from Discord CDN, upload to Stoat Autumn (`POST /autumn/attachments`), include Autumn file ID in `attachments[]` field of Stoat message.
2. **Stoat-to-Discord**: Download from Stoat CDN, attach to webhook message via Discord webhook API's `files` multipart field.
3. Cache already-uploaded files by hash to avoid duplicates on edits.

**API endpoints:**
- Stoat Autumn: `POST https://autumn.stoat.chat/attachments` (multipart upload, returns `{ id }`)
- Discord: Webhook multipart with `files[0]` field
- Discord CDN: `GET https://cdn.discordapp.com/attachments/{ch}/{id}/{filename}`

**Known limitations:**
- File size limits differ: Discord 25MB (free) / 100MB (Nitro); Stoat default ~20MB.
- Large files exceeding Stoat limits must be skipped with a URL-only fallback.
- Autumn upload rate limits are undocumented but estimated at ~1/second.

**Complexity**: M (Medium)
**Dependencies**: None (independent)

### 1.8 Typing Indicators

**Technical approach:**
1. Discord `typingStart` event: Forward via Stoat WebSocket `BeginTyping` event or REST `POST /channels/{ch}/typing` (undocumented in current OpenAPI but referenced in protocol docs).
2. Stoat `ChannelStartTyping` WS event: Forward via Discord.js `channel.sendTyping()`.
3. Debounce: Max 1 typing event per 5 seconds per user per channel.

**API endpoints:**
- Stoat WS: Send `{ type: "BeginTyping", channel: channelId }` via WebSocket
- Discord: `TextChannel.sendTyping()`

**Known limitations:**
- Typing indicators are ephemeral; no persistence.
- Bot typing might be confusing if multiple Stoat users are typing simultaneously.
- Low-priority feature.

**Complexity**: S (Small)
**Dependencies**: None

### 1.9 Channel Metadata Sync

**Technical approach:**
1. Discord `channelUpdate` event: If linked, call `PATCH /channels/{ch}` with updated `{ name, description, nsfw }`.
2. Stoat `ChannelUpdate` WS event (not yet handled): If linked, call Discord.js `channel.edit({ name, topic, nsfw })`.
3. Last-write-wins conflict resolution.

**API endpoints:**
- Stoat: `PATCH /channels/{ch}` with `{ name, description, nsfw }`
- Discord: `channel.edit({ name, topic, nsfw, rateLimitPerUser })`

**Known limitations:**
- Stoat does not support slowmode.
- Permission changes are too complex for automatic sync.
- Name length limits differ (Stoat: 32 chars, Discord: 100 chars).

**Complexity**: M (Medium)
**Dependencies**: None

### 1.10 Outage Recovery / Gap Sync

**Technical approach:**
1. Track the last successfully bridged message timestamp per linked channel pair.
2. On reconnect (after WS disconnect or bot restart), query both platforms for messages sent during the gap.
3. Discord: `channel.messages.fetch({ after: lastMessageId, limit: 100 })` — paginate until caught up.
4. Stoat: `GET /channels/{ch}/messages?after={lastId}&sort=Oldest&limit=100` — paginate until caught up.
5. Relay each missed message in chronological order with a `[delayed]` indicator.
6. Store `last_bridged_at` and `last_bridged_message_id` per channel link.

**API endpoints:**
- Stoat: `GET /channels/{ch}/messages?after={id}&sort=Oldest&limit=100`
- Discord: `channel.messages.fetch({ after, limit: 100 })`

**Known limitations:**
- Stoat bulk fetch returns max 100 messages per request.
- Messages older than 7 days cannot be bulk-deleted if needed.
- Could cause message spam in the bridged channel during catch-up; need throttling.
- Must handle deduplication against already-bridged messages.

**Complexity**: L (Large)
**Dependencies**: `bridge_messages` table, channel link metadata

### 1.11 Permission and Administration

**Current state:**
- Discord: `/link` requires `ManageChannels`, `/migrate` requires `Administrator` (enforced by Discord permissions).
- Stoat: `!stoatcord code` checks `isStoatServerAdmin()` (owner or ManageServer role permission).
- Bot API: Optional `API_KEY` header authentication.
- Android app: Connects to bot API with configurable URL and API key.

**Proposed additions:**
- Per-link bridge pause/resume (without deleting).
- Admin-only commands to list/modify bridges from either platform.
- Audit log for bridge operations (who linked/unlinked what, when).

**Complexity**: S (Small) for pause/resume, M (Medium) for audit logging

### 1.12 UI/Commands for Setup and Management

**Current interfaces:**

| Interface | Commands/Actions | Coverage |
|---|---|---|
| Discord slash commands | `/link`, `/unlink`, `/status`, `/migrate` | Full CRUD for links, migration wizard |
| Stoat prefix commands | `!stoatcord code`, `request`, `status`, `ping`, `diag`, `help` | Code generation, status, diagnostics |
| Bot HTTP API | `GET/POST/DELETE /api/links`, `GET /api/guilds`, `GET /api/diag` | CRUD for links, guild browsing |
| Android app — BridgeSettingsScreen | View/create/delete bridge links via bot API | Full GUI for link management |
| Android app — DiscordImportScreen | Browse Discord guilds, select channels, create Stoat channels | Channel-level import wizard |
| Android app — Discord.kt API client | `fetchBotGuilds`, `fetchGuildChannels`, `fetchGuildLinks`, `createBridgeLink`, `deleteBridgeLink` | Full API client for bot integration |

**Missing:**
- No Stoat-side command to manage individual channel links (only server-level).
- No way to pause/resume a bridge without deleting it.
- No command to trigger gap/outage recovery.
- No archive/backlog commands yet.
- Android app has no UI for migration history or archive import progress.

### 1.13 Bridge Feature Priority and Complexity Summary

| Feature | Complexity | Impact | Dependencies |
|---|---|---|---|
| Message Edit Sync | M | High | `bridge_messages` table |
| Message Delete Sync | S | High | `bridge_messages` table |
| Attachment Re-hosting | M | Medium | None |
| Reaction Sync | L | Medium | `bridge_messages` table |
| Reply Chain Mirroring | L | Medium | `bridge_messages` table |
| Outage Recovery Sync | L | High | `bridge_messages` table, link metadata |
| Typing Indicators | S | Low | None |
| Channel Metadata Sync | M | Low | None |
| Thread/Forum Mirroring | L | Medium | `bridge_messages` table, `channel_links` |
| Bridge Pause/Resume | S | Medium | Schema addition |

---

## System 2: Migration System (Server Structure)

### 2.1 Current State (What Works)

The migration system is implemented across 6 files:
- `/src/migration/wizard.ts` — Interactive Discord wizard (1142 lines, the largest file)
- `/src/migration/progress.ts` — Rate-limit-aware batch executor with dedup
- `/src/migration/channels.ts` — Discord-to-Stoat channel mapping
- `/src/migration/roles.ts` — Discord-to-Stoat role/permission mapping
- `/src/migration/snapshot.ts` — Full server data snapshot generator
- `/src/migration/approval.ts` — In-memory promise management for live approvals

**Working features:**
- **Three authorization paths**: (A) Create new Stoat server, (B) Claim code from Stoat admin, (C) Live approval via reply in Stoat channel.
- **Channel creation/update**: Text, Voice, Announcement, Forum channels. Name sanitization (32 chars), topic/description sync, NSFW flag.
- **Role creation/update**: Name, colour, hoist, permissions mapped via `mapPermissions()`. 22 Discord permissions mapped to Revolt equivalents.
- **Category organization**: Groups channels into Revolt categories matching Discord's layout. Can run independently via `categories` mode.
- **Emoji migration**: Downloads from Discord CDN, uploads to Autumn, creates via `PUT /custom/emoji/{id}`. Name conflict resolution with incrementing suffix.
- **Server media**: Icon and banner download/upload via Autumn CDN.
- **Server properties**: Name, description sync.
- **Incremental dedup**: Matches existing Stoat items by lowercase name. Creates missing, updates existing.
- **Dry-run mode**: Full plan generation without API calls.
- **Mid-flight cancellation**: AbortSignal integration with per-operation check.
- **Progress tracking**: Real-time Discord embed updates with progress bar.
- **Snapshot posting**: Comprehensive server data dump to restricted `#migration-log` channel (members, bans, pins, emoji, roles, channels, permissions, unmapped properties).
- **Migration logging**: All operations logged to `migration_log` table with success/error/skipped status.
- **Rate limiting**: 2.5s delay between channel/role operations, 2s for emoji.

### 2.2 Channel Creation/Update with Category Mapping

**Current implementation:**
- `mapDiscordChannels()` reads all guild channels, extracts category parent name, topic, NSFW, slowmode, permission overwrite count.
- Channels sorted by category position, then channel position.
- Name sanitized to 32 chars.
- Channel types mapped: `GuildText`/`GuildAnnouncement`/`GuildForum` to `Text`, `GuildVoice` to `Voice`.
- Categories set via `PATCH /servers/{id}` with `categories` array after all channels are created.
- Categories contain the Stoat channel IDs organized by Discord category name.

**What works well:**
- Full category hierarchy preservation.
- Description/topic sync.
- NSFW flag.
- Channel-by-name dedup for re-runs.

**What is missing:**
- No channel icon migration (Stoat supports per-channel icons).
- No channel ordering/position within categories.
- No archived channel handling.

### 2.3 Role Creation with Permission Translation

**Current implementation (`roles.ts`):**
- 22 Discord permissions mapped to Revolt equivalents via `mapPermissions()`.
- Managed roles (bot roles) and `@everyone` are skipped.
- Role properties: name (32 char limit), colour, hoist, permissions (`{a, d}` format).
- Role dedup by lowercase name.

**Permission mapping coverage:**

| Discord Permission | Revolt Equivalent | Mapped |
|---|---|---|
| ManageChannels | ManageChannel | Yes |
| ManageGuild | ManageServer | Yes |
| ManageRoles | ManageRole | Yes |
| KickMembers | KickMembers | Yes |
| BanMembers | BanMembers | Yes |
| ModerateMembers | TimeoutMembers | Yes |
| ChangeNickname | ChangeNickname | Yes |
| ManageNicknames | ManageNicknames | Yes |
| ViewChannel | ViewChannel | Yes |
| ReadMessageHistory | ReadMessageHistory | Yes |
| SendMessages | SendMessage | Yes |
| ManageMessages | ManageMessages | Yes |
| ManageWebhooks | ManageWebhooks | Yes |
| CreateInstantInvite | InviteOthers | Yes |
| EmbedLinks | SendEmbeds | Yes |
| AttachFiles | UploadFiles | Yes |
| AddReactions | React | Yes |
| Connect | Connect | Yes |
| Speak | Speak | Yes |
| Stream | Video | Yes |
| MuteMembers | MuteMembers | Yes |
| DeafenMembers | DeafenMembers | Yes |
| MoveMembers | MoveMembers | Yes |
| ManagePermissions | ManagePermissions | Not mapped |
| ManageCustomisation (emoji) | ManageCustomisation | Not mapped |
| AssignRoles | AssignRoles | Not mapped |
| ChangeAvatar/RemoveAvatars | ChangeAvatar/RemoveAvatars | Not mapped |
| Administrator | No Revolt equivalent | N/A |
| Masquerade | Masquerade | Not mapped |

**Unmapped Discord permissions (no Revolt equivalent):**
- Administrator, MentionEveryone, UseExternalEmoji, UseApplicationCommands, CreatePrivateThreads, CreatePublicThreads, UseExternalStickers, SendMessagesInThreads, ManageEvents, UseVAD, PrioritySpeaker, RequestToSpeak, ManageThreads

**Missing from current mapping:**
- ManagePermissions, ManageCustomisation, AssignRoles, ChangeAvatar, RemoveAvatars, Masquerade (all exist in Revolt but are not mapped from Discord equivalents)

### 2.4 Permission Overrides per Channel

**Current state:**
- The snapshot (`snapshot.ts`) records Discord channel permission overwrites in the `#migration-log` snapshot (hex bitfields per role/user per channel).
- The StoatClient has `setChannelRolePermissions()` and `setChannelDefaultPermissions()` methods implemented.
- **However, the migration executor (`progress.ts`) does NOT apply per-channel permission overrides.** The methods exist in the client but are never called during migration.

**What is needed:**
1. During channel creation/update, read Discord channel `permissionOverwrites` cache.
2. For each overwrite, map the Discord role to the Stoat role via `role_links` table.
3. Call `PUT /channels/{ch}/permissions/{roleId}` with `{ permissions: { a, d } }`.
4. For `@everyone` overrides, call `PUT /channels/{ch}/permissions/default`.

**Complexity**: M (Medium)
**Dependencies**: Role migration must complete first

### 2.5 Emoji Migration

**Current state**: Fully implemented.
- Downloads from Discord CDN (256px, PNG/GIF).
- Uploads to Autumn CDN via `POST /autumn/emojis`.
- Creates via `PUT /custom/emoji/{autumnId}`.
- Name conflict resolution (appends incrementing suffix).
- Dedup against existing server emoji.
- 2s delay between emoji.

**Limitations:**
- Animated emoji are supported (GIF format).
- No sticker migration (Stoat has no sticker concept).
- Emoji size limited by Autumn's upload limit.

### 2.6 Server Settings

**Current state**: Partially implemented.
- Name: Set on server creation.
- Description: Synced via `PATCH /servers/{id}`.
- Icon: Uploaded to Autumn `icons` tag, set via `PATCH /servers/{id}` with icon ID.
- Banner: Uploaded to Autumn `banners` tag, set via `PATCH /servers/{id}` with banner ID.
- System messages: Not migrated (different event types between platforms).
- NSFW flag: Not synced.
- Discoverable: Not synced.

**Missing:**
- System message channel mapping (user_joined, user_left, user_kicked, user_banned).
- Server-level default permissions sync.
- Analytics/discoverable flags.

**Complexity**: S (Small) for remaining items

### 2.7 Invite Management

**Not implemented.**

Stoat/Revolt does not expose invite management via the documented bot API. Invites are typically created through the client UI. There is no documented `POST /servers/{id}/invites` endpoint in the public API reference.

**Blocker**: API limitation. Cannot programmatically create server invites.

### 2.8 Dry-Run vs Commit Modes

**Current state**: Fully implemented.
- Dry-run builds a complete plan of what would be created/updated/skipped.
- Results shown in a Discord embed with itemized action list.
- Available via slash command option `dry_run:true` or via the "Dry Run" button.
- Dry-run of new server creation is handled as a special case (no real server ID).

### 2.9 Progress Reporting and Error Recovery

**Current state**: Fully implemented.
- Progress bar updates every 3 operations in Discord embed.
- Per-operation error catching (errors are collected, migration continues).
- AbortSignal for mid-flight cancellation via Discord button.
- Migration log table records every operation with status.
- Re-runs are safe: existing items are detected by name and updated.

**Missing:**
- No automatic retry on transient errors (only manual re-run).
- No web dashboard for migration status.

### 2.10 What Cannot Be Mapped

These Discord features have no Revolt/Stoat equivalent:

| Feature | Status |
|---|---|
| Verification levels | No equivalent |
| Explicit content filter | No equivalent |
| AFK channel/timeout | No equivalent |
| Vanity URL | No equivalent |
| Server boosts/premium | No equivalent |
| Stage channels | Not supported |
| Thread channels | No native concept; mapped to text channels |
| Slowmode | Not supported |
| Auto-moderation rules | Not supported |
| Scheduled events | Not supported |
| Integrations | Not supported |
| Role icons / unicode emoji | Not supported |
| Stickers | Not supported |
| Welcome screen | Not supported |
| Server discovery settings | Different system |
| Per-member permission overwrites | Revolt only supports role-based overwrites |

### 2.11 Migration Feature Summary

| Feature | Status | Complexity |
|---|---|---|
| Channel creation/update | Done | -- |
| Category organization | Done | -- |
| Role creation/update | Done | -- |
| Permission mapping (22/25 perms) | Done | -- |
| Emoji migration | Done | -- |
| Server icon/banner | Done | -- |
| Server name/description | Done | -- |
| Dry-run mode | Done | -- |
| Mid-flight cancel | Done | -- |
| Progress tracking | Done | -- |
| Snapshot to #migration-log | Done | -- |
| Per-channel permission overrides | API ready, not wired up | M |
| Missing permission mappings (3) | Trivial | S |
| System message channels | Not implemented | S |
| Server default permissions | Not implemented | S |
| Channel ordering within categories | Not implemented | S |
| Invite creation | Blocked by API | N/A |

---

## System 3: Historical Message Backlog Cloning

### 3.1 Architecture Overview

This system does not exist yet. The existing roadmap at `/docs/archive-migration-roadmap.md` provides a high-level plan. This section expands it with concrete implementation details.

**High-level flow:**
```
Discord Server                    Bot (Bun + SQLite)                Stoat Server
     |                                  |                               |
     |-- fetch messages (paginated) --> |                               |
     |                                  |-- stage in archive_messages --|
     |                                  |-- download attachments -------|
     |                                  |-- upload to Autumn ---------->|
     |                                  |-- POST messages (masq) ----->|
     |                                  |-- track progress ------------|
```

### 3.2 Discord Message Export

**Technical approach:**
1. Use `channel.messages.fetch({ limit: 100, before: cursor })` for backward pagination.
2. Process channels in order: oldest-created first, or user-specified order.
3. Store each message in `archive_messages` SQLite table with all metadata.
4. Track progress per channel in `archive_progress` table.
5. Support resume: restart from `last_cursor` on interruption.

**API endpoints:**
- Discord: `channel.messages.fetch({ limit: 100, before, after })` — max 100 per request

**Rate limits:**
- Discord API: 50 requests/second globally.
- `channel.messages.fetch`: No specific per-endpoint limit documented beyond global.
- Effective throughput: ~5,000 messages/minute with 100ms between requests.
- A 100K-message channel: ~20 minutes to export.

**Considerations:**
- System messages (joins, boosts, pin notifications) should be configurable: skip, import as metadata, or import as regular messages with a system indicator.
- Deleted authors: Use `[Deleted User]` or `Unknown User #{discriminator}`.
- Webhook messages: These are already masqueraded on Discord; preserve the webhook's username/avatar.
- Bot messages: Configurable include/exclude.

### 3.3 Stoat Bulk Import

**Technical approach:**
1. Read from `archive_messages` ordered by `timestamp ASC`.
2. For each message, call `POST /channels/{stoat_ch}/messages` with:
   - `content`: Converted via `discordToRevolt()` + optional timestamp header.
   - `masquerade`: `{ name: authorName, avatar: authorAvatarUrl }`.
   - `attachments`: Array of Autumn file IDs (if attachments were re-hosted).
   - `replies`: Resolved from `bridge_messages` mapping (if reply parent already imported).
3. Store returned Stoat message ID in `archive_messages.stoat_id`.
4. Update `archive_progress.imported_count`.

**API endpoints:**
- Stoat: `POST /channels/{channel_id}/messages` — rate limit: 10 requests per 10-second window.

**Rate limit analysis:**
- 10 messages per 10-second window = 1 message/second sustained.
- With safety margin: ~0.8 messages/second = ~2,880 messages/hour = ~69,120 messages/day.
- **Time estimates:**

| Server Size | Export Time | Import Time (1/s) | Import Time (0.8/s) |
|---|---|---|---|
| 10K messages | ~2 min | ~2.8 hours | ~3.5 hours |
| 50K messages | ~10 min | ~13.9 hours | ~17.4 hours |
| 100K messages | ~20 min | ~27.8 hours | ~34.7 hours |
| 500K messages | ~1.5 hours | ~5.8 days | ~7.2 days |
| 1M messages | ~3 hours | ~11.6 days | ~14.5 days |

**Critical insight**: The Stoat message creation rate limit of 10/10s per channel bucket is the primary bottleneck. There is no known bulk import endpoint. Each message must be individually POSTed.

### 3.4 Timestamp Preservation

**Problem**: Stoat message IDs are ULIDs encoding creation time. Imported messages will have import-time ULIDs, not original timestamps.

**Stoat API has NO custom timestamp field in message creation.** There is no way to set a message's creation timestamp to an arbitrary past date.

**Strategies:**
1. **Header embedding** (recommended default):
   ```
   ━━ 2024-01-15 14:30 UTC ━━
   Original message content here
   ```
2. **Inline prefix**: `[14:30] Original message content`
3. **Footer**: `Original message content\n━━ 2024-01-15 14:30 UTC ━━`
4. **None**: Rely on Stoat's own timestamps (import time).

**Complexity**: S (Small) — formatting only
**Dependencies**: None

### 3.5 Author Attribution (Masquerade)

**Current capability**: The masquerade API is already used by the live bridge. Same approach applies.

**Technical approach:**
1. For each message, set `masquerade.name` to the original Discord author's display name.
2. Set `masquerade.avatar` to the Discord avatar URL.
3. For Discord bot messages, add `[BOT]` suffix to name.
4. For webhook messages, use the webhook's `username` and `avatar_url`.

**Known limitations:**
- Discord avatar URLs may expire. The `cdn.discordapp.com` URLs are stable for existing users but may not load if the user has since changed their avatar or deleted their account.
- Solution: Download avatars and re-upload to Autumn during export phase.
- Avatar re-hosting adds ~1 second per unique author to the export time.
- Cache avatars by author ID to avoid re-uploading for the same author.

**Complexity**: S (Small) — already proven in bridge relay
**Dependencies**: Attachment re-hosting system (for avatar persistence)

### 3.6 Reply Chain Reconstruction

**Technical approach:**
1. During export, store `reference_id` (Discord parent message ID) in `archive_messages`.
2. During import, messages are processed in chronological order.
3. When importing a message with `reference_id`:
   a. Look up the parent's Stoat ID in `archive_messages` (it should already be imported since it's older).
   b. If found, set `replies: [{ id: stoatParentId, mention: false }]`.
   c. If not found (parent was deleted, or from a different channel), fall back to a quote prefix:
      ```
      > *Replying to @OriginalAuthor*: First 100 chars of parent...
      ```

**API endpoints:**
- Stoat: `POST /channels/{ch}/messages` with `replies: [{ id, mention }]`

**Known limitations:**
- Cross-channel replies cannot be reconstructed.
- If the parent message failed to import, the reply reference is lost.
- Stoat supports multiple reply references per message (array), but Discord only has one.

**Complexity**: M (Medium)
**Dependencies**: Export must complete before import; must process in order

### 3.7 Reaction Cloning

**Problem**: Reactions cannot be backdated. Stoat reactions are user-specific — the bot can only add its own reactions, not reactions attributed to other users.

**Strategies:**
1. **Reaction summary in message content** (recommended for archive):
   ```
   Reactions: thumbs_up 12 | heart 5 | tada 3
   ```
   Only include if total reaction count >= 3 to avoid noise.
2. **Bot adds top reactions**: Bot adds the top 3 most-used reactions to the imported message. These will appear as bot reactions.
3. **Skip**: Don't import reactions at all (lowest complexity).

**API endpoints (if adding bot reactions):**
- Stoat: `PUT /channels/{ch}/messages/{msg}/reactions/{emoji}`
- Rate limit impact: Each reaction is an additional API call; adds ~1 second per reacted message.

**Complexity**: S (summary only), M (bot-adds), L (full reconstruction — impossible without user tokens)
**Dependencies**: Import phase completion

### 3.8 Attachment Re-hosting

**Technical approach:**
1. During export, for each message with attachments:
   a. Parse attachment metadata: `{ url, filename, size, content_type, width, height }`.
   b. Download from Discord CDN.
   c. Upload to Autumn: `POST /autumn/attachments` (multipart form).
   d. Store Autumn file ID in attachment metadata.
2. During import, include `attachments: [autumnFileId1, autumnFileId2, ...]` in message POST.
3. Track progress per attachment for resume capability.

**Database schema for attachment tracking:**
```sql
CREATE TABLE archive_attachments (
  discord_message_id TEXT NOT NULL,
  discord_attachment_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT,
  width INTEGER,
  height INTEGER,
  autumn_id TEXT,          -- populated after upload
  status TEXT DEFAULT 'pending',  -- pending, downloaded, uploaded, error
  error_message TEXT,
  PRIMARY KEY (discord_message_id, discord_attachment_id)
);
```

**Rate limits:**
- Discord CDN: Generally unrestricted for bot downloads.
- Autumn uploads: Undocumented rate limit. Testing suggests ~1 upload/second is safe.
- File size: Stoat default max is 20MB per file.

**Disk usage:**
- Temporary storage needed for download-before-upload.
- Streaming pipe (download → upload) would reduce disk usage but is harder with multipart uploads.
- Estimated: 10% of messages have attachments, average attachment 500KB. For 100K messages: ~5GB temporary disk.

**Complexity**: M (Medium)
**Dependencies**: Autumn CDN access

### 3.9 Embed Preservation

**Technical approach:**
1. Discord embeds to Stoat `SendableEmbed`:
   - Map: `title`, `description`, `url`, `icon_url`, `colour`.
   - Stoat supports at most 10 embeds per message.
   - Discord rich embeds with `fields[]` have no Stoat equivalent — flatten to description text.
2. Link preview embeds: Include URL in content, let Stoat generate its own preview.
3. Video/gifv embeds: Include URL as plain link.

**Known limitations:**
- Stoat embed format is simpler than Discord's rich embed.
- Image-only embeds: Include as attachment or URL.
- Embed thumbnails, footers, timestamps, and author fields have no Stoat equivalent.
- For archive purposes, a text fallback is safer than losing data.

**Complexity**: M (Medium)
**Dependencies**: None

### 3.10 Thread/Forum Post Handling

**Technical approach:**
1. **Active threads**: Discord API `guild.channels.fetchActiveThreads()`. Process each thread as a separate channel.
2. **Archived threads**: `channel.threads.fetchArchived()`. Same processing.
3. **Forum posts**: Each forum post is a thread. Process as standalone channels.
4. For each thread/post:
   a. Create a Stoat text channel named `thread-{threadName}` or `forum-{postTitle}`.
   b. Import all messages from the thread into the new Stoat channel.
   c. Link the thread starter message to the Stoat channel for reference.

**Discord API:**
- `guild.channels.fetchActiveThreads()` — returns all active threads.
- `channel.threads.fetchArchived({ type: 'public' | 'private', limit, before })` — paginated.
- Thread messages fetched same as channel messages.

**Known limitations:**
- Discord private threads require `ManageThreads` permission to access.
- Archived thread messages may be partially inaccessible.
- Stoat will show these as regular channels, not threaded conversations.

**Complexity**: L (Large)
**Dependencies**: Channel creation, message import pipeline

### 3.11 Progress Tracking, Resumability, and Checkpointing

**Database schema:**
```sql
CREATE TABLE archive_progress (
  discord_channel_id TEXT PRIMARY KEY,
  discord_channel_name TEXT,
  stoat_channel_id TEXT,
  total_messages INTEGER DEFAULT 0,
  exported_count INTEGER DEFAULT 0,
  imported_count INTEGER DEFAULT 0,
  last_export_cursor TEXT,   -- Discord message ID for export pagination
  last_import_cursor TEXT,   -- archive_messages row ID for import pagination
  status TEXT DEFAULT 'pending',  -- pending, exporting, exported, importing, done, error, paused
  error_message TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER DEFAULT (unixepoch())
);
```

**Checkpoint strategy:**
1. Export: Save `last_export_cursor` (Discord message ID) every 100 messages. On resume, `fetch({ before: cursor })`.
2. Import: Save `last_import_cursor` (archive_messages ID) every 50 messages. On resume, skip already-imported rows (`imported_at IS NOT NULL`).
3. Attachment re-hosting: Track per-attachment status. On resume, skip already-uploaded attachments.

**Error recovery:**
1. Transient errors (429, 500, network timeout): Retry 3 times with exponential backoff (1s, 2s, 4s).
2. Persistent errors: Mark channel as `error`, log the message, continue with next channel.
3. Manual retry: Command to retry a specific channel.

**Progress UI:**
1. Discord: Progress embed updated every 30 seconds with per-channel progress bars.
2. Bot API: `GET /api/archive/status` endpoint returning JSON progress.
3. Android app: Archive progress screen consuming the status API.
4. Console logs: Per-channel progress with ETA.

**Complexity**: M (Medium)
**Dependencies**: All other archive phases

### 3.12 Database Schema for Migration State

Complete proposed schema additions for the archive system:

```sql
-- Message staging table
CREATE TABLE archive_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL UNIQUE,
  discord_channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_display_name TEXT,
  author_avatar TEXT,          -- Discord avatar URL
  author_avatar_autumn TEXT,   -- Re-hosted Autumn ID
  author_bot INTEGER DEFAULT 0,
  author_webhook INTEGER DEFAULT 0,
  content TEXT,
  timestamp INTEGER NOT NULL,  -- Unix epoch seconds
  edited_timestamp INTEGER,
  reference_id TEXT,           -- Reply parent Discord message ID
  attachments TEXT,            -- JSON array
  embeds TEXT,                 -- JSON array
  reactions TEXT,              -- JSON array: [{emoji, count}]
  pinned INTEGER DEFAULT 0,
  message_type INTEGER DEFAULT 0,
  stoat_id TEXT,               -- Populated after import
  stoat_channel_id TEXT,
  exported_at INTEGER DEFAULT (unixepoch()),
  imported_at INTEGER
);

CREATE INDEX idx_archive_channel_ts ON archive_messages(discord_channel_id, timestamp);
CREATE INDEX idx_archive_reference ON archive_messages(reference_id);
CREATE INDEX idx_archive_stoat ON archive_messages(stoat_id);

-- Per-channel progress tracking
CREATE TABLE archive_progress (
  discord_channel_id TEXT PRIMARY KEY,
  discord_channel_name TEXT,
  stoat_channel_id TEXT,
  channel_type TEXT,           -- 'text', 'thread', 'forum_post'
  total_messages INTEGER DEFAULT 0,
  exported_count INTEGER DEFAULT 0,
  imported_count INTEGER DEFAULT 0,
  attachment_count INTEGER DEFAULT 0,
  attachment_uploaded INTEGER DEFAULT 0,
  last_export_cursor TEXT,
  last_import_cursor INTEGER,  -- archive_messages.id
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Attachment re-hosting tracking
CREATE TABLE archive_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_message_id TEXT NOT NULL,
  discord_attachment_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT,
  width INTEGER,
  height INTEGER,
  autumn_id TEXT,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(discord_message_id, discord_attachment_id)
);

CREATE INDEX idx_archive_att_msg ON archive_attachments(discord_message_id);

-- Author avatar re-hosting cache
CREATE TABLE archive_authors (
  discord_user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT,
  discriminator TEXT,
  avatar_url TEXT,
  avatar_autumn_id TEXT,      -- Re-hosted to Autumn
  is_bot INTEGER DEFAULT 0,
  is_webhook INTEGER DEFAULT 0,
  cached_at INTEGER DEFAULT (unixepoch())
);
```

### 3.13 Archive Command Interface

**Proposed Discord commands:**
- `/archive start` — Begin or resume archive migration for all linked channels.
- `/archive start channel:#specific-channel` — Archive a single channel.
- `/archive status` — Show per-channel progress.
- `/archive pause` — Pause the running archive.
- `/archive resume` — Resume a paused archive.
- `/archive retry channel:#channel` — Retry a failed channel.

**Proposed Bot API endpoints:**
- `POST /api/archive/start` — Start archive with options `{ channels?, includeThreads?, includeAttachments?, timestampFormat? }`.
- `GET /api/archive/status` — Per-channel progress JSON.
- `POST /api/archive/pause` — Pause.
- `POST /api/archive/resume` — Resume.

**Proposed Stoat commands:**
- `!stoatcord archive status` — Show progress in Stoat channel.

**Complexity**: M (Medium) for command interface
**Dependencies**: All archive phases

---

## Cross-System Dependencies

```
bridge_messages table ──────┬── Edit Sync
                            ├── Delete Sync
                            ├── Reaction Sync
                            ├── Reply Mirroring
                            ├── Outage Recovery
                            └── Thread Mirroring

channel_links (existing) ───┬── All bridge relay
                            ├── Thread-to-channel mapping
                            └── Archive channel targeting

archive_messages table ─────┬── Export pipeline
                            ├── Import pipeline
                            ├── Reply reconstruction
                            └── Attachment tracking

archive_progress table ─────┬── Resumability
                            ├── Progress UI
                            └── Error recovery

Autumn CDN upload ──────────┬── Bridge attachment re-hosting
                            ├── Archive attachment re-hosting
                            ├── Avatar re-hosting (archive)
                            └── Already used: emoji, icon, banner migration
```

### Implementation Order (Recommended)

**Phase 0 — Foundation (Week 1):**
1. Create `bridge_messages` table
2. Store message ID pairs on every bridge relay
3. Add webhook message edit capability

**Phase 1 — Bridge Essentials (Weeks 2-3):**
4. Message Edit Sync (M)
5. Message Delete Sync (S)
6. Reply Chain Mirroring (L)

**Phase 2 — Bridge Enhancements (Week 4):**
7. Attachment Re-hosting (M)
8. Outage Recovery Sync (L)

**Phase 3 — Migration Completion (Week 5):**
9. Per-channel permission overrides (M)
10. Missing permission mappings (S)
11. System message channels (S)

**Phase 4 — Archive MVP (Weeks 6-8):**
12. Export pipeline + `archive_messages` schema (M)
13. Import pipeline + `archive_progress` schema (L)
14. Timestamp preservation (S)
15. Progress tracking + resumability (M)

**Phase 5 — Archive Enhancements (Weeks 9-10):**
16. Attachment re-hosting for archive (M)
17. Reply chain reconstruction (M)
18. Thread/forum export+import (L)
19. Embed preservation (M)

**Phase 6 — Polish (Weeks 11-12):**
20. Reaction Sync (live bridge) (L)
21. Typing Indicators (S)
22. Channel Metadata Sync (M)
23. Archive commands + API + Android UI (M)

---

## API Reference Summary

### Stoat/Revolt API Endpoints Used or Needed

| Method | Path | Purpose | Rate Limit |
|---|---|---|---|
| `POST` | `/channels/{ch}/messages` | Send message (with masquerade) | 10/10s |
| `PATCH` | `/channels/{ch}/messages/{msg}` | Edit message | 20/10s (global) |
| `DELETE` | `/channels/{ch}/messages/{msg}` | Delete message | 20/10s (global) |
| `DELETE` | `/channels/{ch}/messages/bulk` | Bulk delete (<7 days) | 20/10s (global) |
| `GET` | `/channels/{ch}/messages` | Fetch messages (max 100) | 15/10s |
| `POST` | `/channels/{ch}/search` | Search messages | 15/10s |
| `PUT` | `/channels/{ch}/messages/{msg}/reactions/{emoji}` | Add reaction | 20/10s (global) |
| `DELETE` | `/channels/{ch}/messages/{msg}/reactions/{emoji}` | Remove reaction | 20/10s (global) |
| `POST` | `/channels/{ch}/messages/{msg}/pin` | Pin message | 20/10s (global) |
| `POST` | `/servers/{id}/channels` | Create channel | 5/10s |
| `PATCH` | `/channels/{ch}` | Edit channel | 15/10s |
| `PUT` | `/channels/{ch}/permissions/{role}` | Set channel perms | 15/10s |
| `PUT` | `/channels/{ch}/permissions/default` | Set default perms | 15/10s |
| `POST` | `/servers/{id}/roles` | Create role | 5/10s |
| `PATCH` | `/servers/{id}/roles/{role}` | Edit role | 5/10s |
| `PUT` | `/servers/{id}/permissions/{role}` | Set role perms | 5/10s |
| `PATCH` | `/servers/{id}` | Edit server | 5/10s |
| `PUT` | `/custom/emoji/{id}` | Create emoji | 20/10s (global) |
| `POST` | Autumn `/attachments` | Upload file | Undocumented |
| `POST` | Autumn `/icons` | Upload icon | Undocumented |
| `POST` | Autumn `/banners` | Upload banner | Undocumented |
| `POST` | Autumn `/emojis` | Upload emoji file | Undocumented |

### Discord API Endpoints/Events Used or Needed

| Type | Name | Purpose |
|---|---|---|
| Event | `MessageCreate` | Bridge relay trigger |
| Event | `messageUpdate` | Edit sync |
| Event | `messageDelete` | Delete sync |
| Event | `messageDeleteBulk` | Bulk delete sync |
| Event | `messageReactionAdd` | Reaction sync |
| Event | `messageReactionRemove` | Reaction sync |
| Event | `typingStart` | Typing indicators |
| Event | `channelUpdate` | Metadata sync |
| Event | `threadCreate` | Thread mirroring |
| API | `channel.messages.fetch()` | Export, gap recovery |
| API | `Message.edit()` | Edit relay |
| API | `Message.delete()` | Delete relay |
| API | `Message.react()` | Reaction relay |
| API | `channel.sendTyping()` | Typing relay |
| API | `channel.send({ files })` | Attachment relay |
| API | Webhook `PATCH /messages/{id}` | Edit webhook messages |
| API | Webhook `POST` with multipart | Attachment via webhook |
| API | `guild.channels.fetchActiveThreads()` | Thread discovery |
| API | `channel.threads.fetchArchived()` | Archived thread discovery |

### Stoat WebSocket Events Used or Needed

| Event | Status | Purpose |
|---|---|---|
| `Message` | Handled | Bridge relay, push notifications |
| `MessageUpdate` | Parsed but not used for relay | Edit sync |
| `MessageDelete` | Parsed but not used for relay | Delete sync |
| `MessageReact` | Not handled | Reaction sync |
| `MessageUnreact` | Not handled | Reaction sync |
| `ChannelStartTyping` | Not handled | Typing indicators |
| `ChannelUpdate` | Not handled | Metadata sync |
| `Ready` | Handled | Initialization |
| `Authenticated` | Handled | Auth confirmation |
| `Pong` | Handled | Keepalive |

---

## Appendix: Database Schema

### Existing Tables

| Table | Purpose | Key Fields |
|---|---|---|
| `schema_version` | Migration tracking | `version` |
| `server_links` | Guild-to-server mapping | `discord_guild_id`, `stoat_server_id`, `auth_method` |
| `channel_links` | Channel bridge pairs | `discord_channel_id`, `stoat_channel_id`, webhook creds |
| `role_links` | Role mapping | `discord_role_id`, `stoat_role_id` |
| `claim_codes` | One-time auth codes | `code`, `stoat_server_id`, audit fields |
| `migration_requests` | Live approval tracking | `id`, guild/server IDs, status, expiry |
| `migration_log` | Operation audit trail | `action`, `status`, `error_message` |
| `push_devices` | Push notification subscriptions | `stoat_user_id`, `device_id`, FCM/WebPush creds |

### Proposed New Tables

| Table | Purpose | System |
|---|---|---|
| `bridge_messages` | Discord-Stoat message ID pairs | Bridge (edit/delete/reaction sync) |
| `archive_messages` | Exported Discord message staging | Archive backlog |
| `archive_progress` | Per-channel export/import progress | Archive backlog |
| `archive_attachments` | Attachment re-hosting tracking | Archive backlog |
| `archive_authors` | Author avatar cache | Archive backlog |

---

## Sources

- [Revolt API GitHub Repository](https://github.com/revoltchat/api)
- [Revolt API Rate Limits Documentation](https://developers.stoat.chat/developers/api/ratelimits)
- [Revolt API Reference](https://developers.stoat.chat/developers/api/reference.html/)
- [Revolt OpenAPI Specification](https://github.com/revoltchat/api/blob/main/OpenAPI.json)
- [Revolt WebSocket Protocol Reference](https://developers.stoat.chat/developers/events/protocol.html)
- [Revolt Backend Repository](https://github.com/revoltchat/backend)
- [Channel Webhooks Issue](https://github.com/revoltchat/backend/issues/6)
