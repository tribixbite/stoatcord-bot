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
        .setName("stoat_server_id")
        .setDescription(
          "Existing Stoat server ID to migrate into (or leave blank to create new)"
        )
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
