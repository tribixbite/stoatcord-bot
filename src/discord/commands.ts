/** Discord slash command definitions and registration */

import {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

/** Slash command definitions */
export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName("migrate")
    .setDescription(
      "Migrate this Discord server's channels and roles to Stoat"
    )
    .addStringOption((opt) =>
      opt
        .setName("claim_code")
        .setDescription(
          "One-time code from a Stoat admin (includes server — no server ID needed)"
        )
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("stoat_server_id")
        .setDescription(
          "Stoat server ID — triggers live approval if no code provided"
        )
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("What to migrate (default: missing — create new + update existing)")
        .setRequired(false)
        .addChoices(
          { name: "Create missing + update existing (default)", value: "missing" },
          { name: "Full sync (create + update everything)", value: "full" },
          { name: "Roles only", value: "roles" },
          { name: "Categories only (organize existing channels)", value: "categories" },
        )
    )
    .addBooleanOption((opt) =>
      opt
        .setName("dry_run")
        .setDescription("Preview what would happen without making changes")
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("include_snapshot")
        .setDescription("Post full Discord server data snapshot to #migration-log")
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("exclude_members")
        .setDescription("Exclude member/ban lists from snapshot (default: true)")
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("exclude_pins")
        .setDescription("Exclude pinned messages from snapshot")
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("include_media")
        .setDescription("Upload server media (icon, banner, emoji images)")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link this Discord channel to a Stoat channel for bridging")
    .addStringOption((opt) =>
      opt
        .setName("stoat_channel_id")
        .setDescription("The Stoat channel ID to bridge with")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Unlink this Discord channel from its Stoat bridge")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show bridge status for this server")
    .toJSON(),
];

/** Register slash commands globally (or per guild for testing) */
export async function registerCommands(
  token: string,
  clientId: string,
  guildId?: string
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);

  console.log(`[discord] Registering ${commands.length} slash commands...`);

  if (guildId) {
    // Guild-specific (instant, good for dev)
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands }
    );
  } else {
    // Global (takes up to 1 hour to propagate)
    await rest.put(Routes.applicationCommands(clientId), {
      body: commands,
    });
  }

  console.log("[discord] Slash commands registered");
}
