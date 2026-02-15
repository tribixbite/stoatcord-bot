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
import type { Server as StoatServer } from "../stoat/types.ts";
import { mapDiscordChannels, groupByCategory } from "./channels.ts";
import { mapDiscordRoles } from "./roles.ts";
import {
  executeMigration,
  MigrationCancelledError,
  type MigrationProgress,
  type MigrationOptions,
} from "./progress.ts";
import { waitForApproval } from "./approval.ts";
import { generateMigrationSnapshot, splitSnapshotIntoMessages } from "./snapshot.ts";

export type MigrateMode = "missing" | "full" | "roles" | "categories";

/** Options extracted from the slash command */
export interface MigrateCommandOptions {
  mode: MigrateMode;
  claimCode?: string;
  stoatServerId?: string;
  dryRun: boolean;
  includeSnapshot: boolean;
  excludeMembers: boolean;
  excludePins: boolean;
  includeMedia: boolean;
}

/** Auth method resolved during authorization checks */
type AuthResult =
  | { method: "new_server"; stoatServerId: undefined; stoatUserId: undefined }
  | { method: "claim_code"; stoatServerId: string; stoatUserId: string | null }
  | { method: "live_approval"; stoatServerId: string; stoatUserId: string };

/**
 * Start the interactive migration wizard.
 * Three authorization paths:
 *   A) No server ID, no code — create a new Stoat server (bot-owned)
 *   B) Claim code provided — code validates identity + encodes server ID
 *   C) Server ID without code — live approval from Stoat server admin
 *
 * Every migration into an existing server requires fresh authorization.
 * No "already linked" bypass — re-runs always re-auth.
 */
