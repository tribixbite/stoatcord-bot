/** Discord event handlers — routes interactions and messages to the right handler */

import {
  type Client,
  type Interaction,
  type ChatInputCommandInteraction,
  type Message as DiscordMessage,
  Events,
  EmbedBuilder,
} from "discord.js";
import type { Store } from "../db/store.ts";
import type { StoatClient } from "../stoat/client.ts";
import { startMigrationWizard, type MigrateMode, type MigrateCommandOptions } from "../migration/wizard.ts";
import { relayDiscordToStoat } from "../bridge/relay.ts";
import { ensureWebhook } from "../bridge/webhooks.ts";

export function registerDiscordEvents(
  client: Client,
  store: Store,
  stoatClient: StoatClient,
  stoatCdnUrl: string
): void {
  // --- Slash commands ---
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      switch (interaction.commandName) {
        case "migrate":
          await handleMigrate(interaction, store, stoatClient);
          break;

        case "link":
          await handleLink(interaction, store, client);
          break;

        case "unlink":
          await handleUnlink(interaction, store);
          break;

        case "status":
          await handleStatus(interaction, store);
          break;
      }
    } catch (err) {
      console.error(
        `[discord] Error handling /${interaction.commandName}:`,
        err
      );
      const reply = {
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        ephemeral: true,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  });

  // --- Message bridging (Discord → Stoat) ---
  client.on(Events.MessageCreate, async (message: DiscordMessage) => {
    // Ignore bots and system messages to prevent loops
    if (message.author.bot || message.system) return;

    const link = store.getChannelByDiscordId(message.channelId);
    if (!link) return; // not a linked channel

    try {
      await relayDiscordToStoat(message, link.stoat_channel_id, stoatClient, store);
    } catch (err) {
      console.error("[bridge] Discord→Stoat relay error:", err);
    }
  });

  client.on(Events.ClientReady, () => {
    console.log(`[discord] Logged in as ${client.user?.tag}`);
  });
}

// --- Command handlers ---

/**
 * /migrate command handler.
 * Security: Discord enforces Administrator permission via setDefaultMemberPermissions.
 * Additional checks in wizard.ts: bot must be a member of target Stoat server,
 * one-to-one guild↔server binding (prevents cross-guild hijacking).
 * Write permissions enforced by the Stoat API on each operation.
 */
async function handleMigrate(
  interaction: ChatInputCommandInteraction,
  store: Store,
  stoatClient: StoatClient
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  // Extract all options
  const options: MigrateCommandOptions = {
    claimCode: interaction.options.getString("claim_code") ?? undefined,
    stoatServerId: interaction.options.getString("stoat_server_id") ?? undefined,
    mode: (interaction.options.getString("mode") as MigrateMode | null) ?? "missing",
    dryRun: interaction.options.getBoolean("dry_run") ?? false,
    includeSnapshot: interaction.options.getBoolean("include_snapshot") ?? false,
    excludeMembers: interaction.options.getBoolean("exclude_members") ?? true,
    excludePins: interaction.options.getBoolean("exclude_pins") ?? false,
    includeMedia: interaction.options.getBoolean("include_media") ?? false,
  };

  await startMigrationWizard(
    interaction, guild, store, stoatClient,
    options,
    interaction.user.id, interaction.user.tag
  );
}

async function handleLink(
  interaction: ChatInputCommandInteraction,
  store: Store,
  client: Client
): Promise<void> {

  const stoatChannelId = interaction.options.getString("stoat_channel_id", true);
  const discordChannelId = interaction.channelId;

  // Check if already linked
  const existing = store.getChannelByDiscordId(discordChannelId);
  if (existing) {
    await interaction.reply({
      content: `This channel is already linked to Stoat channel \`${existing.stoat_channel_id}\`. Use \`/unlink\` first.`,
      ephemeral: true,
    });
    return;
  }

  // Create or fetch webhook for impersonation
  const channel = interaction.channel;
  if (!channel || !("createWebhook" in channel)) {
    await interaction.reply({
      content: "Cannot create webhook in this channel type.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const webhook = await ensureWebhook(channel as any, client);
  store.linkChannel(
    discordChannelId,
    stoatChannelId,
    webhook.id,
    webhook.token ?? undefined
  );

  await interaction.editReply({
    content: `Linked this channel to Stoat channel \`${stoatChannelId}\`. Messages will now bridge bidirectionally.`,
  });
}

async function handleUnlink(
  interaction: ChatInputCommandInteraction,
  store: Store
): Promise<void> {

  const link = store.getChannelByDiscordId(interaction.channelId);
  if (!link) {
    await interaction.reply({
      content: "This channel is not linked to any Stoat channel.",
      ephemeral: true,
    });
    return;
  }

  store.unlinkChannel(interaction.channelId);

  await interaction.reply({
    content: `Unlinked from Stoat channel \`${link.stoat_channel_id}\`. Bridging stopped.`,
    ephemeral: true,
  });
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  store: Store
): Promise<void> {

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const serverLink = store.getServerLink(guildId);
  const allLinks = store.getAllActiveChannelLinks();
  // Filter to channels in this guild by checking Discord channel cache
  const guildLinks = allLinks.filter((link) => {
    const ch = interaction.client.channels.cache.get(link.discord_channel_id);
    return ch && "guildId" in ch && ch.guildId === guildId;
  });

  const embed = new EmbedBuilder()
    .setTitle("Stoatcord Bridge Status")
    .setColor(0x4f8a5e)
    .addFields(
      {
        name: "Server Link",
        value: serverLink
          ? `Discord \`${guildId}\` → Stoat \`${serverLink.stoat_server_id}\``
          : "Not linked",
      },
      {
        name: `Bridged Channels (${guildLinks.length})`,
        value:
          guildLinks.length > 0
            ? guildLinks
                .map(
                  (l) =>
                    `<#${l.discord_channel_id}> → \`${l.stoat_channel_id}\``
                )
                .join("\n")
            : "None",
      }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
