/** Bidirectional message relay between Discord and Stoat */

import type { Message as DiscordMessage } from "discord.js";
import type { StoatClient } from "../stoat/client.ts";
import type { StoatWebSocket } from "../stoat/websocket.ts";
import type { Store } from "../db/store.ts";
import type { BonfireMessageEvent } from "../stoat/types.ts";
import {
  discordToRevolt,
  revoltToDiscord,
  truncateForRevolt,
  truncateForDiscord,
} from "./format.ts";
import { sendViaWebhook } from "./webhooks.ts";

// Track message IDs we've bridged to prevent echo loops
const recentBridgedIds = new Set<string>();
const BRIDGE_ID_TTL = 60_000; // 60 seconds

function markBridged(id: string): void {
  recentBridgedIds.add(id);
  setTimeout(() => recentBridgedIds.delete(id), BRIDGE_ID_TTL);
}

function wasBridged(id: string): boolean {
  return recentBridgedIds.has(id);
}

/**
 * Relay a Discord message to the linked Stoat channel.
 * Uses masquerade to show the Discord user's name and avatar.
 */
export async function relayDiscordToStoat(
  message: DiscordMessage,
  stoatChannelId: string,
  stoatClient: StoatClient
): Promise<void> {
  if (!message.content && message.attachments.size === 0) return;

  // Build content with attachment URLs appended
  let content = message.content
    ? discordToRevolt(message.content)
    : "";

  // Append attachment URLs (Revolt will auto-embed images/videos)
  for (const attachment of message.attachments.values()) {
    content += `\n${attachment.url}`;
  }

  content = truncateForRevolt(content.trim());
  if (!content) return;

  const avatarUrl = message.author.displayAvatarURL({
    size: 256,
    extension: "png",
  });

  const sent = await stoatClient.sendMessage(stoatChannelId, content, {
    masquerade: {
      name: message.author.displayName || message.author.username,
      avatar: avatarUrl,
    },
  });

  // Mark as bridged so we don't echo it back
  if (sent._id) {
    markBridged(sent._id);
  }
}

/**
 * Set up Stoat→Discord relay by listening on the Stoat WebSocket.
 * When a message arrives in a linked Stoat channel, forward it to Discord via webhook.
 */
export function setupStoatToDiscordRelay(
  stoatWs: StoatWebSocket,
  store: Store,
  stoatCdnUrl: string
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

    // Append Stoat attachment URLs
    if (event.attachments) {
      for (const att of event.attachments) {
        content += `\n${stoatCdnUrl}/attachments/${att._id}/${att.filename}`;
      }
    }

    content = truncateForDiscord(content.trim());
    if (!content) return;

    // Build avatar URL from Stoat CDN
    // TODO: Resolve user from cache/API to get avatar
    // For now, use default avatar
    const avatarUrl = undefined;
    const username = `stoat-user`; // TODO: resolve from user cache

    try {
      await sendViaWebhook(
        link.discord_webhook_id,
        link.discord_webhook_token,
        username,
        avatarUrl,
        content
      );
    } catch (err) {
      console.error("[bridge] Stoat→Discord relay error:", err);
    }
  });
}
