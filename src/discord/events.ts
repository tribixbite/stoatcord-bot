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
import { exportDiscordChannel } from "../archive/export.ts";
import { importToStoat } from "../archive/import.ts";
import { registerJob, abortJob, unregisterJob, isJobActive } from "../archive/manager.ts";
import {
  relayDiscordToStoat,
  relayDiscordEditToStoat,
  relayDiscordDeleteToStoat,
  relayDiscordReactionToStoat,
  relayDiscordUnreactionToStoat,
  relayDiscordTypingToStoat,
  relayDiscordChannelUpdateToStoat,
} from "../bridge/relay.ts";
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

        case "archive":
          await handleArchive(interaction, store, stoatClient, client);
          break;

        case "token":
          await handleToken(interaction, store);
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

  // --- Edit sync (Discord → Stoat) ---
  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    // Partial messages need fetching; skip if no content change
    if (!newMessage.content) return;
    // Ignore bot edits to prevent loops
    if (newMessage.author?.bot) return;

    const link = store.getChannelByDiscordId(newMessage.channelId);
    if (!link) return;

    try {
      await relayDiscordEditToStoat(
        newMessage.id,
        newMessage.content,
        store,
        stoatClient
      );
    } catch (err) {
      console.error("[bridge] Discord→Stoat edit relay error:", err);
    }
  });

  // --- Delete sync (Discord → Stoat) ---
  client.on(Events.MessageDelete, async (message) => {
    try {
      await relayDiscordDeleteToStoat(message.id, store, stoatClient);
    } catch (err) {
      console.error("[bridge] Discord→Stoat delete relay error:", err);
    }
  });

  // --- Bulk delete sync (Discord → Stoat) ---
  client.on(Events.MessageBulkDelete, async (messages) => {
    for (const message of messages.values()) {
      try {
        await relayDiscordDeleteToStoat(message.id, store, stoatClient);
      } catch (err) {
        console.error("[bridge] Discord→Stoat bulk delete relay error:", err);
      }
    }
  });

  // --- Typing relay (Discord → Stoat) ---
  client.on(Events.TypingStart, async (typing) => {
    if (typing.user.bot) return;

    const link = store.getChannelByDiscordId(typing.channel.id);
    if (!link) return;

    try {
      await relayDiscordTypingToStoat(
        typing.channel.id,
        typing.user.id,
        link.stoat_channel_id,
        stoatClient
      );
    } catch (err) {
      // Typing failures are non-critical
      console.warn("[bridge] Discord→Stoat typing relay error:", err);
    }
  });

  // --- Reaction sync (Discord → Stoat) ---
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot) return;

    const link = store.getChannelByDiscordId(reaction.message.channelId);
    if (!link) return;

    try {
      await relayDiscordReactionToStoat(
        reaction.message.id,
        reaction.emoji.name ?? reaction.emoji.id ?? "",
        store,
        stoatClient
      );
    } catch (err) {
      console.warn("[bridge] Discord→Stoat reaction relay error:", err);
    }
  });

  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    if (user.bot) return;

    const link = store.getChannelByDiscordId(reaction.message.channelId);
    if (!link) return;

    try {
      await relayDiscordUnreactionToStoat(
        reaction.message.id,
        reaction.emoji.name ?? reaction.emoji.id ?? "",
        store,
        stoatClient
      );
    } catch (err) {
      console.warn("[bridge] Discord→Stoat unreaction relay error:", err);
    }
  });

  // --- Channel metadata sync (Discord → Stoat) ---
  client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
    if (!("guildId" in newChannel)) return;

    const link = store.getChannelByDiscordId(newChannel.id);
    if (!link) return;

    try {
      await relayDiscordChannelUpdateToStoat(
        oldChannel as import("discord.js").GuildChannel,
        newChannel as import("discord.js").GuildChannel,
        link.stoat_channel_id,
        stoatClient
      );
    } catch (err) {
      console.error("[bridge] Discord→Stoat channel metadata sync error:", err);
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

/** /token — view or regenerate this guild's API token */
async function handleToken(
  interaction: ChatInputCommandInteraction,
  store: Store
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return;
  }

  const serverLink = store.getServerLink(guildId);
  if (!serverLink) {
    await interaction.reply({
      content: "This server is not linked to a Stoat server. Run `/migrate` first.",
      ephemeral: true,
    });
    return;
  }

  const regenerate = interaction.options.getBoolean("regenerate") ?? false;
  let token = serverLink.api_token;

  if (regenerate) {
    token = store.regenerateGuildToken(guildId);
  }

  if (!token) {
    // Shouldn't happen — backfill should have handled it, but just in case
    token = store.regenerateGuildToken(guildId);
  }

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(regenerate ? "API Token Regenerated" : "API Token")
        .setColor(regenerate ? 0xe74c3c : 0x4f8a5e)
        .setDescription(
          `Use this token in the \`Authorization\` header for archive API calls.\n\n` +
          `**Token:** \`${token}\`\n\n` +
          `**Usage:**\n\`\`\`\ncurl -H "Authorization: Bearer ${token}" \\\n  https://api.stoatcord.com/api/archive/status\n\`\`\`` +
          (regenerate ? "\n\nThe previous token has been invalidated." : "")
        )
        .setTimestamp(),
    ],
    ephemeral: true,
  });
}

