# Discord ↔ Stoat Bridge — Feature Roadmap

## Current State

The bridge currently handles:
- Text message relay in both directions (Discord → Stoat via masquerade, Stoat → Discord via webhooks)
- Attachment URLs appended to message content
- Markdown conversion (Discord spoilers `||text||` ↔ Revolt spoilers `!!text!!`)
- Echo prevention via `recentBridgedIds` set with 60-second TTL
- User avatar/name forwarding through masquerade (Stoat) and webhooks (Discord)
- 2000-char truncation with ellipsis on both platforms

### Known Limitations
- Message edits are not synced
- Message deletes are not relayed
- Reactions are not forwarded
- Reply chains and threads are not mirrored
- Media is linked by URL only — not re-hosted
- Custom emoji references are stripped (different ID namespaces)
- User mentions are stripped (no cross-platform user mapping)

---

## Phase 1: Message Edit Sync

**Complexity: Medium** | **Dependencies: New DB table**

Track bridged message ID pairs and relay edits in both directions.

### Implementation
1. Create `bridge_messages` table:
   ```sql
   CREATE TABLE bridge_messages (
     discord_message_id TEXT NOT NULL,
     stoat_message_id TEXT NOT NULL,
     discord_channel_id TEXT NOT NULL,
     stoat_channel_id TEXT NOT NULL,
     created_at INTEGER DEFAULT (unixepoch()),
     PRIMARY KEY (discord_message_id, stoat_message_id)
   );
   CREATE INDEX idx_bridge_discord ON bridge_messages(discord_message_id);
   CREATE INDEX idx_bridge_stoat ON bridge_messages(stoat_message_id);
   ```
2. On message relay, insert mapping into `bridge_messages`
3. Listen for Discord `messageUpdate` event → look up Stoat counterpart → `PATCH /channels/{ch}/messages/{msg}`
4. Listen for Stoat `MessageUpdate` WS event → look up Discord counterpart → `channel.messages.edit()`

### API Endpoints
- Discord: `messageUpdate` event, `Message.edit()` method
- Stoat: `MessageUpdate` WS event, `PATCH /channels/{channel_id}/messages/{message_id}` with `{ content }`

### Considerations
- Only sync content changes, not embed updates
- Rate limit edits (debounce rapid edits, 1s cooldown)
- Add edit indicator to bridged messages: `(edited)` suffix
- TTL for bridge_messages rows: prune after 30 days to control DB size

---

## Phase 2: Message Delete Sync

**Complexity: Low** | **Dependencies: Phase 1 (bridge_messages table)**

Relay message deletions in both directions.

### Implementation
1. Listen for Discord `messageDelete` event → look up Stoat counterpart → `DELETE /channels/{ch}/messages/{msg}`
2. Listen for Stoat `MessageDelete` WS event → look up Discord counterpart → `channel.messages.delete()`
3. Clean up `bridge_messages` row after deletion
4. Handle Discord `messageDeleteBulk` for mass-delete operations

### API Endpoints
- Discord: `messageDelete` / `messageDeleteBulk` events, `Message.delete()` method
- Stoat: `MessageDelete` WS event, `DELETE /channels/{channel_id}/messages/{message_id}`

### Considerations
- Prevent echo: if we deleted the bridged copy, don't re-trigger delete relay
- Log deletions for audit trail
- Bulk deletes on Discord (purge) could hit Stoat rate limits — queue with delays

---

## Phase 3: Reaction Sync

**Complexity: High** | **Dependencies: Phase 1 (bridge_messages table)**

Map emoji between platforms and relay reaction add/remove events.

### Implementation
1. Build emoji mapping table:
   - Unicode emoji: 1:1 mapping (both platforms use standard unicode)
   - Custom emoji: match by name (Discord `:stoat:` ↔ Stoat `:stoat:`)
   - Unmapped custom emoji: skip or use fallback unicode
2. Listen for Discord `messageReactionAdd`/`messageReactionRemove` events
3. Listen for Stoat `MessageReact`/`MessageUnreact` WS events
4. Relay via:
   - Stoat: `PUT /channels/{ch}/messages/{msg}/reactions/{emoji_id}`
   - Discord: `message.react(emoji)` / `reaction.remove()`

### API Endpoints
- Discord: `messageReactionAdd`, `messageReactionRemove` events
- Stoat: `MessageReact`, `MessageUnreact` WS events
- Stoat: `PUT /channels/{ch}/messages/{msg}/reactions/{emoji}`, `DELETE` same