export async function startMigrationWizard(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: Store,
  stoatClient: StoatClient,
  options: MigrateCommandOptions,
  discordUserId?: string,
  discordUserName?: string
): Promise<void> {
  await interaction.deferReply();

  const userId = discordUserId ?? interaction.user.id;
  const userName = discordUserName ?? interaction.user.tag;
  const {
    mode,
    claimCode,
    stoatServerId: existingStoatServerId,
    dryRun,
    includeSnapshot,
    excludeMembers,
    excludePins,
    includeMedia,
  } = options;

  // --- Authorization: resolve which path we're taking ---
  let auth: AuthResult;

  if (claimCode) {
    // PATH B: Claim code provided — validates identity and encodes server ID
    const normalizedCode = claimCode.toUpperCase().trim();

    const claimedServerId = store.consumeClaimCode(normalizedCode, guild.id, userId);
    if (!claimedServerId) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Invalid Claim Code")
            .setDescription(
              `The claim code \`${normalizedCode}\` is invalid, expired, or already used.\n` +
              `Codes expire after 1 hour.\n\n` +
              `Ask a Stoat server admin to generate a new code with \`!stoatcord code\`.`
            )
            .setColor(0xff0000),
        ],
      });
      return;
    }

    // If stoat_server_id was also provided, verify it matches the code's server
    if (existingStoatServerId && claimedServerId !== existingStoatServerId) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Claim Code Mismatch")
            .setDescription(
              `That claim code was generated for Stoat server \`${claimedServerId}\`, ` +
              `not \`${existingStoatServerId}\`.\n\n` +
              `Tip: you don't need to provide \`stoat_server_id\` when using a code — the code includes the server.`
            )
            .setColor(0xff0000),
        ],
      });
      return;
    }

    // Verify bot can access the target server
    try {
      await stoatClient.getServer(claimedServerId);
    } catch (err) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Cannot Access Stoat Server")
            .setDescription(
              `The bot cannot access Stoat server \`${claimedServerId}\`.\n` +
              `Make sure the bot is a member of the server.\n\nError: ${err}`
            )
            .setColor(0xff0000),
        ],
      });
      return;
    }

    // Check cross-guild binding — another guild can't claim the same server
    const existingLink = store.getGuildForStoatServer(claimedServerId);
    if (existingLink && existingLink.discord_guild_id !== guild.id) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Server Already Linked")
            .setDescription(
              `Stoat server \`${claimedServerId}\` is already linked to ` +
              `a different Discord guild. Each Stoat server can only be linked to one Discord guild.`
            )
            .setColor(0xff0000),
        ],
      });
      return;
    }

    // Look up who created the code for audit trail
    const codeRow = store.getClaimCode(normalizedCode);
    const stoatUserId = codeRow?.created_by_stoat_user ?? null;

    console.log(
      `[migrate] Guild ${guild.id} claimed Stoat server ${claimedServerId} with code ${normalizedCode} (Discord user: ${userId})`
    );

    auth = { method: "claim_code", stoatServerId: claimedServerId, stoatUserId };

  } else if (existingStoatServerId) {
    // PATH C: Live approval — send request to Stoat server, wait for admin reply
    try {
      await stoatClient.getServer(existingStoatServerId);
    } catch (err) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Cannot Access Stoat Server")
            .setDescription(
              `The bot cannot access Stoat server \`${existingStoatServerId}\`.\n` +
              `Make sure the bot is a member of the server.\n\nError: ${err}`
            )
            .setColor(0xff0000),
        ],
      });
      return;
    }

    // Cross-guild binding check
    const existingLink = store.getGuildForStoatServer(existingStoatServerId);
    if (existingLink && existingLink.discord_guild_id !== guild.id) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Server Already Linked")
            .setDescription(
              `Stoat server \`${existingStoatServerId}\` is already linked to ` +
              `a different Discord guild. Each Stoat server can only be linked to one Discord guild.`
            )
            .setColor(0xff0000),
        ],
      });
      return;
    }

    // Cancel any existing pending request for this Stoat server
    const existingReq = store.getPendingRequestForServer(existingStoatServerId);
    if (existingReq) {
      store.resolveMigrationRequest(existingReq.id, "cancelled");
    }

    // Find a text channel to post the approval request in
    const server = await stoatClient.getServer(existingStoatServerId);
    let targetChannelId: string | null = null;

    // Prefer system messages channel, then first text channel
    if (server.system_messages?.user_joined) {
      targetChannelId = server.system_messages.user_joined;
    }
    if (!targetChannelId && server.channels.length > 0) {
      // Find first text channel the bot can post in
      for (const chId of server.channels) {
        try {
          const ch = await stoatClient.getChannel(chId);
          if (ch.channel_type === "TextChannel") {
            targetChannelId = chId;
            break;
          }
        } catch {
          // skip inaccessible channels
        }
      }
    }

    if (!targetChannelId) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("No Text Channel Found")
            .setDescription(
              `Could not find a text channel in Stoat server \`${existingStoatServerId}\` ` +
              `to post the approval request.\n\n` +
              `Ask a Stoat server admin to generate a code with \`!stoatcord code\` instead.`
            )
            .setColor(0xff0000),
        ],
      });
      return;
    }

    // Create DB record for the migration request
    const requestId = generateRequestId();
    const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 minutes

    store.createMigrationRequest({
      id: requestId,
      discordGuildId: guild.id,
      discordGuildName: guild.name,
      discordUserId: userId,
      discordUserName: userName,
      stoatServerId: existingStoatServerId,
      stoatChannelId: targetChannelId,
      expiresAt,
    });

    // Send approval request message to the Stoat channel
    const approvalMsg = await stoatClient.sendMessage(
      targetChannelId,
      `**Migration Approval Request**\n\n` +
      `Discord guild **${guild.name}** (\`${guild.id}\`) wants to link with this Stoat server.\n` +
      `Requested by Discord user **${userName}**.\n\n` +
      `A server admin must **reply to this message** with:\n` +
      `- \`approve\` / \`yes\` / \`confirm\` — to allow the migration\n` +
      `- \`deny\` / \`reject\` / \`no\` — to block it\n\n` +
      `This request expires in **5 minutes**.`
    );

    // Store the message ID so the reply handler can find it
    store.setMigrationRequestMessageId(requestId, approvalMsg._id);

    // Update Discord to show waiting status
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Waiting for Stoat Server Approval...")
          .setDescription(
            `An approval request has been sent to the Stoat server.\n\n` +
            `A Stoat server admin must reply **approve** to the bot's message within 5 minutes.\n\n` +
            `Server: \`${existingStoatServerId}\`\nChannel: \`${targetChannelId}\``
          )
          .setColor(0xffaa00),
      ],
    });

    // Wait for the Stoat admin to approve (or timeout)
    let approvedByUserId: string;
    try {
      approvedByUserId = await waitForApproval(approvalMsg._id, requestId, 300_000);
    } catch (err) {
      // Timeout or rejection
      const errMsg = err instanceof Error ? err.message : String(err);
      store.resolveMigrationRequest(requestId, "expired");

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Migration Request Failed")
            .setDescription(
              `${errMsg}\n\n` +
              `Run \`/migrate\` again to retry, or ask a Stoat admin to generate a code with \`!stoatcord code\`.`
            )
            .setColor(0xff0000),
        ],
      });
      return;
    }

    console.log(
      `[migrate] Live approval granted for guild ${guild.id} → server ${existingStoatServerId} by Stoat user ${approvedByUserId}`
    );

    auth = { method: "live_approval", stoatServerId: existingStoatServerId, stoatUserId: approvedByUserId };

  } else {
    // PATH A: No server ID, no code — create a new Stoat server
    auth = { method: "new_server", stoatServerId: undefined, stoatUserId: undefined };
  }

  // Fetch full guild data from Discord
  await guild.channels.fetch();
  await guild.roles.fetch();

  // Map all Discord channels and roles
  const allChannels = mapDiscordChannels(guild);
  const allRoles = mapDiscordRoles(guild);

  // Resolve effective Stoat server ID from auth result
  const effectiveStoatServerId = auth.stoatServerId;

  // If migrating into existing server, fetch its state for diffing
  let existingServer: StoatServer | null = null;
  let existingChannelNames = new Set<string>();
  let existingRoleNames = new Set<string>();

  if (effectiveStoatServerId) {
    try {
      existingServer = await stoatClient.getServer(effectiveStoatServerId);

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
              `Could not fetch Stoat server \`${effectiveStoatServerId}\`: ${err}`
            )
            .setColor(0xff0000),
        ],
      });
      return;
    }
  }

  // Apply mode filter — mark items as selected/deselected based on mode and existing state
  // "full" mode: select ALL items (create new + update existing)
  // "missing" mode: select only items that don't exist yet (but executeMigration will still update matched ones)
  for (const ch of allChannels) {
    const alreadyExists = existingChannelNames.has(ch.stoatName.toLowerCase());

    switch (mode) {
      case "missing":
        // Create missing + update existing (executeMigration handles both via name matching)
        ch.selected = true;
        break;
      case "full":
        // Create missing + update existing — same as missing but explicitly "full"
        ch.selected = true;
        break;
      case "roles":
        // Don't create any channels in roles-only mode
        ch.selected = false;
        break;
      case "categories":
        // Don't create channels, just organize existing ones
        ch.selected = false;
        break;
    }
  }

  for (const role of allRoles) {
    const alreadyExists = existingRoleNames.has(role.stoatName.toLowerCase());

    switch (mode) {
      case "missing":
        // Select all — executeMigration will create new and update existing
        role.selected = true;
        break;
      case "full":
        role.selected = true;
        break;
      case "roles":
        // Select all roles in roles-only mode
        role.selected = true;
        break;
      case "categories":
        role.selected = false;
        break;
    }
  }

  const selectedChannels = allChannels.filter((c) => c.selected);
  const selectedRoles = allRoles.filter((r) => r.selected);

  // Count what will be created vs updated for preview
  const newChannels = selectedChannels.filter((c) => !existingChannelNames.has(c.stoatName.toLowerCase()));
  const updateChannels = selectedChannels.filter((c) => existingChannelNames.has(c.stoatName.toLowerCase()));
  const newRoles = selectedRoles.filter((r) => !existingRoleNames.has(r.stoatName.toLowerCase()));
  const updateRoles = selectedRoles.filter((r) => existingRoleNames.has(r.stoatName.toLowerCase()));
  const skippedChannels = allChannels.filter((c) => !c.selected);
  const skippedRoles = allRoles.filter((r) => !r.selected);

  // Build preview embed
  const modeLabel: Record<MigrateMode, string> = {
    missing: "Create missing + update existing",
    full: "Full sync (create + update all)",
    roles: "Roles only",
    categories: "Categories only",
  };

  const previewEmbed = new EmbedBuilder()
    .setTitle(`Migration Preview: ${guild.name}`)
    .setColor(0x4f8a5e)
    .setDescription(
      `**Mode**: ${modeLabel[mode]}\n` +
        `**Auth**: ${auth.method.replace("_", " ")}\n` +
        (effectiveStoatServerId
          ? `**Target**: Existing Stoat server \`${effectiveStoatServerId}\``
          : "**Target**: New Stoat server (will be created)") +
        (dryRun ? "\n**Dry run**: Yes (no changes will be made)" : "") +
        (includeSnapshot ? "\n**Snapshot**: Will post to #migration-log" : "") +
        (includeMedia ? "\n**Media**: Will upload icon/banner/emoji" : "")
    );

  // Show what will be created/updated
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
    if (newChannels.length > 0) {
      const categoryGroups = groupByCategory(newChannels);
      let channelList = "";
      for (const [category, channels] of categoryGroups) {
        channelList += `**${category ?? "No Category"}**\n`;
        for (const ch of channels) {
          const icon = ch.stoatType === "Voice" ? "🔊" : "#";
          const props: string[] = [];
          if (ch.topic) props.push("topic");
          if (ch.nsfw) props.push("nsfw");
          channelList += `  ${icon} ${ch.stoatName}${props.length > 0 ? ` (${props.join(", ")})` : ""}\n`;
        }
      }
      previewEmbed.addFields({
        name: `Channels to create (${newChannels.length})`,
        value: channelList.slice(0, 1024) || "None",
      });
    }

    // Channels to update
    if (updateChannels.length > 0) {
      previewEmbed.addFields({
        name: `Channels to update (${updateChannels.length})`,
        value: updateChannels
          .slice(0, 15)
          .map((c) => {
            const props: string[] = [];
            if (c.topic) props.push("description");
            if (c.nsfw) props.push("nsfw");
            return `• ${c.stoatName}${props.length > 0 ? ` (${props.join(", ")})` : ""}`;
          })
          .join("\n")
          .slice(0, 1024) +
          (updateChannels.length > 15 ? `\n+${updateChannels.length - 15} more` : ""),
      });
    }

    // Skipped channels
    if (skippedChannels.length > 0 && mode !== "roles") {
      previewEmbed.addFields({
        name: `Channels skipped (${skippedChannels.length})`,
        value: skippedChannels
          .slice(0, 15)
          .map((c) => `~~${c.stoatName}~~`)
          .join(", ")
          .slice(0, 1024) +
          (skippedChannels.length > 15 ? ` +${skippedChannels.length - 15} more` : ""),
      });
    }

    // Roles to create
    if (newRoles.length > 0) {
      const roleList = newRoles
        .map((r) => {
          const props: string[] = [];
          if (r.stoatColor) props.push(r.stoatColor);
          if (r.hoist) props.push("hoisted");
          return `• ${r.stoatName}${props.length > 0 ? ` (${props.join(", ")})` : ""}`;
        })
        .join("\n");
      previewEmbed.addFields({
        name: `Roles to create (${newRoles.length})`,
        value: roleList.slice(0, 1024) || "None",
      });
    }

    // Roles to update
    if (updateRoles.length > 0) {
      previewEmbed.addFields({
        name: `Roles to update (${updateRoles.length})`,
        value: updateRoles
          .slice(0, 15)
          .map((r) => `• ${r.stoatName}`)
          .join("\n")
          .slice(0, 1024) +
          (updateRoles.length > 15 ? `\n+${updateRoles.length - 15} more` : ""),
      });
    }

    // Skipped roles
    if (skippedRoles.length > 0) {
      previewEmbed.addFields({
        name: `Roles skipped (${skippedRoles.length})`,
        value: skippedRoles
          .slice(0, 15)
          .map((r) => `~~${r.stoatName}~~`)
          .join(", ")
          .slice(0, 1024) +
          (skippedRoles.length > 15 ? ` +${skippedRoles.length - 15} more` : ""),
      });
    }
  }

  // Nothing to do?
  const totalOps = selectedChannels.length + selectedRoles.length + (mode === "categories" ? 1 : 0);
  if (totalOps === 0 && mode !== "categories" && !includeSnapshot) {
    previewEmbed
      .setColor(0x00cc00)
      .setDescription(
        previewEmbed.data.description +
          "\n\n**Everything is already migrated.** Nothing new to create or update."
      );
    await interaction.editReply({ embeds: [previewEmbed] });
    return;
  }

  // Estimated time
  const estimatedSeconds = Math.ceil(totalOps * 2.5);
  previewEmbed.setFooter({
    text: `${totalOps} operation(s) | ~${estimatedSeconds}s estimated`,
  });

  // Confirm buttons — Start, Dry Run, Cancel
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("migrate_start")
      .setLabel(mode === "categories" ? "Organize Categories" : "Start Migration")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("migrate_dryrun")
      .setLabel("Dry Run")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("migrate_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );

  // If dryRun was set via slash command option, skip button selection
  if (dryRun) {
    await runMigration(
      interaction, guild, store, stoatClient, auth,
      allChannels, allRoles, mode, existingServer, userId,
      true, includeSnapshot, excludeMembers, excludePins, includeMedia
    );
    return;
  }

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

    const isDryRun = buttonInteraction.customId === "migrate_dryrun";

    // Acknowledge button click
    await buttonInteraction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle(isDryRun ? "Dry Run in Progress..." : "Migration in Progress...")
          .setDescription("Starting...")
          .setColor(isDryRun ? 0x5865f2 : 0xffaa00),
      ],
      components: [],
    });

    await runMigration(
      interaction, guild, store, stoatClient, auth,
      allChannels, allRoles, mode, existingServer, userId,
      isDryRun, includeSnapshot, excludeMembers, excludePins, includeMedia
    );
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
 * Execute the migration (or dry run) with progress tracking and cancel support.
 * Extracted from the main wizard to handle both button-triggered and option-triggered runs.
 */
