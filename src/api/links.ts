/** HTTP API handlers for bridge link management.
 * Consumed by the Stoat Android app's bridge settings screen. */

import type { Client, TextChannel } from "discord.js";
import { ChannelType } from "discord.js";
import type { Store } from "../db/store.ts";
import { ensureWebhook } from "../bridge/webhooks.ts";

// --- Response types ---

export interface BridgeLinkInfo {
  discordChannelId: string;
  discordChannelName: string | null;
  stoatChannelId: string;
  hasWebhook: boolean;
  active: boolean;
  createdAt: number;
}

export interface LinkRequest {
  discordChannelId: string;
  stoatChannelId: string;
}

// --- Handlers ---

/** GET /api/links — list all active bridge links */
export function handleListLinks(
  store: Store,
  client: Client
): Response {
  const links = store.getAllActiveChannelLinks();

  const result: BridgeLinkInfo[] = links.map((link) => {
    const discordChannel = client.channels.cache.get(link.discord_channel_id);
    return {
      discordChannelId: link.discord_channel_id,
      discordChannelName: discordChannel && "name" in discordChannel
        ? (discordChannel.name ?? null)
        : null,
      stoatChannelId: link.stoat_channel_id,
      hasWebhook: !!(link.discord_webhook_id && link.discord_webhook_token),
      active: link.active === 1,
      createdAt: link.created_at,
    };
  });

  return Response.json(result);
}

/** GET /api/links/guild/:guildId — list links for channels in a specific guild */
export function handleGuildLinks(
  store: Store,
  client: Client,
  guildId: string
): Response {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return Response.json({ error: "Guild not found" }, { status: 404 });
  }

  // Get all guild channel IDs
  const guildChannelIds = new Set(
    guild.channels.cache.map((ch) => ch.id)
  );

  // Filter active links to only those in this guild
  const links = store.getAllActiveChannelLinks().filter(
    (link) => guildChannelIds.has(link.discord_channel_id)
  );

  const result: BridgeLinkInfo[] = links.map((link) => {
    const ch = guild.channels.cache.get(link.discord_channel_id);
    return {
      discordChannelId: link.discord_channel_id,
      discordChannelName: ch?.name ?? null,
      stoatChannelId: link.stoat_channel_id,
      hasWebhook: !!(link.discord_webhook_id && link.discord_webhook_token),
      active: link.active === 1,
      createdAt: link.created_at,
    };
  });

  return Response.json(result);
}

/** POST /api/links — create a new bridge link with webhook setup */
export async function handleCreateLink(
  store: Store,
  client: Client,
  body: LinkRequest
): Promise<Response> {
  const { discordChannelId, stoatChannelId } = body;

  if (!discordChannelId || !stoatChannelId) {
    return Response.json(
      { error: "discordChannelId and stoatChannelId are required" },
      { status: 400 }
    );
  }

  // Check if either side is already linked
  const existingDiscord = store.getChannelByDiscordId(discordChannelId);
  if (existingDiscord) {
    return Response.json(
      { error: `Discord channel ${discordChannelId} is already linked to ${existingDiscord.stoat_channel_id}` },
      { status: 409 }
    );
  }

  const existingStoat = store.getChannelByStoatId(stoatChannelId);
  if (existingStoat) {
    return Response.json(
      { error: `Stoat channel ${stoatChannelId} is already linked to Discord channel ${existingStoat.discord_channel_id}` },
      { status: 409 }
    );
  }

  // Verify Discord channel exists and is a text channel
  const channel = client.channels.cache.get(discordChannelId);
  if (!channel) {
    return Response.json(
      { error: "Discord channel not found in bot's cache" },
      { status: 404 }
    );
  }
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return Response.json(
      { error: "Only text and announcement channels can be bridged" },
      { status: 400 }
    );
  }

  // Create webhook for Stoat→Discord relay
  let webhookId: string | undefined;
  let webhookToken: string | undefined;
  try {
    const webhook = await ensureWebhook(channel as TextChannel, client);
    webhookId = webhook.id;
    webhookToken = webhook.token ?? undefined;
  } catch (err) {
    console.error("[api] Failed to create webhook:", err);
    // Link without webhook — Discord→Stoat relay still works
  }

  store.linkChannel(discordChannelId, stoatChannelId, webhookId, webhookToken);

  return Response.json({
    success: true,
    discordChannelId,
    stoatChannelId,
    hasWebhook: !!(webhookId && webhookToken),
  }, { status: 201 });
}

/** DELETE /api/links/:discordChannelId — remove a bridge link */
export function handleDeleteLink(
  store: Store,
  discordChannelId: string
): Response {
  const existing = store.getChannelByDiscordId(discordChannelId);
  if (!existing) {
    return Response.json(
      { error: "Link not found" },
      { status: 404 }
    );
  }

  store.unlinkChannel(discordChannelId);
  return Response.json({ success: true, discordChannelId });
}
