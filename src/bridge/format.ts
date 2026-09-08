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
export const REVOLT_MAX_MESSAGE_BYTES = 2000;

const encoder = new TextEncoder();

/** UTF-8 byte length — what Revolt actually measures a message against. */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Longest prefix of `text` fitting in `maxBytes`, never cutting mid-character. */
function sliceByBytes(text: string, maxBytes: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const n = byteLength(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/**
 * Truncate to Revolt's message limit, which is 2000 UTF-8 BYTES rather than
 * 2000 characters — verified against the live API, where 667 characters
 * totalling 2001 bytes is rejected with 422 PayloadTooLarge.
 */
export function truncateForRevolt(
  content: string,
  maxBytes: number = REVOLT_MAX_MESSAGE_BYTES
): string {
  if (byteLength(content) <= maxBytes) return content;
  return sliceByBytes(content, maxBytes - 3) + "...";
}

/**
 * Split content into chunks that each fit Revolt's byte limit, breaking at a
 * paragraph, line or word boundary where one is available. Used by the archive
 * importer so long messages are preserved in full instead of truncated.
 */
export function splitForRevolt(
  content: string,
  maxBytes: number = REVOLT_MAX_MESSAGE_BYTES
): string[] {
  if (!content) return [];
  if (byteLength(content) <= maxBytes) return [content];

  const chunks: string[] = [];
  let rest = content;
  while (byteLength(rest) > maxBytes) {
    let head = sliceByBytes(rest, maxBytes);
    const boundary = Math.max(
      head.lastIndexOf("\n\n"),
      head.lastIndexOf("\n"),
      head.lastIndexOf(" ")
    );
    // Only honour a boundary that isn't throwing away most of the chunk.
    if (boundary > head.length / 2) head = head.slice(0, boundary);
    chunks.push(head.trimEnd());
    rest = rest.slice(head.length).replace(/^\s+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Truncate content to Discord's max message length (2000 chars).
 */
export function truncateForDiscord(content: string): string {
  if (content.length <= 2000) return content;
  return content.slice(0, 1997) + "...";
}
