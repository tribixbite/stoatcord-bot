/** HTTP API handlers for Discord guild/channel data.
 * Consumed by the Stoat Android app's Discord Import wizard. */

import type { Client, Guild, GuildChannel } from "discord.js";
import { ChannelType } from "discord.js";

// --- Response types ---

export interface GuildPreview {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
  channelCount: number;
}

export interface ChannelInfo {
  id: string;
  name: string;
  type: "text" | "voice" | "announcement" | "forum" | "stage" | "category";
  category: string | null;
  position: number;
}

export interface RoleInfo {
  id: string;
  name: string;
  color: string;
  position: number;
  memberCount: number | null;
}

export interface GuildChannelsResponse {
  guild: {
    id: string;
    name: string;
    icon: string | null;
    description: string | null;
    memberCount: number;
  };
  channels: ChannelInfo[];
  roles: RoleInfo[];
}

// --- Helpers ---

function mapChannelType(type: ChannelType): ChannelInfo["type"] | null {
  switch (type) {
    case ChannelType.GuildText:
      return "text";
    case ChannelType.GuildVoice:
      return "voice";
    case ChannelType.GuildAnnouncement:
      return "announcement";
    case ChannelType.GuildForum:
      return "forum";
    case ChannelType.GuildStageVoice:
      return "stage";
    case ChannelType.GuildCategory:
      return "category";
    default:
      return null;
  }
}

// --- Handlers ---

/** GET /api/guilds — list all guilds the bot is in */
export function handleListGuilds(client: Client): Response {
  const guilds: GuildPreview[] = client.guilds.cache.map((guild) => ({
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL({ size: 128, extension: "png" }),
    memberCount: guild.memberCount,
    channelCount: guild.channels.cache.size,
  }));

  return Response.json(guilds);
}

/** GET /api/guilds/:id/channels — full channel + role list for a guild */
export async function handleGuildChannels(
  client: Client,
  guildId: string
): Promise<Response> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return Response.json({ error: "Guild not found or bot not in guild" }, { status: 404 });
  }

  // Fetch fresh data
  try {
    await guild.channels.fetch();
    await guild.roles.fetch();
  } catch (err) {
    return Response.json(
      { error: `Failed to fetch guild data: ${err}` },
      { status: 502 }
    );
  }

  // Map channels (skip categories from main list, use as grouping)
  const categoryMap = new Map<string, string>();
  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildCategory) {
      categoryMap.set(ch.id, ch.name);
    }
  }

  const channels: ChannelInfo[] = [];
  for (const ch of guild.channels.cache.values()) {
    const type = mapChannelType(ch.type);
    if (!type || type === "category") continue; // skip unsupported + categories

    const guildCh = ch as GuildChannel;
    channels.push({
      id: ch.id,
      name: ch.name,
      type,
      category: guildCh.parentId ? (categoryMap.get(guildCh.parentId) ?? null) : null,
      position: guildCh.position,
    });
  }

  // Sort by category then position
  channels.sort((a, b) => {
    const catA = a.category ?? "";
    const catB = b.category ?? "";
    if (catA !== catB) return catA.localeCompare(catB);
    return a.position - b.position;
  });

  // Map roles (skip @everyone and managed bot roles)
  const roles: RoleInfo[] = guild.roles.cache
    .filter((r) => !r.managed && r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.hexColor,
      position: r.position,
      memberCount: r.members.size,
    }));

  const response: GuildChannelsResponse = {
    guild: {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL({ size: 256, extension: "png" }),
      description: guild.description,
      memberCount: guild.memberCount,
    },
    channels,
    roles,
  };

  return Response.json(response);
}
