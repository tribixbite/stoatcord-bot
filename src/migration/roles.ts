/** Discord → Stoat role/permission mapping */

import {
  PermissionsBitField,
  type Guild,
  type Role as DiscordRole,
} from "discord.js";
import { PermissionBit, type PermissionsPair } from "../stoat/types.ts";

export interface RoleMapping {
  discordRole: DiscordRole;
  discordId: string;
  stoatName: string;
  stoatColor: string | null;
  permissions: PermissionsPair;
  selected: boolean;
  /** Whether role is displayed separately in the member list */
  hoist: boolean;
  /** Whether role can be @mentioned */
  mentionable: boolean;
  /** Discord role icon URL (if custom icon set) */
  iconUrl: string | null;
  /** Unicode emoji used as role icon (Discord feature) */
  unicodeEmoji: string | null;
  /** Warnings generated during mapping (truncation, unsupported features, etc.) */
  warnings: string[];
}

/**
 * Map all Discord roles to Stoat role definitions.
 * Skips @everyone (handled as default permissions) and managed roles (bots).
 */
export function mapDiscordRoles(guild: Guild): RoleMapping[] {
  const mappings: RoleMapping[] = [];

  const roles = [...guild.roles.cache.values()]
    .filter((r) => !r.managed && r.id !== guild.id) // skip @everyone and bot roles
    .sort((a, b) => b.position - a.position); // highest position first

  for (const role of roles) {
    const warnings: string[] = [];
    const trimmedName = role.name.trim();
    const stoatName = trimmedName.slice(0, 32);
    if (trimmedName.length > 32) {
      warnings.push(`Name truncated: '${trimmedName}' → '${stoatName}'`);
    }
    if (role.mentionable) {
      warnings.push("Mentionable flag not supported by Stoat");
    }
    if (role.iconURL()) {
      warnings.push("Role icon not directly supported by Stoat");
    }
    if (role.unicodeEmoji) {
      warnings.push(`Unicode emoji '${role.unicodeEmoji}' not supported by Stoat`);
    }

    mappings.push({
      discordRole: role,
      discordId: role.id,
      stoatName,
      stoatColor: role.hexColor !== "#000000" ? role.hexColor : null,
      permissions: mapPermissions(role.permissions),
      selected: true,
      hoist: role.hoist,
      mentionable: role.mentionable,
      iconUrl: role.iconURL({ size: 256 }) ?? null,
      unicodeEmoji: role.unicodeEmoji ?? null,
      warnings,
    });
  }

  return mappings;
}

/**
 * Convert a Discord PermissionsBitField to a Revolt permission integer.
 * Shared by role-level and channel-override mapping.
 */
function discordToRevoltBits(
  discordPerms: Readonly<PermissionsBitField>
): number {
  let bits = 0n;

  // Core permission mappings: Discord → Revolt
  if (discordPerms.has("ManageChannels"))
    bits |= PermissionBit.ManageChannel;
  if (discordPerms.has("ManageGuild"))
    bits |= PermissionBit.ManageServer;
  if (discordPerms.has("ManageRoles")) {
    bits |= PermissionBit.ManageRole;
    bits |= PermissionBit.ManagePermissions;
    bits |= PermissionBit.AssignRoles;
  }
  if (discordPerms.has("KickMembers"))
    bits |= PermissionBit.KickMembers;
  if (discordPerms.has("BanMembers"))
    bits |= PermissionBit.BanMembers;
  if (discordPerms.has("ModerateMembers"))
    bits |= PermissionBit.TimeoutMembers;
  if (discordPerms.has("ChangeNickname"))
    bits |= PermissionBit.ChangeNickname;
  if (discordPerms.has("ManageNicknames")) {
    bits |= PermissionBit.ManageNicknames;
    bits |= PermissionBit.ChangeAvatar;
    bits |= PermissionBit.RemoveAvatars;
  }
  if (discordPerms.has("ViewChannel"))
    bits |= PermissionBit.ViewChannel;
  if (discordPerms.has("ReadMessageHistory"))
    bits |= PermissionBit.ReadMessageHistory;
  if (discordPerms.has("SendMessages"))
    bits |= PermissionBit.SendMessage;
  if (discordPerms.has("ManageMessages"))
    bits |= PermissionBit.ManageMessages;
  if (discordPerms.has("ManageWebhooks")) {
    bits |= PermissionBit.ManageWebhooks;
    bits |= PermissionBit.Masquerade;
  }
  if (discordPerms.has("CreateInstantInvite"))
    bits |= PermissionBit.InviteOthers;
  if (discordPerms.has("EmbedLinks"))
    bits |= PermissionBit.SendEmbeds;
  if (discordPerms.has("AttachFiles"))
    bits |= PermissionBit.UploadFiles;
  if (discordPerms.has("AddReactions"))
    bits |= PermissionBit.React;
  if (discordPerms.has("Connect"))
    bits |= PermissionBit.Connect;
  if (discordPerms.has("Speak"))
    bits |= PermissionBit.Speak;
  if (discordPerms.has("Stream"))
    bits |= PermissionBit.Video;
  if (discordPerms.has("MuteMembers"))
    bits |= PermissionBit.MuteMembers;
  if (discordPerms.has("DeafenMembers"))
    bits |= PermissionBit.DeafenMembers;
  if (discordPerms.has("MoveMembers"))
    bits |= PermissionBit.MoveMembers;
  if (discordPerms.has("ManageGuildExpressions"))
    bits |= PermissionBit.ManageCustomisation;

  // Safe: the widest bit is 1n << 36n, well inside Number's 2^53 range.
  return Number(bits);
}

/**
 * Map Discord role permissions to Revolt's { a: allowed, d: denied } format.
 * Discord roles only have "allowed" permissions — denied is always 0.
 */
export function mapPermissions(
  discordPerms: Readonly<PermissionsBitField>
): PermissionsPair {
  return { a: discordToRevoltBits(discordPerms), d: 0 };
}

/**
 * Map Discord channel permission overrides (allow + deny) to Revolt format.
 * Channel overrides use both allow and deny bitfields, unlike roles.
 */
export function mapChannelOverridePermissions(
  allow: Readonly<PermissionsBitField>,
  deny: Readonly<PermissionsBitField>
): PermissionsPair {
  return { a: discordToRevoltBits(allow), d: discordToRevoltBits(deny) };
}
