/** Outage recovery — sync missed messages after WS disconnect/bot restart */

import type { Client, TextChannel } from "discord.js";
import type { StoatClient } from "../stoat/client.ts";
import type { Store } from "../db/store.ts";
import type { ChannelLinkRow } from "../db/schema.ts";
import { discordToRevolt, revoltToDiscord, truncateForRevolt, truncateForDiscord } from "./format.ts";
import { sendViaWebhook } from "./webhooks.ts";
import { sleep } from "../util.ts";

const MAX_RECOVERY_MESSAGES = 100; // Cap per channel to avoid flooding

/**
 * Run outage recovery for all active channel links.
 * Fetches messages sent during the gap on both platforms and relays them.
 * Should be called after successful WS reconnection.
 */
export async function runOutageRecovery(
  store: Store,
  stoatClient: StoatClient,
  discordClient: Client | null,
  stoatCdnUrl: string
): Promise<void> {
  const links = store.getAllActiveChannelLinks();
  if (links.length === 0) return;

  console.log(`[recovery] Starting outage recovery for ${links.length} channel link(s)`);
  let totalRecovered = 0;

  for (const link of links) {
    try {
      const count = await recoverChannelGap(link, store, stoatClient, discordClient, stoatCdnUrl);
      totalRecovered += count;
    } catch (err) {
      console.error(
        `[recovery] Error recovering channel ${link.discord_channel_id} ↔ ${link.stoat_channel_id}:`,
        err
      );
    }
  }

  if (totalRecovered > 0) {
    console.log(`[recovery] Recovered ${totalRecovered} missed message(s) total`);
  } else {
    console.log("[recovery] No missed messages found");
  }
}

/**
 * Recover missed messages for a single channel link.
 * Returns count of messages recovered.
 */
async function recoverChannelGap(
  link: ChannelLinkRow,
  store: Store,
  stoatClient: StoatClient,
  discordClient: Client | null,
  stoatCdnUrl: string
): Promise<number> {
  let recovered = 0;

  // --- Recover Discord→Stoat gap ---
  if (discordClient && link.last_bridged_discord_id) {
    try {
      const channel = discordClient.channels.cache.get(link.discord_channel_id) as TextChannel | undefined;
      if (channel) {
        const missedMessages = await channel.messages.fetch({
          after: link.last_bridged_discord_id,
          limit: MAX_RECOVERY_MESSAGES,
        });

        // Filter out bot messages and sort oldest-first
        const toRelay = [...missedMessages.values()]
          .filter((m) => !m.author.bot && !m.system)
          .reverse(); // oldest first

        for (const msg of toRelay) {
          let content = discordToRevolt(msg.content || "");
          // Append attachment URLs (not re-hosting during recovery to avoid flooding Autumn)
          for (const att of msg.attachments.values()) {
            content += `\n${att.url}`;
          }
          content = truncateForRevolt(content.trim());
          if (!content) continue;

          try {
            const sent = await stoatClient.sendMessage(link.stoat_channel_id, content, {
              masquerade: {
                name: `${msg.author.displayName || msg.author.username} [delayed]`,
                avatar: msg.author.displayAvatarURL({ size: 256, extension: "png" }),
              },
            });

            if (sent._id) {
              store.storeBridgeMessage(
                msg.id,
                sent._id,
                link.discord_channel_id,
                link.stoat_channel_id,
                "d2s"
              );
              store.updateLastBridged(link.discord_channel_id, msg.id, sent._id);
              recovered++;
            }

            // Rate limit: 10 msgs per 10s on Stoat
            await sleep(1100);
          } catch (err) {
            console.warn(`[recovery] Failed to relay Discord msg ${msg.id}:`, err);
          }
        }
      }
    } catch (err) {
      console.warn(`[recovery] Discord gap fetch failed for ${link.discord_channel_id}:`, err);
    }
  }

  // --- Recover Stoat→Discord gap ---
  if (link.last_bridged_stoat_id && link.discord_webhook_id && link.discord_webhook_token) {
    try {
      const missedResponse = await stoatClient.getMessages(link.stoat_channel_id, {
        after: link.last_bridged_stoat_id,
        sort: "Oldest",
        limit: MAX_RECOVERY_MESSAGES,
      });

      // getMessages returns Message[] or { messages, users }
      const messages = Array.isArray(missedResponse)
        ? missedResponse
        : missedResponse.messages ?? [];

      // Filter out masqueraded messages (already bridged from Discord)
      const toRelay = messages.filter((m: any) => !m.masquerade);

      for (const msg of toRelay) {
        let content = revoltToDiscord(msg.content || "");
        // Append attachment URLs
        if (msg.attachments) {
          for (const att of msg.attachments) {
            const filename = typeof att === "string" ? att : att.filename ?? att._id;
            const attId = typeof att === "string" ? att : att._id;
            content += `\n${stoatCdnUrl}/attachments/${attId}/${filename}`;
          }
        }
        content = truncateForDiscord(content.trim());
        if (!content) continue;

        // Resolve author name
        let username = "stoat-user [delayed]";
        try {
          const user = await stoatClient.fetchUser(msg.author);
          username = `${user.display_name || user.username} [delayed]`;
        } catch {
          // Use fallback
        }

        try {
          const discordMsgId = await sendViaWebhook(
            link.discord_webhook_id!,
            link.discord_webhook_token!,
            username,
            undefined,
            content
          );
          store.storeBridgeMessage(
            discordMsgId,
            msg._id,
            link.discord_channel_id,
            link.stoat_channel_id,
            "s2d"
          );
          store.updateLastBridged(link.discord_channel_id, discordMsgId, msg._id);
          recovered++;

          // Brief delay to avoid Discord webhook rate limit
          await sleep(500);
        } catch (err) {
          console.warn(`[recovery] Failed to relay Stoat msg ${msg._id}:`, err);
        }
      }
    } catch (err) {
      console.warn(`[recovery] Stoat gap fetch failed for ${link.stoat_channel_id}:`, err);
    }
  }

  return recovered;
}
