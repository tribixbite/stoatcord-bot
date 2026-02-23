/** Bidirectional message relay between Discord and Stoat */

import type { Message as DiscordMessage } from "discord.js";
import type { StoatClient } from "../stoat/client.ts";
import type { StoatWebSocket } from "../stoat/websocket.ts";
import type { Store } from "../db/store.ts";
import type {
  BonfireMessageEvent,
  BonfireMessageUpdateEvent,
  BonfireMessageDeleteEvent,
  BonfireMessageReactEvent,
  BonfireMessageUnreactEvent,
  BonfireChannelStartTypingEvent,
  BonfireChannelUpdateEvent,
  SendMessageRequest,
  User,
} from "../stoat/types.ts";
import {
  discordToRevolt,
  revoltToDiscord,
  truncateForRevolt,
  truncateForDiscord,
} from "./format.ts";
import {
  sendViaWebhook,
  editViaWebhook,
  deleteViaWebhook,
  type WebhookFile,
} from "./webhooks.ts";

// Track message IDs we've bridged to prevent echo loops
const recentBridgedIds = new Set<string>();
const BRIDGE_ID_TTL = 60_000; // 60 seconds

// Track edit IDs to prevent edit echo loops
const recentEditIds = new Set<string>();
const EDIT_ID_TTL = 10_000; // 10 seconds

// Track delete IDs to prevent delete echo loops
const recentDeleteIds = new Set<string>();
const DELETE_ID_TTL = 10_000; // 10 seconds

// Track reaction IDs to prevent reaction echo loops
const recentReactIds = new Set<string>();
const REACT_ID_TTL = 10_000; // 10 seconds

// Debounce typing events: max 1 per 5 seconds per user per channel
const typingDebounce = new Map<string, number>(); // "channelId:userId" → last sent timestamp
const TYPING_DEBOUNCE_MS = 5_000;

// Track channel metadata updates to prevent echo loops
const recentChannelUpdates = new Set<string>();
const CHANNEL_UPDATE_TTL = 10_000; // 10 seconds

// User cache to avoid repeated API lookups for display names/avatars
const userCache = new Map<string, { user: User; fetchedAt: number }>();
const USER_CACHE_TTL = 300_000; // 5 minutes

/** Resolve a Stoat user by ID, using cache to avoid excessive API calls */
async function resolveUser(
  userId: string,
  stoatClient: StoatClient
): Promise<User | null> {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < USER_CACHE_TTL) {
    return cached.user;
  }
  try {
    const user = await stoatClient.fetchUser(userId);
    userCache.set(userId, { user, fetchedAt: Date.now() });
    return user;
  } catch (err) {
    console.warn(`[bridge] Could not resolve user ${userId}:`, err);
    return null;
  }
}

function markBridged(id: string): void {
  recentBridgedIds.add(id);
  setTimeout(() => recentBridgedIds.delete(id), BRIDGE_ID_TTL);
}

function wasBridged(id: string): boolean {
  return recentBridgedIds.has(id);
}

function markEdited(id: string): void {
  recentEditIds.add(id);
  setTimeout(() => recentEditIds.delete(id), EDIT_ID_TTL);
}

function wasEdited(id: string): boolean {
  return recentEditIds.has(id);
}

function markDeleted(id: string): void {
  recentDeleteIds.add(id);
  setTimeout(() => recentDeleteIds.delete(id), DELETE_ID_TTL);
}

function wasDeleted(id: string): boolean {
  return recentDeleteIds.has(id);
}

function markReacted(key: string): void {
  recentReactIds.add(key);
  setTimeout(() => recentReactIds.delete(key), REACT_ID_TTL);
}

function wasReacted(key: string): boolean {
  return recentReactIds.has(key);
}

function markChannelUpdated(id: string): void {
  recentChannelUpdates.add(id);
  setTimeout(() => recentChannelUpdates.delete(id), CHANNEL_UPDATE_TTL);
}

function wasChannelUpdated(id: string): boolean {
  return recentChannelUpdates.has(id);
}

/** Check if a typing event should be sent (debounce: 1 per 5s per user per channel) */
function shouldSendTyping(channelId: string, userId: string): boolean {
  const key = `${channelId}:${userId}`;
  const now = Date.now();
  const last = typingDebounce.get(key);
  if (last && now - last < TYPING_DEBOUNCE_MS) return false;
  typingDebounce.set(key, now);
  return true;
}

