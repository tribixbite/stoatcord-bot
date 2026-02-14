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
  discordClient: DiscordClient
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

/** !stoatcord help — show available commands */
async function handleHelpCommand(
  event: BonfireMessageEvent,
  stoatClient: StoatClient
): Promise<void> {
  await stoatClient.sendMessage(
    event.channel,
    `**Stoatcord Bot Commands**\n\n` +
    `\`!stoatcord code\` — Generate a one-time migration code (admin only)\n` +
    `\`!stoatcord request <discord_guild_id>\` — Send migration request to a Discord guild (admin only)\n` +
    `\`!stoatcord status\` — Show bridge link status\n` +
    `\`!stoatcord help\` — Show this message`,
    { replies: [{ id: event._id, mention: false }] }
  );
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
