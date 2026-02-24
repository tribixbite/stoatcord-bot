/**
 * Stoat-side command system for stoatcord-bot.
 * Listens for !stoatcord commands in Stoat channels and handles them.
 * Also detects reply-based approvals for live migration requests.
 */

import type { Client as DiscordClient, TextChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import type { StoatClient } from "./client.ts";
import type { StoatWebSocket } from "./websocket.ts";
import type { BonfireMessageEvent } from "./types.ts";
import { PermissionBit } from "./types.ts";
import type { Store } from "../db/store.ts";
import type { PushStore } from "../push/store.ts";
import { resolveApproval, rejectApproval } from "../migration/approval.ts";

const COMMAND_PREFIX = "!stoatcord";

interface ParsedCommand {
  command: string;
  args: string[];
}

/** Parse a message for bot commands (prefix or @mention) */
function parseCommand(content: string, botUserId: string): ParsedCommand | null {
  const trimmed = content.trim();

  // Check prefix: "!stoatcord <command> [args...]"
  if (trimmed.toLowerCase().startsWith(COMMAND_PREFIX)) {
    const parts = trimmed.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
    if (parts.length === 0 || parts[0] === "") return null;
    return { command: parts[0]!.toLowerCase(), args: parts.slice(1) };
  }

  // Check @mention: "<@BOT_ID> <command> [args...]"
  const mentionPrefix = `<@${botUserId}>`;
  if (trimmed.startsWith(mentionPrefix)) {
    const parts = trimmed.slice(mentionPrefix.length).trim().split(/\s+/);
    if (parts.length === 0 || parts[0] === "") return null;
    return { command: parts[0]!.toLowerCase(), args: parts.slice(1) };
  }

  return null;
}

/**
 * Check if a Stoat user is an admin of a server.
 * Admin = server owner OR has a role with ManageServer permission.
 */
async function isStoatServerAdmin(
  stoatClient: StoatClient,
  serverId: string,
  userId: string
): Promise<boolean> {
  try {
    const server = await stoatClient.getServer(serverId);

    // Server owner is always admin
    if (server.owner === userId) return true;

    // Check member roles for ManageServer permission
    const member = await stoatClient.fetchMember(serverId, userId);
    if (!member.roles || member.roles.length === 0) return false;

    for (const roleId of member.roles) {
      const role = server.roles?.[roleId];
      if (!role) continue;
      const allowed = BigInt(role.permissions.a);
      if (allowed & PermissionBit.ManageServer) return true;
    }

    return false;
  } catch (err) {
    console.error(`[stoat-cmd] Error checking admin status for ${userId} on ${serverId}:`, err);
    return false;
  }
}

/** Resolve which Stoat server a channel belongs to */
async function getServerForChannel(
  stoatClient: StoatClient,
  channelId: string
): Promise<string | null> {
  try {
    const channel = await stoatClient.getChannel(channelId);
    return channel.server ?? null;
  } catch {
    return null;
  }
}

/**
 * Register the Stoat command handler on the WebSocket.
 * This runs alongside (not replacing) the bridge relay handler.
 */
export function setupStoatCommands(
  stoatWs: StoatWebSocket,
  store: Store,
  stoatClient: StoatClient,
  botUserId: string,
  discordClient: DiscordClient,
  pushStore?: PushStore
): void {
  stoatWs.on("message", async (event: BonfireMessageEvent) => {
    // Skip messages from the bot itself
    if (event.author === botUserId) return;
    // Skip masqueraded messages (bridged from Discord)
    if (event.masquerade) return;
    // Need content to parse
    if (!event.content) return;

    // --- Check for reply-based migration approvals ---
    if (event.replies && event.replies.length > 0) {
      await handlePossibleApproval(event, stoatClient, store);
    }

    // --- Parse bot commands ---
    const parsed = parseCommand(event.content, botUserId);
    if (!parsed) return;

    const serverId = await getServerForChannel(stoatClient, event.channel);
    if (!serverId) return;

    switch (parsed.command) {
      case "code":
        await handleCodeCommand(event, serverId, stoatClient, store);
        break;
      case "request":
        await handleRequestCommand(event, serverId, parsed.args, stoatClient, store, discordClient);
        break;
      case "status":
        await handleStatusCommand(event, serverId, stoatClient, store);
        break;
      case "ping":
        await handlePingCommand(event, parsed.args, stoatClient);
        break;
      case "diag":
        await handleDiagCommand(event, serverId, stoatClient);
        break;
      case "archive":
        await handleArchiveCommand(event, serverId, stoatClient, store);
        break;
      case "push":
        await handlePushCommand(event, parsed.args, stoatClient, store, pushStore);
        break;
      case "help":
        await handleHelpCommand(event, stoatClient);
        break;
      default:
        await stoatClient.sendMessage(
          event.channel,
          `Unknown command \`${parsed.command}\`. Type \`!stoatcord help\` for available commands.`,
          { replies: [{ id: event._id, mention: false }] }
        );
    }
  });

  console.log("[stoat-cmd] Command handler registered");
}

// --- Command handlers ---

/** !stoatcord code — generate a one-time claim code for this server */
async function handleCodeCommand(
  event: BonfireMessageEvent,
  serverId: string,
  stoatClient: StoatClient,
  store: Store
): Promise<void> {
  // Verify admin
  const isAdmin = await isStoatServerAdmin(stoatClient, serverId, event.author);
  if (!isAdmin) {
    await stoatClient.sendMessage(
      event.channel,
      "Only server admins can generate migration codes.",
      { replies: [{ id: event._id, mention: false }] }
    );
    return;
  }

  const code = store.createClaimCode(serverId, event.author, event.channel);

  await stoatClient.sendMessage(
    event.channel,
    `**Migration Code Generated**\n\n` +
    `Code: \`${code}\`\n\n` +
    `Give this to a Discord server administrator. They should run:\n` +
    `\`/migrate claim_code:${code}\`\n\n` +
    `This code expires in **1 hour** and can only be used **once**.`,
    { replies: [{ id: event._id, mention: false }] }
  );

  console.log(`[stoat-cmd] Code ${code} generated for server ${serverId} by user ${event.author}`);
}

/** !stoatcord request <discord_guild_id> — send migration info to Discord guild */
async function handleRequestCommand(
  event: BonfireMessageEvent,
  serverId: string,
  args: string[],
  stoatClient: StoatClient,
  store: Store,
  discordClient: DiscordClient
): Promise<void> {
  // Verify admin
  const isAdmin = await isStoatServerAdmin(stoatClient, serverId, event.author);
  if (!isAdmin) {
    await stoatClient.sendMessage(
      event.channel,
      "Only server admins can send migration requests.",
      { replies: [{ id: event._id, mention: false }] }
    );
    return;
  }

  if (args.length === 0) {
    await stoatClient.sendMessage(
      event.channel,
      "Usage: `!stoatcord request <discord_guild_id>`\n\nProvide the Discord server's ID.",
      { replies: [{ id: event._id, mention: false }] }
    );
    return;
  }

  const discordGuildId = args[0]!;
  const guild = discordClient.guilds.cache.get(discordGuildId);
  if (!guild) {
    await stoatClient.sendMessage(
      event.channel,
      `Bot is not a member of Discord guild \`${discordGuildId}\`. Make sure the bot is added to that Discord server first.`,
      { replies: [{ id: event._id, mention: false }] }
    );
    return;
  }

  // Generate a code for convenience
  const code = store.createClaimCode(serverId, event.author, event.channel);

  // Find a channel to post in on Discord
  const targetChannel = guild.systemChannel
    ?? guild.channels.cache.find(
      (ch): ch is TextChannel => ch.isTextBased() && "send" in ch
    ) as TextChannel | undefined;

  if (!targetChannel) {
    await stoatClient.sendMessage(
      event.channel,
      `Could not find a text channel to post in on Discord guild \`${guild.name}\`.`,
      { replies: [{ id: event._id, mention: false }] }
    );
    return;
  }

  // Fetch Stoat server name for the embed
  let serverName = serverId;
  try {
    const server = await stoatClient.getServer(serverId);
    serverName = server.name;
  } catch {
    // Use ID as fallback
  }

  const embed = new EmbedBuilder()
    .setTitle("Migration Request from Stoat")
    .setColor(0x4f8a5e)
    .setDescription(
      `Stoat server **${serverName}** is requesting to link with this Discord guild.\n\n` +
      `A Discord administrator should run:\n` +
      `\`/migrate claim_code:${code}\``
    )
    .addFields(
      { name: "Claim Code", value: `\`${code}\``, inline: true },
      { name: "Expires", value: "1 hour", inline: true }
    )
    .setTimestamp();

  try {
    await targetChannel.send({ embeds: [embed] });
    await stoatClient.sendMessage(
      event.channel,
      `Migration request sent to Discord guild **${guild.name}** in #${targetChannel.name}.\n` +
      `Code \`${code}\` was included in the message.`,
      { replies: [{ id: event._id, mention: false }] }
    );
  } catch (err) {
    await stoatClient.sendMessage(
      event.channel,
      `Failed to send message to Discord: ${err}`,
      { replies: [{ id: event._id, mention: false }] }
    );
  }
}

/** !stoatcord status — show bridge link status for this server */
async function handleStatusCommand(
  event: BonfireMessageEvent,
  serverId: string,
  stoatClient: StoatClient,
  store: Store
): Promise<void> {
  const link = store.getGuildForStoatServer(serverId);
  const channels = store.getAllActiveChannelLinks();

  // Count channels that belong to this Stoat server (check by fetching each)
  // For efficiency, just report total links and server-level link
  let statusMsg = "**Stoatcord Bridge Status**\n\n";

  if (link) {
    statusMsg += `Linked to Discord guild \`${link.discord_guild_id}\`\n`;
    statusMsg += `Auth method: ${link.auth_method ?? "unknown"}\n`;
    statusMsg += `Linked by Discord user: ${link.linked_by_discord_user ?? "unknown"}\n`;
    statusMsg += `Active channel bridges: ${channels.length}\n`;
  } else {
    statusMsg += "This Stoat server is not linked to any Discord guild.\n";
    statusMsg += `Use \`!stoatcord code\` to generate a migration code.`;
  }

  await stoatClient.sendMessage(event.channel, statusMsg, {
    replies: [{ id: event._id, mention: false }],
  });
}

/**
 * !stoatcord ping <user_id> — send a message that mentions the target user.
 * Used to test if the Stoat server generates push notifications for mentions.
 */
async function handlePingCommand(
  event: BonfireMessageEvent,
  args: string[],
  stoatClient: StoatClient
): Promise<void> {
  if (args.length === 0) {
    await stoatClient.sendMessage(
      event.channel,
      `Usage: \`!stoatcord ping <user_id>\`\n\nSends a message mentioning the target user to test push notifications.\n` +
      `You can find user IDs from the member list or profile.`,
      { replies: [{ id: event._id, mention: false }] }
    );
    return;
  }

  const targetUserId = args[0]!;

  // Validate the user ID looks reasonable (26 chars, alphanumeric)
  if (!/^[A-Za-z0-9]{26}$/.test(targetUserId)) {
    await stoatClient.sendMessage(
      event.channel,
      `Invalid user ID format: \`${targetUserId}\`. Stoat user IDs are 26 alphanumeric characters.`,
      { replies: [{ id: event._id, mention: false }] }
    );
    return;
  }

  // Verify user exists
  let displayName = targetUserId;
  try {
    const user = await stoatClient.fetchUser(targetUserId);
    displayName = user.display_name ?? user.username ?? targetUserId;
  } catch {
    await stoatClient.sendMessage(
      event.channel,
      `Could not find user \`${targetUserId}\`. Verify the ID is correct.`,
      { replies: [{ id: event._id, mention: false }] }
    );
    return;
  }

  // Send a message with a mention — this should trigger the server's push notification system
  const timestamp = new Date().toISOString();
  await stoatClient.sendMessage(
    event.channel,
    `**Notification Test** — <@${targetUserId}> this is a test ping sent at ${timestamp}. ` +
    `If push notifications are working, ${displayName} should receive a notification on their device.`
  );

  console.log(`[stoat-cmd] Ping test sent to user ${targetUserId} (${displayName}) in channel ${event.channel}`);
}

/**
 * !stoatcord diag — run notification diagnostics for this server.
 * Shows bot self-ID, server info, channel count, and push subscription status.
 */
async function handleDiagCommand(
  event: BonfireMessageEvent,
  serverId: string,
  stoatClient: StoatClient
): Promise<void> {
  let report = "**Notification Diagnostics**\n\n";

  try {
    // Bot self info
    const self = await stoatClient.getSelf();
    report += `Bot user: \`${self.username}\` (\`${self._id}\`)\n`;
    report += `Bot type: ${self.bot ? "Bot account" : "User account (not a bot!)"}\n\n`;

    // Server info
    const server = await stoatClient.getServer(serverId);
    report += `Server: **${server.name}** (\`${serverId}\`)\n`;
    report += `Owner: \`${server.owner}\`\n`;
    report += `Channels: ${server.channels?.length ?? 0}\n\n`;

    // Try to fetch server members to check who has push
    report += `**How push notifications work:**\n`;
    report += `1. User's app calls \`POST /push/subscribe\` with FCM token\n`;
    report += `2. Server stores the subscription\n`;
    report += `3. When a message mentions a user, server sends FCM push\n`;
    report += `4. Android HandlerService receives and displays notification\n\n`;

    report += `**Possible failure points:**\n`;
    report += `- App not registered for push (\`POST /push/subscribe\` failed)\n`;
    report += `- Server doesn't have Firebase credentials configured\n`;
    report += `- google-services.json project mismatch (app vs server)\n`;
    report += `- Android notification permission not granted\n`;
    report += `- Channel or server is muted in app settings\n\n`;

    report += `**Test:** Use \`!stoatcord ping <user_id>\` to send a mention and check if notification arrives.`;
  } catch (err) {
    report += `Error running diagnostics: ${err}`;
  }

  await stoatClient.sendMessage(event.channel, report, {
    replies: [{ id: event._id, mention: false }],
  });
}

/** !stoatcord archive [status] — show archive job status for the linked guild */
async function handleArchiveCommand(
  event: BonfireMessageEvent,
  serverId: string,
  stoatClient: StoatClient,
  store: Store
): Promise<void> {
  // Find the linked guild for this Stoat server
  const link = store.getGuildForStoatServer(serverId);
  if (!link) {
    await stoatClient.sendMessage(
      event.channel,
      "This Stoat server is not linked to a Discord guild. Link one first with `!stoatcord code`.",
      { replies: [{ id: event._id, mention: false }] }
    );
    return;
  }

  const jobs = store.getArchiveJobsForGuild(link.discord_guild_id);
  if (jobs.length === 0) {
    await stoatClient.sendMessage(
      event.channel,
      "No archive jobs found. Start one from Discord with `/archive start`.",
      { replies: [{ id: event._id, mention: false }] }
    );
    return;
  }

  const recent = jobs.slice(0, 10);
  const lines = recent.map((j) => {
    const pct = j.total_messages > 0
      ? Math.round((j.processed_messages / j.total_messages) * 100)
      : 0;
    return `\`${j.id.slice(0, 8)}\` ${j.direction} **${j.discord_channel_name ?? "?"}** — ${j.processed_messages}/${j.total_messages} (${pct}%) [${j.status}]`;
  });

  await stoatClient.sendMessage(
    event.channel,
    `**Archive Jobs** (${jobs.length} total)\n\n${lines.join("\n")}`,
    { replies: [{ id: event._id, mention: false }] }
  );
}

/** !stoatcord help — show available commands */
async function handleHelpCommand(
  event: BonfireMessageEvent,
  stoatClient: StoatClient
): Promise<void> {
  await stoatClient.sendMessage(
    event.channel,
    `**Stoatcord Bot Commands**\n\n` +
    `**Migration:**\n` +
    `\`!stoatcord code\` — Generate a one-time migration code (admin only)\n` +
    `\`!stoatcord request <discord_guild_id>\` — Send migration request to a Discord guild (admin only)\n` +
    `\`!stoatcord status\` — Show bridge link status\n\n` +
    `**Archive:**\n` +
    `\`!stoatcord archive\` — Show archive job status for the linked Discord guild\n\n` +
    `**Push Notifications:**\n` +
    `\`!stoatcord push setup\` — Generate a push token (sent via DM)\n` +
    `\`!stoatcord push revoke\` — Revoke token and unregister all devices\n` +
    `\`!stoatcord push status\` — Check your push registration status\n\n` +
    `**Diagnostics:**\n` +
    `\`!stoatcord ping <user_id>\` — Send a mention to test push notifications\n` +
    `\`!stoatcord diag\` — Run notification diagnostics\n` +
    `\`!stoatcord help\` — Show this message`,
    { replies: [{ id: event._id, mention: false }] }
  );
}

/**
 * !stoatcord push <subcommand> — manage push notification tokens via DM.
 * Subcommands: setup, revoke, status
 */
async function handlePushCommand(
  event: BonfireMessageEvent,
  args: string[],
  stoatClient: StoatClient,
  store: Store,
  pushStore?: PushStore
): Promise<void> {
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === "help") {
    await stoatClient.sendMessage(
      event.channel,
      `**Push Notification Commands**\n\n` +
      `\`!stoatcord push setup\` — Generate a push token (sent via DM)\n` +
      `\`!stoatcord push revoke\` — Revoke your push token and unregister all devices\n` +
      `\`!stoatcord push status\` — Check your push registration status\n\n` +
      `**How it works:**\n` +
      `1. Run \`!stoatcord push setup\` — the bot DMs you a push token\n` +
      `2. In your app, go to Settings > Notifications > API Key\n` +
      `3. Paste the token and tap Save\n` +
      `4. Your device will register for push notifications automatically`,
      { replies: [{ id: event._id, mention: false }] }
    );
    return;
  }

  switch (subcommand) {
    case "setup": {
      try {
        // Generate token inside try block to catch DB errors
        const token = store.createPushToken(event.author);

        // Open DM channel and send the token privately
        const dmChannel = await stoatClient.openDM(event.author);
        await stoatClient.sendMessage(
          dmChannel._id,
          `**Your Push Notification Token**\n\n` +
          `\`${token}\`\n\n` +
          `Paste this into your app's **Settings > Notifications > API Key** field and tap Save.\n\n` +
          `This token is tied to your account. Keep it private — anyone with it can register devices for your push notifications.\n` +
          `Use \`!stoatcord push revoke\` to invalidate it at any time.`
        );

        // Confirm in the original channel (without leaking the token)
        await stoatClient.sendMessage(
          event.channel,
          `Push token generated and sent to your DMs. Check your direct messages.`,
          { replies: [{ id: event._id, mention: false }] }
        );

        console.log(`[stoat-cmd] Push token generated for user ${event.author}`);
      } catch (err) {
        console.error(`[stoat-cmd] Failed to setup push for user ${event.author}:`, err);
        // Revoke the token if it was created but DM delivery failed
        store.revokePushTokens(event.author);
        await stoatClient.sendMessage(
          event.channel,
          `Failed to generate or deliver push token. Make sure the bot can message you (you may need to share a server or have DMs enabled).`,
          { replies: [{ id: event._id, mention: false }] }
        );
      }
      break;
    }

    case "revoke": {
      const deleted = store.revokePushTokens(event.author);

      // Also unregister all push devices for this user
      if (pushStore) {
        const removed = pushStore.removeAllDevicesForUser(event.author);
        await stoatClient.sendMessage(
          event.channel,
          deleted > 0
            ? `Push token revoked and ${removed} device(s) unregistered. You will no longer receive push notifications until you run \`!stoatcord push setup\` again.`
            : `You don't have an active push token.`,
          { replies: [{ id: event._id, mention: false }] }
        );
      } else {
        await stoatClient.sendMessage(
          event.channel,
          deleted > 0
            ? `Push token revoked. You will no longer receive push notifications until you run \`!stoatcord push setup\` again.`
            : `You don't have an active push token.`,
          { replies: [{ id: event._id, mention: false }] }
        );
      }

      console.log(`[stoat-cmd] Push token revoked for user ${event.author} (deleted=${deleted})`);
      break;
    }

    case "status": {
      const hasToken = store.hasPushToken(event.author);
      const devices = pushStore?.getDevicesByUserId(event.author) ?? [];

      let statusMsg = `**Push Status**\n\n`;
      statusMsg += `Token: ${hasToken ? "Active" : "None"}\n`;
      statusMsg += `Registered devices: ${devices.length}\n`;

      if (devices.length > 0) {
        statusMsg += `\n**Devices:**\n`;
        for (const d of devices) {
          const mode = d.push_mode === "fcm" ? "FCM" : "WebPush";
          const ago = Math.round((Date.now() / 1000 - d.updated_at) / 60);
          statusMsg += `- \`${d.device_id.slice(0, 8)}...\` (${mode}) — updated ${ago}m ago\n`;
        }
      }

      await stoatClient.sendMessage(event.channel, statusMsg, {
        replies: [{ id: event._id, mention: false }],
      });
      break;
    }

    default:
      await stoatClient.sendMessage(
        event.channel,
        `Unknown push subcommand \`${subcommand}\`. Use \`!stoatcord push help\` for options.`,
        { replies: [{ id: event._id, mention: false }] }
      );
  }
}