### Considerations
- Bot's own reactions must be excluded from echo prevention
- Stoat uses emoji IDs for custom, unicode strings for standard
- Rate limits: reactions are heavily rate-limited on both platforms
- Consider a reaction count threshold — don't sync if >50 reactions on a message
- Initial implementation: unicode only; custom emoji in a sub-phase

---

## Phase 4: Reply/Thread Mirroring

**Complexity: High** | **Dependencies: Phase 1 (bridge_messages table)**

Preserve reply chains across platforms and handle thread/channel creation.

### Implementation
1. **Replies**: When a message references another message:
   - Look up the referenced message's bridged counterpart in `bridge_messages`
   - Set `replies` field on Stoat message or `message_reference` on Discord message
2. **Threads**: Map Discord threads to Stoat text channels (or vice versa)
   - Discord thread → create Stoat text channel in same category
   - Stoat channel → create Discord thread (if parent is text channel)
3. Store thread/channel pairs in `channel_links` with a `thread` flag

### API Endpoints
- Stoat: `POST /channels/{ch}/messages` with `replies: [{ id, mention }]`
- Discord: `channel.send({ reply: { messageReference: id } })`
- Discord: `message.startThread()`, `ThreadChannel`

### Considerations
- Thread lifecycle: auto-archive, unarchive, delete
- Nested threads not supported on Stoat
- Forum channels: Discord forum posts → Stoat text channels
- Quote-style fallback if referenced message not in bridge_messages

---

## Phase 5: Attachment/Embed Improvements

**Complexity: Medium** | **Dependencies: None**

Re-host attachments and preserve embed metadata.

### Implementation
1. **Attachment re-hosting**:
   - Download Discord attachment from CDN URL
   - Upload to Stoat Autumn CDN via `POST /autumn/attachments`
   - Replace URL in bridged message with Autumn URL
   - Reverse: download Stoat attachment, upload to Discord via `channel.send({ files })`
2. **Embed forwarding**:
   - Discord rich embeds → Stoat SendableEmbed array
   - Stoat embeds → Discord embed objects
   - Preserve title, description, URL, thumbnail, colour

### API Endpoints
- Stoat: `POST /autumn/attachments` (multipart upload)
- Discord: `MessagePayload.files` for attachment upload
- Both: embed objects in message payload

### Considerations
- File size limits: Discord 25MB (free) / 100MB (boost), Stoat varies by server
- Image dimension metadata preservation
- Rate limiting on CDN uploads
- Consider caching re-hosted URLs to avoid duplicate uploads on edits

---

## Phase 6: User Presence/Typing Indicators

**Complexity: Low** | **Dependencies: None**

Forward typing indicators between platforms.

### Implementation
1. Listen for Discord `typingStart` event → `POST /channels/{ch}/typing` on Stoat
2. Listen for Stoat `ChannelStartTyping` WS event → `channel.sendTyping()` on Discord
3. Debounce to avoid spam (max 1 typing event per 5 seconds per user per channel)

### API Endpoints
- Stoat: `POST /channels/{ch}/typing`
- Discord: `TextChannel.sendTyping()`

### Considerations
- Typing indicators are ephemeral — no persistence needed
- Don't forward bot typing (could cause loops)
- Low priority feature — nice-to-have, not critical

---

## Phase 7: Channel Metadata Sync

**Complexity: Medium** | **Dependencies: None**

Keep channel names, topics, and settings in sync.

### Implementation
1. Listen for Discord `channelUpdate` event → `PATCH /channels/{ch}` on Stoat
2. Listen for Stoat `ChannelUpdate` WS event → `channel.edit()` on Discord
3. Sync: name, topic/description, NSFW flag, slowmode (if supported)

### API Endpoints
- Stoat: `PATCH /channels/{ch}` with `{ name, description, nsfw }`
- Discord: `channel.edit({ name, topic, nsfw, rateLimitPerUser })`

### Considerations
- Only sync linked channels
- Conflict resolution: last-write-wins
- Audit log entries for metadata changes
- Permission changes are too complex for automatic sync — manual only

---

## Priority Order

| Phase | Feature | Complexity | Impact |
|-------|---------|------------|--------|
| 1 | Message Edit Sync | Medium | High |
| 2 | Message Delete Sync | Low | High |
| 3 | Reaction Sync | High | Medium |
| 5 | Attachment Re-hosting | Medium | Medium |
| 4 | Reply/Thread Mirroring | High | Medium |
| 6 | Typing Indicators | Low | Low |
| 7 | Channel Metadata Sync | Medium | Low |

Phases 1 and 2 should be implemented together (both need `bridge_messages` table). Phase 3 and 4 can be done in either order. Phase 5 is independent. Phases 6 and 7 are polish features.
