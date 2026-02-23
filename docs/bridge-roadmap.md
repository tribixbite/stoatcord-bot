# Discord ↔ Stoat Bridge — Feature Roadmap

## Current State (February 2026)

The bridge handles full bidirectional sync between Discord and Stoat:

### Implemented
- **Text message relay** — Discord → Stoat via masquerade, Stoat → Discord via webhooks
- **Message edit sync** — edits relayed in both directions via `bridge_messages` table
- **Message delete sync** — deletes relayed including Discord bulk delete
- **Reaction sync** — bidirectional emoji reaction forwarding with echo prevention
- **Typing indicators** — relayed both ways with 5-second per-user debounce
- **Channel metadata sync** — name, topic, NSFW flag synced bidirectionally
- **Reply chain mirroring** — replies reference the bridged counterpart, quote-style fallback for unmapped parents
- **Attachment re-hosting** — Discord CDN → Stoat Autumn CDN via `POST /autumn/attachments`
- **Markdown conversion** — Discord spoilers `||text||` ↔ Revolt spoilers `!!text!!`
- **Echo prevention** — TTL-based sets for messages, reactions, channel updates; debounce map for typing
- **User identity forwarding** — avatars + usernames via masquerade (Stoat) and webhooks (Discord)
- **2000-char truncation** with ellipsis on both platforms
- **Outage recovery** — replays missed messages on WebSocket reconnect via `last_bridged_*` tracking

### Architecture
```
bridge_messages table (30-day TTL, auto-pruned at startup)
├── discord_message_id ↔ stoat_message_id mapping
├── Enables edit/delete/reaction sync
└── Indexed on both IDs for fast lookup

Echo prevention (in-memory)
├── recentBridgedIds: Set<string> — 60s TTL per message
├── recentReactIds: Set<string> — 10s TTL per reaction
├── typingDebounce: Map<string, number> — 5s per user/channel
└── recentChannelUpdates: Set<string> — 30s TTL per channel
```

---

## Remaining Work

### Thread Mirroring (High Complexity)

Threads are not bridged. Discord threads have no direct Stoat equivalent.

**Approach options:**
1. **Map threads to Stoat channels** — create a text channel per thread, link in `channel_links` with a `thread` flag
2. **Flatten threads** — relay thread messages into the parent channel with a `[thread: name]` prefix
3. **Skip** — only bridge top-level channels

**Challenges:**
- Thread lifecycle management (archive, unarchive, delete)
- Forum posts — each forum post is a thread
- Nested threads not supported on Stoat
- Auto-archiving changes thread accessibility

**Recommendation:** Option 2 (flatten) as default with option 1 available for high-traffic threads.

### Custom Emoji Mapping (Medium Complexity)

Currently unicode emoji sync 1:1. Custom emoji references are name-matched but may fail if names differ between platforms.

**Remaining:**
- Build a persistent emoji mapping table (Discord emoji ID ↔ Stoat emoji ID)
- Populate during `/migrate` when emoji are copied
- Fall back to `:emoji_name:` text when no mapping exists
- Consider uploading missing custom emoji to the other platform

### Embed Forwarding Improvements (Low Complexity)

Discord rich embeds are partially forwarded. Remaining:
- Convert Discord embed objects to Stoat `SendableEmbed` format
- Handle multiple embeds per message (Stoat supports one — merge or pick primary)
- Video/gifv embeds → plain URL links
- Image embeds → re-host and attach

### User Mention Mapping (Medium Complexity)

Cross-platform mentions are stripped (different user ID namespaces).

**Approach:**
- Build a user mapping table during migration (Discord user ID ↔ Stoat user ID)
- Replace `<@discord_id>` with `<@stoat_id>` in bridged messages and vice versa
- Only works for users present on both platforms
- Fallback: `@username` plain text for unmapped users

### Slowmode/Permission Sync (Low Priority)

- Channel slowmode settings could be synced
- Permission overwrites too complex for automatic sync — keep manual

---

## Priority Order

| Feature | Complexity | Impact | Status |
|---------|------------|--------|--------|
| Message relay | Medium | Critical | Done |
| Edit/delete sync | Medium | High | Done |
| Reaction sync | High | Medium | Done |
| Typing indicators | Low | Low | Done |
| Channel metadata sync | Medium | Low | Done |
| Reply mirroring | Medium | High | Done |
| Attachment re-hosting | Medium | Medium | Done |
| Outage recovery | Medium | High | Done |
| Thread mirroring | High | Medium | Planned |
| Custom emoji mapping | Medium | Medium | Planned |
| Embed forwarding | Low | Low | Planned |
| User mention mapping | Medium | Medium | Planned |
| Slowmode/permission sync | Low | Low | Deferred |
