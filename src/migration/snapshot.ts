/**
 * Discord server data snapshot generator for migration logging.
 * Captures all server properties — both those mapped to Stoat and those
 * preserved as a historical record of the Discord server state.
 */

import {
  ChannelType,
  type Guild,
  type GuildChannel,
  type TextChannel,
  type GuildMember,
  type Role,
  type Collection,
  type GuildEmoji,
  type Sticker,
  type GuildBan,
} from "discord.js";
import type { StoatClient } from "../stoat/client.ts";

export interface SnapshotOptions {
  /** Include member and ban lists (requires GuildMembers/GuildModeration intent) */
  includeMembers: boolean;
  /** Include pinned messages per channel */
  includePins: boolean;
  /** Download and include media as attachment URLs (icon, banner, emoji, stickers) */
  includeMedia: boolean;
}

export interface SnapshotSection {
  title: string;
  content: string;
}

export interface SnapshotMessage {
  content: string;
}

/**
 * Generate a comprehensive data snapshot of a Discord guild.
 * Each section is a titled text block that will be posted to #migration-log.
 */
export async function generateMigrationSnapshot(
  guild: Guild,
  stoatClient: StoatClient,
  options: SnapshotOptions
): Promise<SnapshotSection[]> {
  const sections: SnapshotSection[] = [];

  // --- 1. Server Overview ---
  sections.push({
    title: "Server Overview",
    content: formatServerOverview(guild),
  });

  // --- 2. Roles ---
  sections.push({
    title: "Roles",
    content: formatRoles(guild),
  });

  // --- 3. Channels ---
  sections.push({
    title: "Channels",
    content: formatChannels(guild),
  });

  // --- 4. Permission Overwrites ---
  const permSection = formatPermissionOverwrites(guild);
  if (permSection.length > 0) {
    sections.push({
      title: "Permission Overwrites",
      content: permSection,
    });
  }

  // --- 5. Bans (if includeMembers) ---
  if (options.includeMembers) {
    try {
      const bans = await guild.bans.fetch();
      sections.push({
        title: "Bans",
        content: formatBans(bans),
      });
    } catch {
      sections.push({
        title: "Bans",
        content: "Could not fetch bans — GuildModeration intent may not be enabled.",
      });
    }
  }

  // --- 6. Members (if includeMembers) ---
  if (options.includeMembers) {
    try {
      const members = await guild.members.fetch({ limit: 1000 });
      sections.push({
        title: "Members",
        content: formatMembers(members, guild.memberCount),
      });
    } catch {
      sections.push({
        title: "Members",
        content: "Could not fetch members — GuildMembers intent may not be enabled.",
      });
    }
  }

  // --- 7. Pinned Messages (if includePins) ---
  if (options.includePins) {
    const pinSections = await formatPinnedMessages(guild);
    if (pinSections.length > 0) {
      sections.push({
        title: "Pinned Messages",
        content: pinSections,
      });
    }
  }

  // --- 8. Custom Emoji ---
  if (guild.emojis.cache.size > 0) {
    sections.push({
      title: "Custom Emoji",
      content: formatEmoji(guild.emojis.cache),
    });
  }

  // --- 9. Stickers ---
  if (guild.stickers.cache.size > 0) {
    sections.push({
      title: "Stickers",
      content: formatStickers(guild.stickers.cache),
    });
  }

  // --- 10. Unmapped Properties ---
  sections.push({
    title: "Unmapped Discord Properties",
    content: formatUnmappedProperties(guild),
  });

  return sections;
}

/**
 * Split snapshot sections into Stoat-compatible messages (≤1950 chars each).
 * Tries to keep sections together; splits within sections if necessary.
 */