// Archive job tracking uses the shared manager from archive/manager.ts

/**
 * /archive command handler with subcommands: start, status, pause, resume
 */
async function handleArchive(
  interaction: ChatInputCommandInteraction,
  store: Store,
  stoatClient: StoatClient,
  client: Client
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "start":
      await handleArchiveStart(interaction, store, stoatClient, client);
      break;
    case "status":
      await handleArchiveStatus(interaction, store);
      break;
    case "pause":
      await handleArchivePause(interaction, store);
      break;
    case "resume":
      await handleArchiveResume(interaction, store, stoatClient, client);
      break;
  }
}

/** /archive start — begin exporting this channel's history */
async function handleArchiveStart(
  interaction: ChatInputCommandInteraction,
  store: Store,
  stoatClient: StoatClient,
  client: Client
): Promise<void> {
  const channelId = interaction.channelId;
  const guildId = interaction.guildId!;
  const stoatChannelId = interaction.options.getString("stoat_channel_id") ?? undefined;
  const rehostAttachments = interaction.options.getBoolean("rehost_attachments") ?? false;
  const preserveEmbeds = interaction.options.getBoolean("preserve_embeds") ?? false;

  // Check for existing active job
  const existing = store.getActiveExportJob(channelId);
  if (existing) {
    await interaction.reply({
      content: `An archive job for this channel is already ${existing.status} (job \`${existing.id}\`). Use \`/archive pause\` first.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  // Create the archive job
  const channelName = (interaction.channel && "name" in interaction.channel)
    ? (interaction.channel as import("discord.js").TextChannel).name
    : channelId;

  const jobId = store.createArchiveJob({
    guildId,
    discordChannelId: channelId,
    discordChannelName: channelName,
    stoatChannelId,
    direction: "export",
  });

  const exportSignal = registerJob(jobId);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Archive Export Started")
        .setColor(0x4f8a5e)
        .setDescription(`Exporting message history from <#${channelId}>...`)
        .addFields(
          { name: "Job ID", value: `\`${jobId}\``, inline: true },
          { name: "Import to Stoat", value: stoatChannelId ? `\`${stoatChannelId}\`` : "Export only", inline: true },
        )
        .setTimestamp(),
    ],
  });

  // Run export in background (don't block the interaction)
  exportDiscordChannel(client, store, jobId, channelId, exportSignal, (progress) => {
    if (progress.status === "completed" || progress.status === "failed") {
      unregisterJob(jobId);
    }
  }).then(async (count) => {
    unregisterJob(jobId);
    // Export complete — if stoatChannelId provided, start import
    if (stoatChannelId && count > 0) {
      const importJobId = store.createArchiveJob({
        guildId,
        discordChannelId: channelId,
        discordChannelName: channelName,
        stoatChannelId,
        direction: "import",
      });

      const importSignal = registerJob(importJobId);

      try {
        // Send status update to the channel
        const channel = await client.channels.fetch(channelId);
        if (channel?.isTextBased() && "send" in channel) {
          await (channel as import("discord.js").TextChannel).send({
            embeds: [
              new EmbedBuilder()
                .setTitle("Archive Import Starting")
                .setColor(0x4f8a5e)
                .setDescription(`Exported ${count} messages. Now importing to Stoat channel \`${stoatChannelId}\`...`)
                .addFields(
                  { name: "Import Job ID", value: `\`${importJobId}\``, inline: true },
                  { name: "Re-host attachments", value: rehostAttachments ? "Yes" : "No", inline: true },
                )
                .setTimestamp(),
            ],
          });
        }

        await importToStoat(stoatClient, store, importJobId, stoatChannelId, importSignal, undefined, {
          rehostAttachments,
          reconstructReplies: true,
          preserveEmbeds,
        });

        unregisterJob(importJobId);
      } catch (err) {
        unregisterJob(importJobId);
        console.error("[archive] Import failed:", err);
      }
    }
  }).catch((err) => {
    unregisterJob(jobId);
    console.error("[archive] Export failed:", err);
  });
}