/**
 * Relay a Discord message to the linked Stoat channel.
 * Uses masquerade to show the Discord user's name and avatar.
 * Stores the message ID pair in bridge_messages for edit/delete sync.
 */
export async function relayDiscordToStoat(
  message: DiscordMessage,
  stoatChannelId: string,
  stoatClient: StoatClient,
  store: Store
): Promise<void> {
  if (!message.content && message.attachments.size === 0) return;

  // Build content
  let content = message.content
    ? discordToRevolt(message.content)
    : "";

  // Re-host Discord attachments to Stoat Autumn CDN
  const autumnIds: string[] = [];
  for (const attachment of message.attachments.values()) {
    // Skip files over 20MB (Autumn upload limit)
    if (attachment.size > 20 * 1024 * 1024) {
      content += `\n${attachment.url}`;
      continue;
    }
    try {
      const fileData = await fetch(attachment.url);
      if (!fileData.ok) {
        content += `\n${attachment.url}`;
        continue;
      }
      const buffer = new Uint8Array(await fileData.arrayBuffer());
      const uploaded = await stoatClient.uploadFile(
        "attachments",
        buffer,
        attachment.name ?? "attachment"
      );
      autumnIds.push(uploaded.id);
    } catch (err) {
      // Fallback to URL if upload fails
      console.warn("[bridge] Attachment re-host failed, using URL fallback:", err);
      content += `\n${attachment.url}`;
    }
  }

  content = truncateForRevolt(content.trim());
  if (!content && autumnIds.length === 0) return;

  const avatarUrl = message.author.displayAvatarURL({
    size: 256,
    extension: "png",
  });

  // Resolve reply chain: if this message replies to another, look up the Stoat counterpart
  const sendOpts: Partial<Omit<SendMessageRequest, "content">> = {
    masquerade: {
      name: message.author.displayName || message.author.username,
      avatar: avatarUrl,
    },
  };

  if (message.reference?.messageId) {
    const parentMapping = store.getBridgeMessageByDiscordId(message.reference.messageId);
    if (parentMapping) {
      // Link as a proper Stoat reply
      sendOpts.replies = [{ id: parentMapping.stoat_message_id, mention: false }];
    } else {
      // Parent not in bridge_messages — prepend a quote-style fallback
      content = `> *Replying to a message*\n${content}`;
      content = truncateForRevolt(content);
    }
  }

  // Attach re-hosted files if any
  if (autumnIds.length > 0) {
    sendOpts.attachments = autumnIds;
  }

  const sent = await stoatClient.sendMessage(stoatChannelId, content || " ", sendOpts);

  // Mark as bridged so we don't echo it back
  if (sent._id) {
    markBridged(sent._id);
    // Store the ID pair for edit/delete/reaction sync
    store.storeBridgeMessage(
      message.id,
      sent._id,
      message.channelId,
      stoatChannelId,
      "d2s"
    );
    // Track for outage recovery
    store.updateLastBridged(message.channelId, message.id, sent._id);
  }
}

/**
 * Set up Stoat→Discord relay by listening on the Stoat WebSocket.
 * When a message arrives in a linked Stoat channel, forward it to Discord via webhook.
 */
