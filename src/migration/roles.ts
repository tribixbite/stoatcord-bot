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
    mappings.push({
      discordRole: role,
      discordId: role.id,
      stoatName: role.name.slice(0, 32),
      stoatColor: role.hexColor !== "#000000" ? role.hexColor : null,
      permissions: mapPermissions(role.permissions),
      selected: true,
    });
  }

  return mappings;
}

/**
 * Map Discord permission bitfield to Revolt's { a: allowed, d: denied } format.
 * Discord only has "allowed" permissions. Revolt uses allow/deny pairs.
 */
export function mapPermissions(
  discordPerms: Readonly<PermissionsBitField>
): PermissionsPair {
  let allowed = 0;

  // Map Discord permissions → Revolt equivalents
  if (discordPerms.has("ManageChannels"))
    allowed |= Number(PermissionBit.ManageChannel);
  if (discordPerms.has("ManageGuild"))
    allowed |= Number(PermissionBit.ManageServer);
  if (discordPerms.has("ManageRoles"))
    allowed |= Number(PermissionBit.ManageRole);
  if (discordPerms.has("KickMembers"))
    allowed |= Number(PermissionBit.KickMembers);
  if (discordPerms.has("BanMembers"))
    allowed |= Number(PermissionBit.BanMembers);
  if (discordPerms.has("ModerateMembers"))
    allowed |= Number(PermissionBit.TimeoutMembers);
  if (discordPerms.has("ChangeNickname"))
    allowed |= Number(PermissionBit.ChangeNickname);
  if (discordPerms.has("ManageNicknames"))
    allowed |= Number(PermissionBit.ManageNicknames);
  if (discordPerms.has("ViewChannel"))
    allowed |= Number(PermissionBit.ViewChannel);
  if (discordPerms.has("ReadMessageHistory"))
    allowed |= Number(PermissionBit.ReadMessageHistory);
  if (discordPerms.has("SendMessages"))
    allowed |= Number(PermissionBit.SendMessage);
  if (discordPerms.has("ManageMessages"))
    allowed |= Number(PermissionBit.ManageMessages);
  if (discordPerms.has("ManageWebhooks"))
    allowed |= Number(PermissionBit.ManageWebhooks);
  if (discordPerms.has("CreateInstantInvite"))
    allowed |= Number(PermissionBit.InviteOthers);
  if (discordPerms.has("EmbedLinks"))
    allowed |= Number(PermissionBit.SendEmbeds);
  if (discordPerms.has("AttachFiles"))
    allowed |= Number(PermissionBit.UploadFiles);
  if (discordPerms.has("AddReactions"))
    allowed |= Number(PermissionBit.React);
  if (discordPerms.has("Connect"))
    allowed |= Number(PermissionBit.Connect);
  if (discordPerms.has("Speak"))
    allowed |= Number(PermissionBit.Speak);
  if (discordPerms.has("Stream"))
    allowed |= Number(PermissionBit.Video);
  if (discordPerms.has("MuteMembers"))
    allowed |= Number(PermissionBit.MuteMembers);
  if (discordPerms.has("DeafenMembers"))
    allowed |= Number(PermissionBit.DeafenMembers);
  if (discordPerms.has("MoveMembers"))
    allowed |= Number(PermissionBit.MoveMembers);

  return { a: allowed, d: 0 };
}