/** /archive status — show archive jobs for this server */
async function handleArchiveStatus(
  interaction: ChatInputCommandInteraction,
  store: Store
): Promise<void> {
  const guildId = interaction.guildId!;
  const jobs = store.getArchiveJobsForGuild(guildId);

  if (jobs.length === 0) {
    await interaction.reply({
      content: "No archive jobs found for this server.",
      ephemeral: true,
    });
    return;
  }

  // Show most recent 10 jobs
  const recent = jobs.slice(0, 10);
  const lines = recent.map((j) => {
    const pct = j.total_messages > 0
      ? Math.round((j.processed_messages / j.total_messages) * 100)
      : 0;
    const statusEmoji = j.status === "completed" ? "\u2705"
      : j.status === "running" ? "\u23f3"
      : j.status === "paused" ? "\u23f8\ufe0f"
      : j.status === "failed" ? "\u274c"
      : "\u23f3";
    return `${statusEmoji} \`${j.id.slice(0, 8)}\` ${j.direction} **${j.discord_channel_name ?? "unknown"}** — ${j.processed_messages}/${j.total_messages} (${pct}%) [${j.status}]`;
  });

  const embed = new EmbedBuilder()
    .setTitle("Archive Jobs")
    .setColor(0x4f8a5e)
    .setDescription(lines.join("\n"))
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

/** /archive pause — pause a running archive job */
async function handleArchivePause(
  interaction: ChatInputCommandInteraction,
  store: Store
): Promise<void> {
  let jobId = interaction.options.getString("job_id") ?? undefined;

  // Default to this channel's active job
  if (!jobId) {
    const activeJob = store.getActiveExportJob(interaction.channelId);
    if (activeJob) {
      jobId = activeJob.id;
    }
  }

  if (!jobId) {
    await interaction.reply({
      content: "No running archive job found. Specify a job ID with `job_id`.",
      ephemeral: true,
    });
    return;
  }

  if (!isJobActive(jobId)) {
    await interaction.reply({
      content: `Job \`${jobId}\` is not actively running in this session.`,
      ephemeral: true,
    });
    return;
  }

  abortJob(jobId);

  await interaction.reply({
    content: `Archive job \`${jobId}\` has been paused. Use \`/archive resume\` to continue.`,
    ephemeral: true,
  });
}

/** /archive resume — resume a paused archive job */
async function handleArchiveResume(
  interaction: ChatInputCommandInteraction,
  store: Store,
  stoatClient: StoatClient,
  client: Client
): Promise<void> {
  let jobId = interaction.options.getString("job_id") ?? undefined;

  // Find a paused job for this channel
  if (!jobId) {
    const jobs = store.getArchiveJobsForGuild(interaction.guildId!);
    const paused = jobs.find((j) =>
      j.discord_channel_id === interaction.channelId && j.status === "paused"
    );
    if (paused) {
      jobId = paused.id;
    }
  }

  if (!jobId) {
    await interaction.reply({
      content: "No paused archive job found. Specify a job ID with `job_id`.",
      ephemeral: true,
    });
    return;
  }

  const job = store.getArchiveJob(jobId);
  if (!job || job.status !== "paused") {
    await interaction.reply({
      content: `Job \`${jobId}\` is not in a paused state (current: ${job?.status ?? "not found"}).`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  // Capture jobId as const for use in async callbacks
  const resumeJobId = jobId;
  const resumeSignal = registerJob(resumeJobId);

  await interaction.editReply({
    content: `Resuming archive ${job.direction} job \`${resumeJobId}\`...`,
  });

  // Resume in background
  if (job.direction === "export") {
    exportDiscordChannel(client, store, resumeJobId, job.discord_channel_id, resumeSignal).then(() => {
      unregisterJob(resumeJobId);
    }).catch((err) => {
      unregisterJob(resumeJobId);
      console.error("[archive] Export resume failed:", err);
    });
  } else if (job.direction === "import" && job.stoat_channel_id) {
    importToStoat(stoatClient, store, resumeJobId, job.stoat_channel_id, resumeSignal).then(() => {
      unregisterJob(resumeJobId);
    }).catch((err) => {
      unregisterJob(resumeJobId);
      console.error("[archive] Import resume failed:", err);
    });
  }
}