export function splitSnapshotIntoMessages(
  sections: SnapshotSection[]
): SnapshotMessage[] {
  const MAX_CHARS = 1950; // Leave room for [N/M] prefix
  const messages: SnapshotMessage[] = [];
  let currentMessage = "";

  for (const section of sections) {
    const sectionText = `## ${section.title}\n\n${section.content}\n\n`;

    // If the entire section fits in the current message
    if (currentMessage.length + sectionText.length <= MAX_CHARS) {
      currentMessage += sectionText;
      continue;
    }

    // If current message has content, flush it
    if (currentMessage.length > 0) {
      messages.push({ content: currentMessage.trim() });
      currentMessage = "";
    }

    // If the section itself fits in one message
    if (sectionText.length <= MAX_CHARS) {
      currentMessage = sectionText;
      continue;
    }

    // Section is too large — split at line boundaries
    const lines = sectionText.split("\n");
    let chunk = "";
    for (const line of lines) {
      if (chunk.length + line.length + 1 > MAX_CHARS) {
        if (chunk.length > 0) {
          messages.push({ content: chunk.trim() });
          chunk = "";
        }
        // If a single line exceeds MAX_CHARS, force-split it
        if (line.length > MAX_CHARS) {
          for (let i = 0; i < line.length; i += MAX_CHARS) {
            messages.push({ content: line.slice(i, i + MAX_CHARS) });
          }
          continue;
        }
      }
      chunk += line + "\n";
    }
    if (chunk.length > 0) {
      currentMessage = chunk;
    }
  }

  // Flush remaining
  if (currentMessage.trim().length > 0) {
    messages.push({ content: currentMessage.trim() });
  }

  return messages;
}

// --- Formatters ---

function formatServerOverview(guild: Guild): string {
  const lines: string[] = [];
  lines.push(`**Name**: ${guild.name}`);
  lines.push(`**ID**: \`${guild.id}\``);
  if (guild.description) lines.push(`**Description**: ${guild.description}`);
  lines.push(`**Owner**: <@${guild.ownerId}> (\`${guild.ownerId}\`)`);
  lines.push(`**Created**: ${guild.createdAt.toISOString()}`);
  lines.push(`**Members**: ${guild.memberCount}`);
  lines.push(`**Verification Level**: ${guild.verificationLevel}`);
  lines.push(`**Explicit Content Filter**: ${guild.explicitContentFilter}`);
  lines.push(`**Default Notifications**: ${guild.defaultMessageNotifications}`);
  lines.push(`**NSFW Level**: ${guild.nsfwLevel}`);
  if (guild.vanityURLCode) lines.push(`**Vanity URL**: discord.gg/${guild.vanityURLCode}`);
  lines.push(`**Premium Tier**: ${guild.premiumTier} (${guild.premiumSubscriptionCount ?? 0} boosts)`);
  if (guild.preferredLocale) lines.push(`**Locale**: ${guild.preferredLocale}`);

  // System channels
  if (guild.systemChannel) lines.push(`**System Channel**: #${guild.systemChannel.name}`);
  if (guild.rulesChannel) lines.push(`**Rules Channel**: #${guild.rulesChannel.name}`);
  if (guild.publicUpdatesChannel) lines.push(`**Updates Channel**: #${guild.publicUpdatesChannel.name}`);
  if (guild.afkChannel) lines.push(`**AFK Channel**: #${guild.afkChannel.name} (timeout: ${guild.afkTimeout}s)`);

  // Media URLs
  if (guild.iconURL()) lines.push(`**Icon**: ${guild.iconURL({ size: 1024 })}`);
  if (guild.bannerURL()) lines.push(`**Banner**: ${guild.bannerURL({ size: 1024 })}`);
  if (guild.splashURL()) lines.push(`**Splash**: ${guild.splashURL({ size: 1024 })}`);
  if (guild.discoverySplashURL()) lines.push(`**Discovery Splash**: ${guild.discoverySplashURL({ size: 1024 })}`);

  return lines.join("\n");
}

function formatRoles(guild: Guild): string {
  const roles = [...guild.roles.cache.values()]
    .sort((a, b) => b.position - a.position);

  const lines: string[] = [];
  for (const role of roles) {
    const props: string[] = [];
    props.push(`pos:${role.position}`);
    if (role.hexColor !== "#000000") props.push(`color:${role.hexColor}`);
    if (role.hoist) props.push("hoisted");
    if (role.mentionable) props.push("mentionable");
    if (role.managed) props.push("managed");
    if (role.iconURL()) props.push(`icon:${role.iconURL({ size: 64 })}`);
    if (role.unicodeEmoji) props.push(`emoji:${role.unicodeEmoji}`);
    props.push(`perms:0x${role.permissions.bitfield.toString(16)}`);
    props.push(`members:${role.members.size}`);
    props.push(`created:${role.createdAt.toISOString().split("T")[0]}`);

    lines.push(`• **${role.name}** — ${props.join(", ")}`);
  }

  return lines.join("\n") || "No roles";
}

