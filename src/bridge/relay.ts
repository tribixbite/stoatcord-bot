/** Bidirectional message relay between Discord and Stoat */

import type { Message as DiscordMessage } from "discord.js";
import type { StoatClient } from "../stoat/client.ts";
import type { StoatWebSocket } from "../stoat/websocket.ts";
import type { Store } from "../db/store.ts";
import type {
  BonfireMessageEvent,
  BonfireMessageUpdateEvent,
  BonfireMessageDeleteEvent,
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
  stoatClient?: StoatClient
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