export function setupStoatToDiscordRelay(
  stoatWs: StoatWebSocket,
  store: Store,
  stoatCdnUrl: string,
  stoatClient?: StoatClient,
  discordClient?: import("discord.js").Client
): void {
  stoatWs.on("message", async (event: BonfireMessageEvent) => {
    // Skip messages we bridged TO Stoat (prevent echo)
    if (wasBridged(event._id)) return;

    // Check if this Stoat channel is linked
    const link = store.getChannelByStoatId(event.channel);
    if (!link) return;

    // Need webhook credentials to post to Discord
    if (!link.discord_webhook_id || !link.discord_webhook_token) {
      console.warn(
        `[bridge] Stoat channel ${event.channel} linked but no webhook configured`
      );
      return;
    }

    // Skip masqueraded messages (already bridged from Discord)
    if (event.masquerade) return;

    let content = event.content ?? "";
    if (!content && (!event.attachments || event.attachments.length === 0))
      return;

    content = revoltToDiscord(content);

    // Handle reply chain: if Stoat message replies to another, prepend a quote
    // (Webhook messages can't use Discord's message_reference natively)
    if (event.replies && event.replies.length > 0) {
      const parentStoatId = event.replies[0]!;
      const parentMapping = store.getBridgeMessageByStoatId(parentStoatId);
      if (parentMapping) {
        // Reference the Discord message in a quote-style prefix
        content = `> *Replying to [message](https://discord.com/channels/@me/${link.discord_channel_id}/${parentMapping.discord_message_id})*\n${content}`;
      } else {
        content = `> *Replying to a message*\n${content}`;
      }
    }

    // Re-host Stoat attachments to Discord via webhook multipart
    const webhookFiles: Array<{ data: Uint8Array; name: string }> = [];
    if (event.attachments) {
      for (const att of event.attachments) {
        const attUrl = `${stoatCdnUrl}/attachments/${att._id}/${att.filename}`;
        try {
          const res = await fetch(attUrl);
          if (res.ok) {
            const buffer = new Uint8Array(await res.arrayBuffer());
            // Discord webhook max 25MB per file (8MB for free bots, but webhooks allow 25MB)
            if (buffer.length <= 25 * 1024 * 1024) {
              webhookFiles.push({ data: buffer, name: att.filename });
              continue;
            }
          }
        } catch (err) {
          console.warn("[bridge] Stoat attachment re-host failed:", err);
        }
        // Fallback to URL if download/size fails
        content += `\n${attUrl}`;
      }
    }

    content = truncateForDiscord(content.trim());
    if (!content && webhookFiles.length === 0) return;

    // Resolve user display name and avatar from Stoat API (cached)
    let username = "stoat-user";
    let avatarUrl: string | undefined;
    if (stoatClient) {
      const user = await resolveUser(event.author, stoatClient);
      if (user) {
        username = user.display_name || user.username;
        if (user.avatar) {
          avatarUrl = `${stoatCdnUrl}/avatars/${user.avatar._id}`;
        }
      }
    }

    try {
      const discordMsgId = await sendViaWebhook(
        link.discord_webhook_id,
        link.discord_webhook_token,
        username,
        avatarUrl,
        content || " ",
        webhookFiles.length > 0 ? webhookFiles : undefined
      );
      // Store the ID pair for edit/delete/reaction sync
      store.storeBridgeMessage(
        discordMsgId,
        event._id,
        link.discord_channel_id,
        event.channel,
        "s2d"
      );
      // Track for outage recovery
      store.updateLastBridged(link.discord_channel_id, discordMsgId, event._id);
    } catch (err) {
      console.error("[bridge] Stoat→Discord relay error:", err);
    }
  });

  // --- Stoat→Discord edit sync ---
  stoatWs.on("messageUpdate", async (event: BonfireMessageUpdateEvent) => {
    // Skip edits we initiated (from Discord→Stoat edit relay)
    if (wasEdited(event.id)) return;

    // Only sync content changes
    if (!event.data.content) return;

    const mapping = store.getBridgeMessageByStoatId(event.id);
    if (!mapping) return;

    const link = store.getChannelByStoatId(event.channel);
    if (!link?.discord_webhook_id || !link?.discord_webhook_token) return;

    const content = truncateForDiscord(revoltToDiscord(event.data.content));
    if (!content) return;

    try {
      markEdited(mapping.discord_message_id);
      await editViaWebhook(
        link.discord_webhook_id,
        link.discord_webhook_token,
        mapping.discord_message_id,
        content
      );
    } catch (err) {
      console.error("[bridge] Stoat→Discord edit sync error:", err);
    }
  });

  // --- Stoat→Discord delete sync ---
  stoatWs.on("messageDelete", async (event: BonfireMessageDeleteEvent) => {
    // Skip deletes we initiated (from Discord→Stoat delete relay)
    if (wasDeleted(event.id)) return;

    const mapping = store.getBridgeMessageByStoatId(event.id);
    if (!mapping) return;

    const link = store.getChannelByStoatId(event.channel);
    if (!link?.discord_webhook_id || !link?.discord_webhook_token) return;

    try {
      markDeleted(mapping.discord_message_id);
      await deleteViaWebhook(
        link.discord_webhook_id,
        link.discord_webhook_token,
        mapping.discord_message_id
      );
      store.deleteBridgeMessageByStoatId(event.id);
    } catch (err) {
      console.error("[bridge] Stoat→Discord delete sync error:", err);
    }
  });

  // --- Stoat→Discord typing relay ---
  stoatWs.on("channelStartTyping", async (event: BonfireChannelStartTypingEvent) => {
    if (!discordClient) return;

    const link = store.getChannelByStoatId(event.id);
    if (!link) return;

    // Debounce: max 1 per 5s per user per channel
    if (!shouldSendTyping(event.id, event.user)) return;

    try {
      const channel = await discordClient.channels.fetch(link.discord_channel_id);
      if (channel?.isTextBased() && "sendTyping" in channel) {
        await (channel as import("discord.js").TextChannel).sendTyping();
      }
    } catch (err) {
      // Typing failures are non-critical — just log and move on
      console.warn("[bridge] Stoat→Discord typing relay error:", err);
    }
  });

  // --- Stoat→Discord reaction sync ---
  stoatWs.on("messageReact", async (event: BonfireMessageReactEvent) => {
    const reactKey = `${event.id}:${event.emoji_id}:add`;
    if (wasReacted(reactKey)) return;

    const mapping = store.getBridgeMessageByStoatId(event.id);
    if (!mapping) return;

    if (!discordClient) return;

    try {
      const channel = await discordClient.channels.fetch(mapping.discord_channel_id);
      if (!channel?.isTextBased()) return;
      const message = await (channel as import("discord.js").TextChannel).messages.fetch(mapping.discord_message_id);
      // Stoat emoji_id is either a Unicode char or a custom emoji ID
      // For custom emojis, try to find by name from the guild
      markReacted(reactKey);
      await message.react(event.emoji_id);
    } catch (err) {
      console.warn("[bridge] Stoat→Discord reaction sync error:", err);
    }
  });

  stoatWs.on("messageUnreact", async (event: BonfireMessageUnreactEvent) => {
    const reactKey = `${event.id}:${event.emoji_id}:remove`;
    if (wasReacted(reactKey)) return;

    const mapping = store.getBridgeMessageByStoatId(event.id);
    if (!mapping) return;

    if (!discordClient) return;

    try {
      const channel = await discordClient.channels.fetch(mapping.discord_channel_id);
      if (!channel?.isTextBased()) return;
      const message = await (channel as import("discord.js").TextChannel).messages.fetch(mapping.discord_message_id);
      // Remove the bot's own reaction (can only remove self reactions without Manage Messages)
      const reaction = message.reactions.cache.get(event.emoji_id);
      if (reaction?.me) {
        markReacted(reactKey);
        await reaction.users.remove(discordClient.user!.id);
      }
    } catch (err) {
      console.warn("[bridge] Stoat→Discord unreact sync error:", err);
    }
  });

  // --- Stoat→Discord channel metadata sync ---
  stoatWs.on("channelUpdate", async (event: BonfireChannelUpdateEvent) => {
    if (wasChannelUpdated(event.id)) return;

    const link = store.getChannelByStoatId(event.id);
    if (!link) return;

    if (!discordClient) return;

    // Only sync name, description, nsfw changes
    const { data } = event;
    if (!data.name && !data.description && data.nsfw === undefined && !event.clear?.length) return;

    try {
      const channel = await discordClient.channels.fetch(link.discord_channel_id);
      if (!channel || !("edit" in channel)) return;

      const editData: Record<string, unknown> = {};
      if (data.name) editData.name = data.name.slice(0, 100); // Discord max 100 chars
      if (data.description !== undefined) editData.topic = data.description;
      if (data.nsfw !== undefined) editData.nsfw = data.nsfw;
      // Handle cleared fields
      if (event.clear?.includes("Description")) editData.topic = "";

      if (Object.keys(editData).length === 0) return;

      markChannelUpdated(link.discord_channel_id);
      await (channel as import("discord.js").TextChannel).edit(editData);
    } catch (err) {
      console.error("[bridge] Stoat→Discord channel metadata sync error:", err);
    }
  });
}

