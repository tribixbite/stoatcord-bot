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
import type { Server as StoatServer, Channel as StoatChannel } from "../stoat/types.ts";
import { mapDiscordChannels, groupByCategory } from "./channels.ts";
import { mapDiscordRoles } from "./roles.ts";
import { executeMigration, type MigrationProgress } from "./progress.ts";

export type MigrateMode = "missing" | "roles" | "categories" | "all";

/**
 * Start the interactive migration wizard.
 * Fetches existing Stoat server state to diff and avoid duplicates.
 */
export async function startMigrationWizard(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: Store,
  stoatClient: StoatClient,
  existingStoatServerId?: string,
  mode: MigrateMode = "missing",
  claimCode?: string
): Promise<void> {
  await interaction.deferReply();

  // --- Security checks ---

  if (existingStoatServerId) {
    // 1. Verify the bot can access the target Stoat server
    try {
      await stoatClient.getServer(existingStoatServerId);
    } catch (err) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Cannot Access Stoat Server")
            .setDescription(
              `The bot cannot access Stoat server \`${existingStoatServerId}\`. ` +
              `Make sure the bot is a member of the server.\n\n` +
              `Error: ${err}`
            )
            .setColor(0xff0000),
        ],
      });
      return;
    }

    // 2. Check if this Stoat server is already linked to a DIFFERENT Discord guild
    const existingLink = store.getGuildForStoatServer(existingStoatServerId);
    if (existingLink && existingLink.discord_guild_id !== guild.id) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Server Already Linked")
            .setDescription(
              `Stoat server \`${existingStoatServerId}\` is already linked to ` +
              `Discord guild \`${existingLink.discord_guild_id}\`. ` +
              `Each Stoat server can only be linked to one Discord guild.`
            )
            .setColor(0xff0000),
        ],
      });
      return;
    }

    // 3. Authorization: if this guild isn't already linked to this Stoat server,
    //    require a one-time claim code to prove the Discord admin controls the Stoat server.
    //    Codes are generated via POST /api/claim-code (requires API key + Stoat server access).
    const currentLink = store.getServerLink(guild.id);
    const alreadyLinked = currentLink?.stoat_server_id === existingStoatServerId;

    if (!alreadyLinked) {
      if (!claimCode) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("Claim Code Required")
              .setDescription(
                `To migrate into an existing Stoat server for the first time, ` +
                `you need a one-time **claim code**.\n\n` +
                `Generate one via the bot API:\n` +
                `\`\`\`\nPOST /api/claim-code\n{"stoatServerId": "${existingStoatServerId}"}\n\`\`\`\n` +
                `Then run:\n` +
                `\`/migrate stoat_server_id:${existingStoatServerId} claim_code:XXXXXX\``
              )
              .setColor(0xff9900),
          ],
        });
        return;
      }

      // Validate the claim code
      const claimedServerId = store.consumeClaimCode(claimCode.toUpperCase(), guild.id);
      if (!claimedServerId) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("Invalid Claim Code")
              .setDescription(
                `The claim code \`${claimCode}\` is invalid, expired, or already used.\n` +
                `Codes expire after 1 hour. Generate a new one via \`POST /api/claim-code\`.`
              )
              .setColor(0xff0000),
          ],
        });
        return;
      }

      // Verify the code was for THIS Stoat server
      if (claimedServerId !== existingStoatServerId) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("Claim Code Mismatch")
              .setDescription(
                `That claim code was generated for a different Stoat server, ` +
                `not \`${existingStoatServerId}\`.`
              )
              .setColor(0xff0000),
          ],
        });
        return;
      }

      console.log(
        `[migrate] Guild ${guild.id} claimed Stoat server ${existingStoatServerId} with code ${claimCode}`
      );
    }
  }

  // Fetch full guild data from Discord
  await guild.channels.fetch();
  await guild.roles.fetch();

  // Map all Discord channels and roles
  const allChannels = mapDiscordChannels(guild);
  const allRoles = mapDiscordRoles(guild);

  // If migrating into existing server, fetch its state for diffing
  let existingServer: StoatServer | null = null;
  let existingChannelNames = new Set<string>();
  let existingRoleNames = new Set<string>();

  if (existingStoatServerId) {
    try {
      existingServer = await stoatClient.getServer(existingStoatServerId);

      // Fetch channel names for comparison
      for (const chId of existingServer.channels) {
        try {
          const ch = await stoatClient.getChannel(chId);
          if (ch.name) existingChannelNames.add(ch.name.toLowerCase());
        } catch {
          // Channel may have been deleted
        }
      }

      // Collect existing role names
      if (existingServer.roles) {
        for (const role of Object.values(existingServer.roles)) {
          existingRoleNames.add(role.name.toLowerCase());
        }
      }

      console.log(
        `[migrate] Existing server has ${existingChannelNames.size} channels, ${existingRoleNames.size} roles`
      );
    } catch (err) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Migration Error")
            .setDescription(
              `Could not fetch Stoat server \`${existingStoatServerId}\`: ${err}`
            )
            .setColor(0xff0000),
        ],
      });
      return;
    }
  }

  // Apply mode filter — mark items as selected/deselected based on mode and existing state
  for (const ch of allChannels) {
    const alreadyExists = existingChannelNames.has(ch.stoatName.toLowerCase());

    switch (mode) {
      case "missing":
        // Only create channels that don't already exist
        ch.selected = !alreadyExists;
        break;
      case "roles":
        // Don't create any channels in roles-only mode
        ch.selected = false;
        break;
      case "categories":
        // Don't create channels, just organize existing ones
        ch.selected = false;
        break;
      case "all":
        // Create everything (user was warned about duplicates)
        ch.selected = true;
        break;
    }
  }

  for (const role of allRoles) {
    const alreadyExists = existingRoleNames.has(role.stoatName.toLowerCase());

    switch (mode) {
      case "missing":
        role.selected = !alreadyExists;
        break;
      case "roles":
        // Create roles that don't exist yet
        role.selected = !alreadyExists;
        break;
      case "categories":
        role.selected = false;
        break;
      case "all":
        role.selected = true;
        break;
    }
  }

  const selectedChannels = allChannels.filter((c) => c.selected);
  const selectedRoles = allRoles.filter((r) => r.selected);
  const skippedChannels = allChannels.filter((c) => !c.selected);
  const skippedRoles = allRoles.filter((r) => !r.selected);

  // Build preview embed
  const modeLabel: Record<MigrateMode, string> = {
    missing: "Missing only (skip existing)",
    roles: "Roles only",
    categories: "Categories only",
    all: "Everything (may duplicate!)",
  };

  const previewEmbed = new EmbedBuilder()
    .setTitle(`Migration Preview: ${guild.name}`)
    .setColor(0x4f8a5e)
    .setDescription(
      `**Mode**: ${modeLabel[mode]}\n` +
        (existingStoatServerId
          ? `**Target**: Existing Stoat server \`${existingStoatServerId}\``
          : "**Target**: New Stoat server (will be created)")
    );

  // Show what will be created
  if (mode === "categories") {
    // Categories-only mode: show category organization plan
    const categoryGroups = groupByCategory(allChannels);
    let catPlan = "";
    for (const [category, channels] of categoryGroups) {
      const existingCount = channels.filter((c) =>
        existingChannelNames.has(c.stoatName.toLowerCase())
      ).length;
      catPlan += `**${category ?? "No Category"}** — ${existingCount}/${channels.length} channels exist\n`;
    }
    previewEmbed.addFields({
      name: "Category Organization",
      value: (catPlan || "No categories to organize").slice(0, 1024),
    });
  } else {
    // Channels to create
    if (selectedChannels.length > 0) {
      const categoryGroups = groupByCategory(selectedChannels);
      let channelList = "";
      for (const [category, channels] of categoryGroups) {
        channelList += `**${category ?? "No Category"}**\n`;
        for (const ch of channels) {
          const icon = ch.stoatType === "Voice" ? "🔊" : "#";
          channelList += `  ${icon} ${ch.stoatName}\n`;
        }
      }
      previewEmbed.addFields({
        name: `Channels to create (${selectedChannels.length})`,
        value: channelList.slice(0, 1024) || "None",
      });
    }

    // Skipped channels
    if (skippedChannels.length > 0 && mode !== "roles") {
      previewEmbed.addFields({
        name: `Channels skipped (${skippedChannels.length})`,
        value: skippedChannels
          .slice(0, 15)
          .map((c) => `~~${c.stoatName}~~ (exists)`)
          .join(", ")
          .slice(0, 1024) +
          (skippedChannels.length > 15 ? ` +${skippedChannels.length - 15} more` : ""),
      });
    }

    // Roles to create
    if (selectedRoles.length > 0) {
      const roleList = selectedRoles
        .map((r) => {
          const color = r.stoatColor ? ` (${r.stoatColor})` : "";
          return `• ${r.stoatName}${color}`;
        })
        .join("\n");
      previewEmbed.addFields({
        name: `Roles to create (${selectedRoles.length})`,
        value: roleList.slice(0, 1024) || "None",
      });
    }

    // Skipped roles
    if (skippedRoles.length > 0 && mode !== "categories") {
      previewEmbed.addFields({
        name: `Roles skipped (${skippedRoles.length})`,
        value: skippedRoles
          .slice(0, 15)
          .map((r) => `~~${r.stoatName}~~ (exists)`)
          .join(", ")
          .slice(0, 1024) +
          (skippedRoles.length > 15 ? ` +${skippedRoles.length - 15} more` : ""),
      });
    }
  }

  // Nothing to do?
  const totalOps = selectedChannels.length + selectedRoles.length + (mode === "categories" ? 1 : 0);
  if (totalOps === 0 && mode !== "categories") {
    previewEmbed
      .setColor(0x00cc00)
      .setDescription(
        previewEmbed.data.description +
          "\n\n**Everything is already migrated.** Nothing new to create."
      );
    await interaction.editReply({ embeds: [previewEmbed] });
    return;
  }

  // Estimated time
  const estimatedSeconds = Math.ceil(totalOps * 2.5);
  previewEmbed.setFooter({
    text: `${totalOps} operation(s) | ~${estimatedSeconds}s estimated`,
  });

  // Confirm buttons
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("migrate_start")
      .setLabel(mode === "categories" ? "Organize Categories" : "Start Migration")
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
    }
    store.linkServer(guild.id, stoatServerId);

    if (mode === "categories") {
      // Categories-only: just organize existing channels
      await handleCategoriesOnly(
        interaction,
        stoatClient,
        store,
        guild,
        stoatServerId,
        allChannels,
        existingServer
      );
      return;
    }

    // Execute migration with progress updates
    const result = await executeMigration(
      stoatClient,
      store,
      guild.id,
      stoatServerId,
      allChannels, // executeMigration respects the `selected` flag
      allRoles,
      async (progress: MigrationProgress) => {
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
    const successCount = result.totalSteps - result.errors.length - 1; // -1 for categories step
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
          name: "Skipped",
          value: `${skippedChannels.length + skippedRoles.length} (already exist)`,
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

/**
 * Categories-only mode: don't create any channels or roles,
 * just organize existing Stoat channels into categories matching Discord's layout.
 */
async function handleCategoriesOnly(
  interaction: ChatInputCommandInteraction,
  stoatClient: StoatClient,
  store: Store,
  guild: Guild,
  stoatServerId: string,
  allChannels: ReturnType<typeof mapDiscordChannels>,
  existingServer: StoatServer | null
): Promise<void> {
  if (!existingServer) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Cannot Organize Categories")
          .setDescription("No existing Stoat server found. Run `/migrate` without `categories` mode first.")
          .setColor(0xff0000),
      ],
    });
    return;
  }

  // Build a name→id map of existing Stoat channels
  const stoatChannelMap = new Map<string, string>(); // lowercase name → channel id
  for (const chId of existingServer.channels) {
    try {
      const ch = await stoatClient.getChannel(chId);
      if (ch.name) stoatChannelMap.set(ch.name.toLowerCase(), ch._id);
    } catch {
      // skip deleted channels
    }
  }

  // Group Discord channels by category and resolve to Stoat channel IDs
  const categoryGroups = groupByCategory(allChannels);
  const categories: Array<{ id: string; title: string; channels: string[] }> = [];

  for (const [categoryName, channels] of categoryGroups) {
    if (!categoryName) continue; // skip uncategorized

    const stoatIds: string[] = [];
    for (const ch of channels) {
      const stoatId = stoatChannelMap.get(ch.stoatName.toLowerCase());
      if (stoatId) stoatIds.push(stoatId);
    }

    if (stoatIds.length > 0) {
      categories.push({
        id: generateCategoryId(),
        title: categoryName,
        channels: stoatIds,
      });
    }
  }

  if (categories.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("No Categories to Create")
          .setDescription("No matching channels found to organize into categories.")
          .setColor(0x888888),
      ],
    });
    return;
  }

  try {
    await stoatClient.editServer(stoatServerId, { categories });
    store.logMigration(guild.id, "categories_set", null, stoatServerId, "success");

    const summary = categories
      .map((c) => `**${c.title}** — ${c.channels.length} channel(s)`)
      .join("\n");

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Categories Organized")
          .setDescription(summary)
          .setColor(0x00cc00)
          .addFields({
            name: "Total",
            value: `${categories.length} categories created`,
          }),
      ],
      components: [],
    });
  } catch (err) {
    store.logMigration(
      guild.id,
      "categories_set",
      null,
      stoatServerId,
      "error",
      String(err)
    );
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Category Organization Failed")
          .setDescription(`Error: ${err}`)
          .setColor(0xff0000),
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

/** Generate a random category ID (Revolt uses short alphanumeric IDs) */
function generateCategoryId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