async function runMigration(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: Store,
  stoatClient: StoatClient,
  auth: AuthResult,
  allChannels: ReturnType<typeof mapDiscordChannels>,
  allRoles: ReturnType<typeof mapDiscordRoles>,
  mode: MigrateMode,
  existingServer: StoatServer | null,
  userId: string,
  isDryRun: boolean,
  includeSnapshot: boolean,
  excludeMembers: boolean,
  excludePins: boolean,
  includeMedia: boolean
): Promise<void> {
  // Create or use Stoat server based on auth path
  let stoatServerId = auth.stoatServerId;
  if (!stoatServerId) {
    if (isDryRun) {
      // Can't dry-run server creation — would need a real server ID
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Dry Run — New Server")
            .setDescription(
              "Dry run completed. A new Stoat server would be created and all channels/roles would be migrated.\n" +
              "Use **Start Migration** to actually create the server."
            )
            .setColor(0x5865f2),
        ],
      });
      return;
    }
    const created = await stoatClient.createServer(guild.name, guild.description ?? undefined);
    stoatServerId = created.server._id;
  }
  store.linkServer(guild.id, stoatServerId, auth.method, userId, auth.stoatUserId ?? undefined);

  if (mode === "categories" && !isDryRun) {
    // Categories-only: just organize existing channels
    await handleCategoriesOnly(
      interaction, stoatClient, store, guild, stoatServerId,
      allChannels, existingServer, userId, auth.stoatUserId ?? undefined
    );
    return;
  }

  // Set up AbortController for mid-flight cancellation
  const abortController = new AbortController();

  // Build migration options
  const migrationOptions: MigrationOptions = {
    dryRun: isDryRun,
    signal: abortController.signal,
    includeEmoji: includeMedia,
    includeMedia,
    guild,
  };

  // Show cancel button during execution (only for live runs)
  if (!isDryRun) {
    const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("migrate_abort")
        .setLabel("Cancel Migration")
        .setStyle(ButtonStyle.Danger)
    );

    // Listen for cancel button in background
    const message = await interaction.fetchReply();
    const cancelCollector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id && i.customId === "migrate_abort",
      time: 600_000, // 10 minutes
      max: 1,
    });

    cancelCollector.on("collect", async (i) => {
      abortController.abort();
      try {
        await i.update({
          embeds: [
            new EmbedBuilder()
              .setTitle("Cancelling Migration...")
              .setDescription("Waiting for current operation to finish...")
              .setColor(0xff6600),
          ],
          components: [],
        });
      } catch {
        // Ignore if interaction already replied
      }
    });

    // Update embed with cancel button
    try {
      await interaction.editReply({ components: [cancelRow] });
    } catch {
      // Ignore
    }
  }

  // Execute migration with progress updates
  let result: MigrationProgress;
  try {
    result = await executeMigration(
      stoatClient, store, guild.id, stoatServerId,
      allChannels, allRoles, userId, auth.stoatUserId ?? undefined,
      async (progress: MigrationProgress) => {
        if (
          progress.completedSteps % 3 === 0 ||
          progress.completedSteps === progress.totalSteps
        ) {
          const pct = Math.round(
            (progress.completedSteps / progress.totalSteps) * 100
          );
          const progressBar = buildProgressBar(pct);
          const title = isDryRun ? "Dry Run in Progress..." : "Migration in Progress...";

          try {
            await interaction.editReply({
              embeds: [
                new EmbedBuilder()
                  .setTitle(title)
                  .setDescription(
                    `${progressBar} ${pct}%\n\n${progress.currentAction}`
                  )
                  .setColor(isDryRun ? 0x5865f2 : 0xffaa00)
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
      },
      migrationOptions
    );
  } catch (err) {
    if (err instanceof MigrationCancelledError) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Migration Cancelled")
            .setDescription(
              "Migration was cancelled. Partial progress has been preserved.\n" +
              "You can run `/migrate` again to continue where you left off."
            )
            .setColor(0xff6600),
        ],
        components: [],
      });
      return;
    }
    throw err;
  }

  // --- Build results embed ---
  if (isDryRun) {
    // Dry run results
    const dryRunEmbed = new EmbedBuilder()
      .setTitle("Dry Run Complete")
      .setColor(0x5865f2)
      .addFields(
        { name: "Would Create", value: `${result.created}`, inline: true },
        { name: "Would Update", value: `${result.updated}`, inline: true },
        { name: "Warnings", value: `${result.warnings.length}`, inline: true },
      );

    // Show planned actions
    if (result.dryRunLog.length > 0) {
      const logText = result.dryRunLog
        .slice(0, 25)
        .map((l) => `• ${l}`)
        .join("\n");
      dryRunEmbed.addFields({
        name: "Planned Actions",
        value: (logText + (result.dryRunLog.length > 25 ? `\n+${result.dryRunLog.length - 25} more` : "")).slice(0, 1024),
      });
    }

    if (result.warnings.length > 0) {
      const warnText = result.warnings
        .slice(0, 10)
        .map((w) => `⚠ ${w}`)
        .join("\n");
      dryRunEmbed.addFields({
        name: "Warnings",
        value: (warnText + (result.warnings.length > 10 ? `\n+${result.warnings.length - 10} more` : "")).slice(0, 1024),
      });
    }

    await interaction.editReply({
      embeds: [dryRunEmbed],
      components: [],
    });
    return;
  }

  // Live results
  const resultEmbed = new EmbedBuilder()
    .setTitle("Migration Complete")
    .setColor(result.errors.length > 0 ? 0xffaa00 : 0x00cc00)
    .addFields(
      { name: "Stoat Server", value: `\`${stoatServerId}\``, inline: true },
      { name: "Created", value: `${result.created}`, inline: true },
      { name: "Updated", value: `${result.updated}`, inline: true },
      { name: "Errors", value: `${result.errors.length}`, inline: true },
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

  if (result.warnings.length > 0) {
    const warnText = result.warnings
      .slice(0, 5)
      .map((w) => `⚠ ${w}`)
      .join("\n");
    resultEmbed.addFields({
      name: "Warnings",
      value: (warnText + (result.warnings.length > 5 ? `\n+${result.warnings.length - 5} more` : "")).slice(0, 1024),
    });
  }

  await interaction.editReply({
    embeds: [resultEmbed],
    components: [],
  });

  // --- Post-migration: snapshot to #migration-log ---
  if (includeSnapshot && stoatServerId) {
    try {
      await postMigrationSnapshot(
        stoatClient, store, guild, stoatServerId,
        !excludeMembers, !excludePins, includeMedia
      );
    } catch (err) {
      console.error("[migrate] Snapshot posting failed:", err);
      // Non-fatal — migration itself succeeded
    }
  }
}

/**
 * Generate and post a full data snapshot to #migration-log in the Stoat server.
 * Creates the channel if it doesn't exist, with restricted default permissions.
 */
async function postMigrationSnapshot(
  stoatClient: StoatClient,
  store: Store,
  guild: Guild,
  stoatServerId: string,
  includeMembers: boolean,
  includePins: boolean,
  includeMedia: boolean
): Promise<void> {
  // Find or create #migration-log channel
  const server = await stoatClient.getServer(stoatServerId);
  let logChannelId: string | null = null;

  for (const chId of server.channels) {
    try {
      const ch = await stoatClient.getChannel(chId);
      if (ch.name?.toLowerCase() === "migration-log") {
        logChannelId = ch._id;
        break;
      }
    } catch {
      // Skip inaccessible
    }
  }

  if (!logChannelId) {
    // Create the channel
    const logChannel = await stoatClient.createChannel(stoatServerId, {
      type: "Text",
      name: "migration-log",
      description: "Discord migration data snapshot — restricted access",
    });
    logChannelId = logChannel._id;

    // Restrict default permissions: deny ViewChannel for @everyone
    // Stoat uses the channel's default_permissions to override the server default
    try {
      await stoatClient.setChannelDefaultPermissions(logChannelId, {
        a: 0,
        d: Number(1n << 20n), // Deny ViewChannel
      });
    } catch (err) {
      console.warn("[migrate] Could not restrict #migration-log permissions:", err);
    }
  }

  // Generate snapshot
  const snapshot = await generateMigrationSnapshot(guild, stoatClient, {
    includeMembers,
    includePins,
    includeMedia,
  });

  // Split into messages
  const messages = splitSnapshotIntoMessages(snapshot);

  // Post each message to #migration-log
  for (let i = 0; i < messages.length; i++) {
    const prefix = messages.length > 1 ? `**[${i + 1}/${messages.length}]**\n` : "";
    await stoatClient.sendMessage(logChannelId!, prefix + messages[i]!.content);

    // Rate limit: don't spam the channel
    if (i < messages.length - 1) {
      await (await import("../util.ts")).sleep(1500);
    }
  }

  console.log(`[migrate] Posted ${messages.length} snapshot message(s) to #migration-log`);
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
  existingServer: StoatServer | null,
  discordUserId?: string,
  stoatUserId?: string
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
    store.logMigration(guild.id, "categories_set", null, stoatServerId, "success", undefined, discordUserId, stoatUserId);

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
      guild.id, "categories_set", null, stoatServerId, "error",
      String(err), discordUserId, stoatUserId
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

/** Generate a unique request ID for migration approval tracking */
function generateRequestId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const timestamp = Date.now().toString(36);
  let random = "";
  for (let i = 0; i < 8; i++) {
    random += chars[Math.floor(Math.random() * chars.length)];
  }
  return `mr_${timestamp}_${random}`;
}