function formatChannels(guild: Guild): string {
  const lines: string[] = [];

  // Group by category
  const categorized = new Map<string | null, GuildChannel[]>();
  for (const [, ch] of guild.channels.cache) {
    if (ch.type === ChannelType.GuildCategory) continue; // skip category entries themselves
    if (!("position" in ch)) continue;
    const catName = ch.parent?.name ?? null;
    if (!categorized.has(catName)) categorized.set(catName, []);
    categorized.get(catName)!.push(ch as GuildChannel);
  }

  // Sort categories by position
  const sortedCategories = [...categorized.entries()].sort((a, b) => {
    if (a[0] === null) return -1;
    if (b[0] === null) return 1;
    const catA = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === a[0]);
    const catB = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === b[0]);
    return ("position" in (catA ?? {}) ? (catA as GuildChannel).position : 0) - ("position" in (catB ?? {}) ? (catB as GuildChannel).position : 0);
  });

  for (const [catName, channels] of sortedCategories) {
    lines.push(`\n**${catName ?? "Uncategorized"}**`);
    const sorted = channels.sort((a, b) => a.position - b.position);
    for (const ch of sorted) {
      const typeName = ChannelType[ch.type] ?? String(ch.type);
      const props: string[] = [typeName];

      // Text channel props
      if ("topic" in ch && (ch as TextChannel).topic) {
        const topic = (ch as TextChannel).topic!;
        props.push(`topic:"${topic.slice(0, 80)}${topic.length > 80 ? "..." : ""}"`);
      }
      if ("nsfw" in ch && (ch as TextChannel).nsfw) props.push("nsfw");
      if ("rateLimitPerUser" in ch && (ch as TextChannel).rateLimitPerUser) {
        props.push(`slowmode:${(ch as TextChannel).rateLimitPerUser}s`);
      }
      props.push(`pos:${ch.position}`);
      if (ch.permissionOverwrites?.cache.size) {
        props.push(`${ch.permissionOverwrites.cache.size} perm overwrite(s)`);
      }
      props.push(`created:${ch.createdAt?.toISOString().split("T")[0] ?? "unknown"}`);

      // Mark unsupported types
      const supported = [
        ChannelType.GuildText, ChannelType.GuildVoice,
        ChannelType.GuildAnnouncement, ChannelType.GuildForum,
      ];
      if (!supported.includes(ch.type)) {
        props.push("**[unsupported by Stoat]**");
      }

      lines.push(`  • #${ch.name} — ${props.join(", ")}`);
    }
  }

  return lines.join("\n") || "No channels";
}

function formatPermissionOverwrites(guild: Guild): string {
  const lines: string[] = [];

  for (const [, ch] of guild.channels.cache) {
    if (!("permissionOverwrites" in ch)) continue;
    const channel = ch as GuildChannel;
    if (!channel.permissionOverwrites?.cache.size) continue;

    lines.push(`\n**#${channel.name}**`);
    for (const [, overwrite] of channel.permissionOverwrites.cache) {
      // Resolve the target name
      let targetName: string;
      if (overwrite.type === 0) {
        // Role
        const role = guild.roles.cache.get(overwrite.id);
        targetName = `@${role?.name ?? overwrite.id}`;
      } else {
        // Member
        targetName = `user:${overwrite.id}`;
      }

      const allow = overwrite.allow.bitfield;
      const deny = overwrite.deny.bitfield;
      if (allow || deny) {
        lines.push(`  • ${targetName}: allow=0x${allow.toString(16)}, deny=0x${deny.toString(16)}`);
      }
    }
  }

  return lines.join("\n");
}

function formatBans(bans: Collection<string, GuildBan>): string {
  if (bans.size === 0) return "No bans";

  const lines: string[] = [];
  lines.push(`**Total**: ${bans.size} ban(s)`);
  for (const [, ban] of bans) {
    const reason = ban.reason ? ` — ${ban.reason.slice(0, 100)}` : "";
    lines.push(`• ${ban.user.tag} (\`${ban.user.id}\`)${reason}`);
  }
  return lines.join("\n");
}