/**
 * Relay a Discord message edit to the linked Stoat channel.
 * Called from events.ts on messageUpdate.
 */
export async function relayDiscordEditToStoat(
  messageId: string,
  newContent: string,
  store: Store,
  stoatClient: StoatClient
): Promise<void> {
  // Skip edits we initiated (from Stoat→Discord edit relay)
  if (wasEdited(messageId)) return;

  const mapping = store.getBridgeMessageByDiscordId(messageId);
  if (!mapping) return;

  const content = truncateForRevolt(discordToRevolt(newContent));
  if (!content) return;

  try {
    markEdited(mapping.stoat_message_id);
    await stoatClient.editMessage(
      mapping.stoat_channel_id,
      mapping.stoat_message_id,
      content
    );
  } catch (err) {
    console.error("[bridge] Discord→Stoat edit sync error:", err);
  }
}

/**
 * Relay a Discord message deletion to the linked Stoat channel.
 * Called from events.ts on messageDelete.
 */
export async function relayDiscordDeleteToStoat(
  messageId: string,
  store: Store,
  stoatClient: StoatClient
): Promise<void> {
  // Skip deletes we initiated (from Stoat→Discord delete relay)
  if (wasDeleted(messageId)) return;

  const mapping = store.getBridgeMessageByDiscordId(messageId);
  if (!mapping) return;

  try {
    markDeleted(mapping.stoat_message_id);
    await stoatClient.deleteMessage(
      mapping.stoat_channel_id,
      mapping.stoat_message_id
    );
    store.deleteBridgeMessage(messageId);
  } catch (err) {
    console.error("[bridge] Discord→Stoat delete sync error:", err);
  }
}

