/** Discord → Stoat channel structure mapping */

import { ChannelType, type Guild, type GuildChannel } from "discord.js";

export interface ChannelMapping {
  discordChannel: GuildChannel;
  discordId: string;
  stoatName: string;
  stoatType: "Text" | "Voice";
  category: string | null; // category name
  position: number;
  selected: boolean;
}

/**
 * Read all channels from a Discord guild and map them to Stoat channel definitions.
 * Groups by category for organized migration.
 */
export function mapDiscordChannels(guild: Guild): ChannelMapping[] {
  const mappings: ChannelMapping[] = [];

  // Sort channels by position, then by category
  const channels = [...guild.channels.cache.values()]
    .filter(
      (ch) =>
        ch.type === ChannelType.GuildText ||
        ch.type === ChannelType.GuildVoice ||
        ch.type === ChannelType.GuildAnnouncement ||
        ch.type === ChannelType.GuildForum
    )
    .sort((a, b) => {
      // Sort by category position first, then channel position
      const catA = a.parent?.position ?? -1;
      const catB = b.parent?.position ?? -1;
      if (catA !== catB) return catA - catB;
      return a.position - b.position;
    });

  for (const ch of channels) {
    const stoatType = mapChannelType(ch.type);
    if (!stoatType) continue;

    mappings.push({
      discordChannel: ch,
      discordId: ch.id,
      stoatName: sanitizeName(ch.name),
      stoatType,
      category: ch.parent?.name ?? null,
      position: ch.position,
      selected: true, // selected by default
    });
  }

  return mappings;
}

/**
 * Map Discord ChannelType to Stoat channel type.
 * Returns null for unsupported types.
 */
function mapChannelType(
  discordType: ChannelType
): "Text" | "Voice" | null {
  switch (discordType) {
    case ChannelType.GuildText:
    case ChannelType.GuildAnnouncement:
    case ChannelType.GuildForum:
      return "Text";
    case ChannelType.GuildVoice:
      return "Voice";
    default:
      return null;
  }
}

/**
 * Sanitize a channel name for Stoat (1-32 chars, lowercase).
 * Stoat/Revolt is more permissive with names than Discord.
 */
export function sanitizeName(name: string): string {
  // Revolt accepts most names — just enforce length
  let sanitized = name.trim();
  if (sanitized.length === 0) sanitized = "unnamed";
  if (sanitized.length > 32) sanitized = sanitized.slice(0, 32);
  return sanitized;
}

/**
 * Group channel mappings by category for display.
 */
export function groupByCategory(
  mappings: ChannelMapping[]
): Map<string | null, ChannelMapping[]> {
  const groups = new Map<string | null, ChannelMapping[]>();
  for (const m of mappings) {
    const key = m.category;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  return groups;
}
