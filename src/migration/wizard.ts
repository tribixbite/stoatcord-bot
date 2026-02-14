/** Interactive Discord migration wizard — slash command handler */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  ComponentType,
} from "discord.js";
import type { Store } from "../db/store.ts";
import type { StoatClient } from "../stoat/client.ts";
import { mapDiscordChannels, groupByCategory } from "./channels.ts";
import { mapDiscordRoles } from "./roles.ts";
import { executeMigration, type MigrationProgress } from "./progress.ts";

/**
 * Start the interactive migration wizard.
 * Shows a preview of Discord channels/roles, lets user confirm, then executes.
 */
export async function startMigrationWizard(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: Store,
  stoatClient: StoatClient,
  existingStoatServerId?: string
): Promise<void> {
  await interaction.deferReply();

  // Fetch full guild data
  await guild.channels.fetch();
  await guild.roles.fetch();

  // Map channels and roles
  const channelMappings = mapDiscordChannels(guild);
  const roleMappings = mapDiscordRoles(guild);
  const categoryGroups = groupByCategory(channelMappings);

  // Build preview embed
  const previewEmbed = new EmbedBuilder()
    .setTitle(`Migration Preview: ${guild.name}`)
    .setColor(0x4f8a5e)
    .setDescription(
      existingStoatServerId
        ? `Migrating into existing Stoat server \`${existingStoatServerId}\``
        : "A new Stoat server will be created"
    );

  // Channel list grouped by category
  let channelList = "";
  for (const [category, channels] of categoryGroups) {
    channelList += `**${category ?? "No Category"}**\n`;
    for (const ch of channels) {
      const icon = ch.stoatType === "Voice" ? "🔊" : "#";
      channelList += `  ${icon} ${ch.stoatName}\n`;
    }
  }
  if (channelList.length > 1024) {
    channelList = channelList.slice(0, 1020) + "...";
  }
  previewEmbed.addFields({
    name: `Channels (${channelMappings.length})`,
    value: channelList || "None",
    inline: false,
  });

  // Role list
  let roleList = roleMappings
    .map((r) => {
      const color = r.stoatColor ? ` (${r.stoatColor})` : "";
      return `• ${r.stoatName}${color}`;
    })
    .join("\n");
  if (roleList.length > 1024) {
    roleList = roleList.slice(0, 1020) + "...";
  }
  previewEmbed.addFields({
    name: `Roles (${roleMappings.length})`,
    value: roleList || "None",
    inline: false,
  });

  // Estimated time
  const totalOps = channelMappings.length + roleMappings.length;
  const estimatedSeconds = Math.ceil(totalOps * 2.5);
  previewEmbed.setFooter({
    text: `Estimated time: ~${estimatedSeconds}s | ${totalOps} operations`,
  });

  // Buttons
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("migrate_start")
      .setLabel("Start Migration")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("migrate_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );

  const response = await interaction.editReply({
    embeds: [previewEmbed],
    components: [row],
  });

  // Wait for button click (5 minute timeout)
  try {
    const buttonInteraction = await response.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id,
      time: 300_000,
    });

    if (buttonInteraction.customId === "migrate_cancel") {
      await buttonInteraction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle("Migration Cancelled")
            .setColor(0x888888),
        ],
        components: [],
      });
      return;
    }

    // Start migration
    await buttonInteraction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("Migration in Progress...")
          .setDescription("Starting...")
          .setColor(0xffaa00),
      ],
      components: [],
    });

    // Create or use Stoat server
    let stoatServerId = existingStoatServerId;
    if (!stoatServerId) {
      const created = await stoatClient.createServer(guild.name);
      stoatServerId = created.server._id;
      store.linkServer(guild.id, stoatServerId);
    } else {
      store.linkServer(guild.id, stoatServerId);
    }

    // Execute migration with progress updates
    const result = await executeMigration(
      stoatClient,
      store,
      guild.id,
      stoatServerId,
      channelMappings,
      roleMappings,
      async (progress: MigrationProgress) => {
        // Update progress embed every few steps to avoid rate limits
        if (
          progress.completedSteps % 3 === 0 ||
          progress.completedSteps === progress.totalSteps
        ) {
          const pct = Math.round(
            (progress.completedSteps / progress.totalSteps) * 100
          );
          const progressBar = buildProgressBar(pct);

          try {
            await interaction.editReply({
              embeds: [
                new EmbedBuilder()
                  .setTitle("Migration in Progress...")
                  .setDescription(
                    `${progressBar} ${pct}%\n\n${progress.currentAction}`
                  )
                  .setColor(0xffaa00)
                  .addFields({
                    name: "Progress",
                    value: `${progress.completedSteps}/${progress.totalSteps} operations`,
                  }),
              ],
            });
          } catch {
            // Ignore edit failures (rate limited)
          }
        }
      }
    );

    // Final results embed
    const successCount =
      result.totalSteps - result.errors.length - 1; // -1 for categories step
    const resultEmbed = new EmbedBuilder()
      .setTitle("Migration Complete")
      .setColor(result.errors.length > 0 ? 0xffaa00 : 0x00cc00)
      .addFields(
        {
          name: "Stoat Server",
          value: `\`${stoatServerId}\``,
          inline: true,
        },
        {
          name: "Created",
          value: `${successCount} items`,
          inline: true,
        },
        {
          name: "Errors",
          value: `${result.errors.length}`,
          inline: true,
        }
      );

    if (result.errors.length > 0) {
      const errorList = result.errors
        .slice(0, 10)
        .map((e) => `• ${e.action}: ${e.error}`)
        .join("\n");
      resultEmbed.addFields({
        name: "Error Details",
        value: errorList.slice(0, 1024),
      });
    }

    await interaction.editReply({
      embeds: [resultEmbed],
      components: [],
    });
  } catch {
    // Timeout — no button was clicked
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Migration Timed Out")
          .setDescription("No response received. Run `/migrate` again to restart.")
          .setColor(0x888888),
      ],
      components: [],
    });
  }
}

function buildProgressBar(pct: number): string {
  const filled = Math.round(pct / 5);
  const empty = 20 - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}
