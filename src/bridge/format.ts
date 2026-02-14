/** Markdown/format conversion between Discord and Stoat/Revolt */

/**
 * Convert Discord markdown to Revolt markdown.
 * Most syntax is identical — main differences:
 * - Spoilers: Discord `||text||` → Revolt `!!text!!`
 * - Mentions are platform-specific (different ID spaces)
 */
export function discordToRevolt(content: string): string {
  let result = content;

  // Convert spoilers: ||text|| → !!text!!
  result = result.replace(/\|\|(.+?)\|\|/gs, "!!$1!!");

  // Strip Discord mentions — show as plain text since IDs don't map
  // User mentions: <@123456> or <@!123456> → @unknown
  result = result.replace(/<@!?(\d+)>/g, "@discord-user");

  // Channel mentions: <#123456> → #channel
  result = result.replace(/<#(\d+)>/g, "#discord-channel");

  // Role mentions: <@&123456> → @role
  result = result.replace(/<@&(\d+)>/g, "@discord-role");

  // Custom emoji: <:name:id> → :name:
  result = result.replace(/<a?:(\w+):\d+>/g, ":$1:");

  // Timestamps: <t:1234567890:f> → show as UTC string
  result = result.replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (_match, ts) => {
    const date = new Date(parseInt(ts, 10) * 1000);
    return date.toISOString().replace("T", " ").replace(/\.\d+Z/, " UTC");
  });

  return result;
}

/**
 * Convert Revolt markdown to Discord markdown.
 * - Spoilers: !!text!! → ||text||
 * - Revolt mentions are 26-char ULIDs, show as plain text
 */
export function revoltToDiscord(content: string): string {
  let result = content;

  // Convert spoilers: !!text!! → ||text||
  result = result.replace(/!!(.+?)!!/gs, "||$1||");

  // Strip Revolt user mentions: <@ULID> → @stoat-user
  result = result.replace(/<@([A-Z0-9]{26})>/g, "@stoat-user");

  // Strip Revolt channel mentions: <#ULID>
  result = result.replace(/<#([A-Z0-9]{26})>/g, "#stoat-channel");

  return result;
}

/**
 * Build a display name for bridged messages.
 * Shows platform origin for clarity.
 */
export function formatBridgedName(
  username: string,
  platform: "discord" | "stoat"
): string {
  // Keep it clean — just the username. The avatar/webhook makes it obvious.
  return username;
}

/**
 * Truncate content to Revolt's max message length (2000 chars).
 */
export function truncateForRevolt(content: string): string {
  if (content.length <= 2000) return content;
  return content.slice(0, 1997) + "...";
}

/**
 * Truncate content to Discord's max message length (2000 chars).
 */
export function truncateForDiscord(content: string): string {
  if (content.length <= 2000) return content;
  return content.slice(0, 1997) + "...";
}