function formatMembers(
  members: Collection<string, GuildMember>,
  totalCount: number
): string {
  const lines: string[] = [];
  const capped = members.size < totalCount;
  lines.push(`**Total**: ${totalCount} member(s)${capped ? ` (showing first ${members.size})` : ""}`);

  const sorted = [...members.values()].sort(
    (a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0)
  );

  for (const member of sorted) {
    const roles = member.roles.cache
      .filter((r) => r.id !== member.guild.id) // skip @everyone
      .map((r) => r.name)
      .join(", ");
    const nickname = member.nickname ? ` (${member.nickname})` : "";
    const joined = member.joinedAt?.toISOString().split("T")[0] ?? "unknown";
    lines.push(`• ${member.user.tag}${nickname} — joined ${joined}${roles ? `, roles: ${roles}` : ""}`);
  }

  return lines.join("\n");
}

async function formatPinnedMessages(guild: Guild): Promise<string> {
  const lines: string[] = [];

  for (const [, ch] of guild.channels.cache) {
    if (!ch.isTextBased()) continue;
    try {
      const pins = await (ch as TextChannel).messages.fetchPinned();
      if (pins.size === 0) continue;

      lines.push(`\n**#${ch.name}** (${pins.size} pin(s))`);
      for (const [, msg] of pins) {
        const preview = msg.content
          ? msg.content.slice(0, 100) + (msg.content.length > 100 ? "..." : "")
          : "(no text)";
        const attachments = msg.attachments.size > 0 ? ` [${msg.attachments.size} attachment(s)]` : "";
        lines.push(`  • ${msg.author.tag} (${msg.createdAt.toISOString().split("T")[0]}): ${preview}${attachments}`);
      }
    } catch {
      // Skip channels we can't read
    }
  }

  return lines.join("\n");
}

function formatEmoji(emojis: Collection<string, GuildEmoji>): string {
  const lines: string[] = [];
  lines.push(`**Total**: ${emojis.size} emoji`);

  for (const [, emoji] of emojis) {
    const props: string[] = [];
    if (emoji.animated) props.push("animated");
    props.push(`url: ${emoji.imageURL({ size: 128 })}`);
    if (emoji.author) props.push(`by: ${emoji.author.tag}`);
    lines.push(`• :${emoji.name}: — ${props.join(", ")}`);
  }

  return lines.join("\n");
}

function formatStickers(stickers: Collection<string, Sticker>): string {
  const lines: string[] = [];
  lines.push(`**Total**: ${stickers.size} sticker(s)`);

  for (const [, sticker] of stickers) {
    const props: string[] = [];
    props.push(`format: ${sticker.format}`);
    if (sticker.description) props.push(`desc: "${sticker.description.slice(0, 60)}"`);
    if (sticker.tags) props.push(`tags: ${sticker.tags}`);
    lines.push(`• **${sticker.name}** — ${props.join(", ")}`);
  }

  return lines.join("\n");
}

function formatUnmappedProperties(guild: Guild): string {
  const lines: string[] = [];
  lines.push("The following Discord features have no Stoat equivalent:");
  lines.push("");
  lines.push("• **Verification levels** — Stoat has no equivalent verification gate");
  lines.push("• **Explicit content filter** — No server-level NSFW filter in Stoat");
  lines.push("• **AFK channel/timeout** — Stoat voice channels don't have AFK");
  lines.push("• **System message channel** — Stoat has system_messages but with different event types");
  lines.push("• **Vanity URL** — Not available in Stoat");
  lines.push("• **Server boosts/premium tier** — No Nitro equivalent");
  lines.push("• **Stage channels** — Not supported by Stoat");
  lines.push("• **Thread channels** — Not supported by Stoat");
  lines.push("• **Forum channels** — Mapped to Text, but threaded semantics lost");
  lines.push("• **Announcement channels** — Mapped to Text, cross-server publishing lost");
  lines.push("• **Slowmode** — Not supported by Stoat");
  lines.push("• **Auto-moderation rules** — Not available in Stoat");
  lines.push("• **Scheduled events** — Not available in Stoat");
  lines.push("• **Integrations** — Not available in Stoat");
  lines.push("• **Per-channel role permission overwrites** — Stoat supports this but migration is limited");
  lines.push("• **Role icons / unicode emoji** — Not supported by Stoat roles");
  lines.push("• **Stickers** — Not supported by Stoat");
  lines.push("• **Welcome screen** — Not available in Stoat");
  lines.push("• **Server discovery settings** — Different discovery system in Stoat");

  return lines.join("\n");
}