// --- Reply-based approval detection ---

/**
 * Check if an incoming Stoat message is a reply to a pending migration approval request.
 * If so, validate the author is a server admin and resolve/reject the approval.
 */
async function handlePossibleApproval(
  event: BonfireMessageEvent,
  stoatClient: StoatClient,
  store: Store
): Promise<void> {
  if (!event.replies || !event.content) return;

  const content = event.content.trim().toLowerCase();
  const isApprove = content === "approve" || content === "yes" || content === "confirm";
  const isDeny = content === "deny" || content === "reject" || content === "no";

  if (!isApprove && !isDeny) return;

  // Check each replied-to message against pending migration requests
  for (const repliedToId of event.replies) {
    const request = store.getMigrationRequestByMessageId(repliedToId);
    if (!request) continue;

    // Found a pending request this message replies to
    const serverId = request.stoat_server_id;

    if (isDeny) {
      store.resolveMigrationRequest(request.id, "rejected");
      rejectApproval(repliedToId, `Denied by Stoat user ${event.author}`);
      await stoatClient.sendMessage(
        event.channel,
        "Migration request **denied**.",
        { replies: [{ id: event._id, mention: false }] }
      );
      return;
    }

    // isApprove — verify the approver is a server admin
    const isAdmin = await isStoatServerAdmin(stoatClient, serverId, event.author);
    if (!isAdmin) {
      await stoatClient.sendMessage(
        event.channel,
        "Only server admins can approve migration requests.",
        { replies: [{ id: event._id, mention: false }] }
      );
      return;
    }

    // Approve
    store.resolveMigrationRequest(request.id, "approved", event.author);
    const resolved = resolveApproval(repliedToId, event.author);

    if (resolved) {
      await stoatClient.sendMessage(
        event.channel,
        `Migration **approved** for Discord guild \`${request.discord_guild_name}\`.`,
        { replies: [{ id: event._id, mention: false }] }
      );
    } else {
      // Promise was already resolved/rejected (timeout race)
      await stoatClient.sendMessage(
        event.channel,
        "This migration request has already expired or been processed.",
        { replies: [{ id: event._id, mention: false }] }
      );
    }
    return;
  }
}