/**
 * Relay a Discord typing indicator to the linked Stoat channel.
 * Debounced: max 1 per 5 seconds per user per channel.
 */
export async function relayDiscordTypingToStoat(
  discordChannelId: string,
  discordUserId: string,
  stoatChannelId: string,
  stoatClient: StoatClient
): Promise<void> {
  if (!shouldSendTyping(discordChannelId, discordUserId)) return;
  try {
    await stoatClient.beginTyping(stoatChannelId);
  } catch {
    // Typing failures are non-critical — silently ignore
  }
}

/**
 * Relay a Discord reaction to the linked Stoat message.
 * Called from events.ts on messageReactionAdd.
 */
export async function relayDiscordReactionToStoat(
  messageId: string,
  emojiIdentifier: string,
  store: Store,
  stoatClient: StoatClient
): Promise<void> {
  const reactKey = `${messageId}:${emojiIdentifier}:add`;
  if (wasReacted(reactKey)) return;

  const mapping = store.getBridgeMessageByDiscordId(messageId);
  if (!mapping) return;

  try {
    markReacted(reactKey);
    await stoatClient.reactToMessage(
      mapping.stoat_channel_id,
      mapping.stoat_message_id,
      emojiIdentifier
    );
  } catch (err) {
    console.warn("[bridge] Discord→Stoat reaction sync error:", err);
  }
}

/**
 * Relay a Discord reaction removal to the linked Stoat message.
 * Called from events.ts on messageReactionRemove.
 */
export async function relayDiscordUnreactionToStoat(
  messageId: string,
  emojiIdentifier: string,
  store: Store,
  stoatClient: StoatClient
): Promise<void> {
  const reactKey = `${messageId}:${emojiIdentifier}:remove`;
  if (wasReacted(reactKey)) return;

  const mapping = store.getBridgeMessageByDiscordId(messageId);
  if (!mapping) return;

  try {
    markReacted(reactKey);
    await stoatClient.unreactToMessage(
      mapping.stoat_channel_id,
      mapping.stoat_message_id,
      emojiIdentifier
    );
  } catch (err) {
    console.warn("[bridge] Discord→Stoat unreaction sync error:", err);
  }
}

/**
 * Relay a Discord channel metadata update to the linked Stoat channel.
 * Syncs name, description/topic, and NSFW flag.
 */
export async function relayDiscordChannelUpdateToStoat(
  oldChannel: import("discord.js").GuildChannel,
  newChannel: import("discord.js").GuildChannel,
  stoatChannelId: string,
  stoatClient: StoatClient
): Promise<void> {
  // Skip if this was an echo from our own Stoat→Discord sync
  if (wasChannelUpdated(newChannel.id)) return;

  const editData: Record<string, unknown> = {};

  if (oldChannel.name !== newChannel.name) {
    // Stoat channel names max 32 chars
    editData.name = newChannel.name.slice(0, 32);
  }

  // Topic is on TextChannel, not GuildChannel
  if ("topic" in oldChannel && "topic" in newChannel) {
    const oldTopic = (oldChannel as import("discord.js").TextChannel).topic;
    const newTopic = (newChannel as import("discord.js").TextChannel).topic;
    if (oldTopic !== newTopic) {
      editData.description = newTopic ?? "";
    }
  }

  if ("nsfw" in oldChannel && "nsfw" in newChannel) {
    const oldNsfw = (oldChannel as import("discord.js").TextChannel).nsfw;
    const newNsfw = (newChannel as import("discord.js").TextChannel).nsfw;
    if (oldNsfw !== newNsfw) {
      editData.nsfw = newNsfw;
    }
  }

  if (Object.keys(editData).length === 0) return;

  try {
    markChannelUpdated(stoatChannelId);
    await stoatClient.editChannel(stoatChannelId, editData);
  } catch (err) {
    console.error("[bridge] Discord→Stoat channel metadata sync error:", err);
  }
}
