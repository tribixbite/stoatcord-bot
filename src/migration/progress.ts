/**
 * Rate-limit-aware batch migration executor with progress tracking.
 * Supports incremental dedup (update existing, create new), dry-run mode,
 * mid-flight cancellation via AbortSignal, and emoji/media migration.
 */

import { sleep } from "../util.ts";
import type { StoatClient } from "../stoat/client.ts";
import type { Store } from "../db/store.ts";
import type { ChannelMapping } from "./channels.ts";
import type { RoleMapping } from "./roles.ts";
import type { Category, Channel, Role, Server } from "../stoat/types.ts";

export interface MigrationProgress {
  totalSteps: number;
  completedSteps: number;
  currentAction: string;
  errors: Array<{ action: string; error: string }>;
  /** Warnings collected during migration (truncations, unsupported features) */
  warnings: string[];
  /** When dry-run mode, itemized log of planned actions */
  dryRunLog: string[];
  /** Counts for the results summary */
  created: number;
  updated: number;
  skipped: number;
}

export type ProgressCallback = (progress: MigrationProgress) => Promise<void>;

/** Thrown when migration is cancelled via AbortSignal */
export class MigrationCancelledError extends Error {
  constructor() {
    super("Migration cancelled by user");
    this.name = "MigrationCancelledError";
  }
}

// Rate limit delays (ms) — conservative to avoid 429s
const ROLE_DELAY = 2500; // server bucket: 5 req/10s
const CHANNEL_DELAY = 2500; // server bucket: 5 req/10s
const EMOJI_DELAY = 2000; // be cautious with emoji creation

/** Lookup map entry for existing Stoat items */
interface ExistingChannel {
  id: string;
  channel: Channel;
}
interface ExistingRole {
  id: string;
  role: Role;
}

export interface MigrationOptions {
  /** Skip all API calls, just build the plan */
  dryRun?: boolean;
  /** AbortSignal for mid-flight cancellation */
  signal?: AbortSignal;
  /** Migrate emoji from Discord to Stoat */
  includeEmoji?: boolean;
  /** Upload server icon/banner to Stoat */
  includeMedia?: boolean;
  /** Discord guild object for emoji/media access */
  guild?: import("discord.js").Guild;
}

/**
 * Check if the signal has been aborted and throw if so.
 * Called between each API operation for responsive cancellation.
 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MigrationCancelledError();
}

/**
 * Execute a full server migration: roles → channels → categories → server props → emoji → media.
 * Handles three cases per item: create new, update existing (by name match), or skip.
 * Reports progress via callback for Discord embed updates.
 */
export async function executeMigration(
  stoatClient: StoatClient,
  store: Store,
  guildId: string,
  stoatServerId: string,
  channels: ChannelMapping[],
  roles: RoleMapping[],
  discordUserId?: string,
  stoatUserId?: string,
  onProgress?: ProgressCallback,
  options: MigrationOptions = {}
): Promise<MigrationProgress> {
  const { dryRun = false, signal, includeEmoji = false, includeMedia = false, guild } = options;

  const selectedChannels = channels.filter((c) => c.selected);
  const selectedRoles = roles.filter((r) => r.selected);

  // +1 for categories, +1 for server properties
  let totalSteps = selectedRoles.length + selectedChannels.length + 2;
  if (includeEmoji && guild) totalSteps += guild.emojis.cache.size;
  if (includeMedia && guild) totalSteps += 2; // icon + banner

  const progress: MigrationProgress = {
    totalSteps,
    completedSteps: 0,
    currentAction: dryRun ? "Generating dry-run plan..." : "Starting migration...",
    errors: [],
    warnings: [],
    dryRunLog: [],
    created: 0,
    updated: 0,
    skipped: 0,
  };

  if (onProgress) await onProgress(progress);

  // --- Build lookup maps of existing Stoat items ---
  const existingChannelMap = new Map<string, ExistingChannel>(); // lowercase name → { id, channel }
  const existingRoleMap = new Map<string, ExistingRole>(); // lowercase name → { id, role }

  let server: Server | null = null;
  try {
    server = await stoatClient.getServer(stoatServerId);

    // Build channel lookup
    for (const chId of server.channels) {
      try {
        const ch = await stoatClient.getChannel(chId);
        if (ch.name) {
          existingChannelMap.set(ch.name.toLowerCase(), { id: ch._id, channel: ch });
        }
      } catch {
        // Channel may have been deleted
      }
    }

    // Build role lookup
    if (server.roles) {
      for (const [roleId, role] of Object.entries(server.roles)) {
        existingRoleMap.set(role.name.toLowerCase(), { id: roleId, role });
      }
    }
  } catch {
    // New server — no existing items to look up
  }

  // Collect all warnings from channel/role mappings
  for (const ch of selectedChannels) {
    progress.warnings.push(...ch.warnings);
  }
  for (const role of selectedRoles) {
    progress.warnings.push(...role.warnings);
  }

  // --- Phase 1: Roles (create new or update existing) ---
  const roleIdMap = new Map<string, string>(); // discordRoleId → stoatRoleId

  for (const role of selectedRoles) {
    checkAbort(signal);

    const existing = existingRoleMap.get(role.stoatName.toLowerCase());

    if (existing) {
      // Update existing role properties
      progress.currentAction = dryRun
        ? `[DRY RUN] Would update role: ${role.stoatName}`
        : `Updating role: ${role.stoatName}`;
      if (onProgress) await onProgress(progress);

      if (dryRun) {
        const changes: string[] = [];
        if (role.stoatColor && role.stoatColor !== existing.role.colour) changes.push(`colour → ${role.stoatColor}`);
        if (role.hoist !== (existing.role.hoist ?? false)) changes.push(`hoist → ${role.hoist}`);
        progress.dryRunLog.push(`UPDATE role "${role.stoatName}": ${changes.length > 0 ? changes.join(", ") : "permissions only"}`);
        progress.updated++;
      } else {
        try {
          // Build edit payload — only include changed properties
          const editData: Record<string, unknown> = {};
          if (role.stoatColor && role.stoatColor !== existing.role.colour) {
            editData.colour = role.stoatColor;
          }
          if (role.hoist !== (existing.role.hoist ?? false)) {
            editData.hoist = role.hoist;
          }

          if (Object.keys(editData).length > 0) {
            await stoatClient.editRole(stoatServerId, existing.id, editData);
          }
          await stoatClient.setRolePermissions(stoatServerId, existing.id, role.permissions);

          roleIdMap.set(role.discordId, existing.id);
          store.linkRole(role.discordId, existing.id, guildId);
          store.logMigration(guildId, "role_updated", role.discordId, existing.id, "success", undefined, discordUserId, stoatUserId);
          progress.updated++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          progress.errors.push({ action: `Update role: ${role.stoatName}`, error: msg });
          store.logMigration(guildId, "role_updated", role.discordId, existing.id, "error", msg, discordUserId, stoatUserId);
        }
      }
    } else {
      // Create new role
      progress.currentAction = dryRun
        ? `[DRY RUN] Would create role: ${role.stoatName}`
        : `Creating role: ${role.stoatName}`;
      if (onProgress) await onProgress(progress);

      if (dryRun) {
        progress.dryRunLog.push(`CREATE role "${role.stoatName}"${role.stoatColor ? ` (${role.stoatColor})` : ""}${role.hoist ? " [hoisted]" : ""}`);
        progress.created++;
      } else {
        try {
          const result = await stoatClient.createRole(stoatServerId, role.stoatName);
          roleIdMap.set(role.discordId, result.id);

          // Set all properties on the new role
          const editData: Record<string, unknown> = {};
          if (role.stoatColor) editData.colour = role.stoatColor;
          if (role.hoist) editData.hoist = true;
          if (Object.keys(editData).length > 0) {
            await stoatClient.editRole(stoatServerId, result.id, editData);
          }
          await stoatClient.setRolePermissions(stoatServerId, result.id, role.permissions);

          store.linkRole(role.discordId, result.id, guildId);
          store.logMigration(guildId, "role_created", role.discordId, result.id, "success", undefined, discordUserId, stoatUserId);
          progress.created++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          progress.errors.push({ action: `Role: ${role.stoatName}`, error: msg });
          store.logMigration(guildId, "role_created", role.discordId, null, "error", msg, discordUserId, stoatUserId);
        }
      }
    }

    progress.completedSteps++;
    if (!dryRun) await sleep(ROLE_DELAY);
  }

  // --- Phase 2: Channels (create new or update existing) ---
  const channelIdMap = new Map<string, string>(); // discordChannelId → stoatChannelId

  for (const ch of selectedChannels) {
    checkAbort(signal);

    const existing = existingChannelMap.get(ch.stoatName.toLowerCase());

    if (existing) {
      // Update existing channel properties (description, nsfw)
      progress.currentAction = dryRun
        ? `[DRY RUN] Would update channel: ${ch.stoatName}`
        : `Updating channel: ${ch.stoatName}`;
      if (onProgress) await onProgress(progress);

      if (dryRun) {
        const changes: string[] = [];
        if (ch.topic && ch.topic !== existing.channel.description) changes.push("description");
        if (ch.nsfw !== (existing.channel.nsfw ?? false)) changes.push(`nsfw → ${ch.nsfw}`);
        progress.dryRunLog.push(`UPDATE channel "${ch.stoatName}": ${changes.length > 0 ? changes.join(", ") : "no property changes"}`);
        progress.updated++;
      } else {
        try {
          const editData: Record<string, unknown> = {};
          if (ch.topic && ch.topic !== existing.channel.description) {
            editData.description = ch.topic;
          }
          if (ch.nsfw !== (existing.channel.nsfw ?? false)) {
            editData.nsfw = ch.nsfw;
          }

          if (Object.keys(editData).length > 0) {
            await stoatClient.editChannel(existing.id, editData);
          }

          channelIdMap.set(ch.discordId, existing.id);
          store.logMigration(guildId, "channel_updated", ch.discordId, existing.id, "success", undefined, discordUserId, stoatUserId);
          progress.updated++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          progress.errors.push({ action: `Update channel: ${ch.stoatName}`, error: msg });
          store.logMigration(guildId, "channel_updated", ch.discordId, existing.id, "error", msg, discordUserId, stoatUserId);
        }
      }
    } else {
      // Create new channel with all properties
      progress.currentAction = dryRun
        ? `[DRY RUN] Would create channel: ${ch.stoatName}`
        : `Creating channel: ${ch.stoatName}`;
      if (onProgress) await onProgress(progress);

      if (dryRun) {
        const props: string[] = [ch.stoatType];
        if (ch.topic) props.push("with description");
        if (ch.nsfw) props.push("NSFW");
        progress.dryRunLog.push(`CREATE channel "${ch.stoatName}" (${props.join(", ")})`);
        progress.created++;
      } else {
        try {
          const createData: { type: "Text" | "Voice"; name: string; description?: string; nsfw?: boolean } = {
            type: ch.stoatType,
            name: ch.stoatName,
          };
          if (ch.topic) createData.description = ch.topic;
          if (ch.nsfw) createData.nsfw = true;

          const result = await stoatClient.createChannel(stoatServerId, createData);
          channelIdMap.set(ch.discordId, result._id);

          store.logMigration(guildId, "channel_created", ch.discordId, result._id, "success", undefined, discordUserId, stoatUserId);
          progress.created++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          progress.errors.push({ action: `Channel: ${ch.stoatName}`, error: msg });
          store.logMigration(guildId, "channel_created", ch.discordId, null, "error", msg, discordUserId, stoatUserId);
        }
      }
    }

    progress.completedSteps++;
    if (!dryRun) await sleep(CHANNEL_DELAY);
  }

  // --- Phase 3: Set categories ---
  checkAbort(signal);
  progress.currentAction = dryRun ? "[DRY RUN] Would organize categories..." : "Organizing categories...";
  if (onProgress) await onProgress(progress);

  try {
    // Group ALL channels (created + existing matches) by category
    const categoryMap = new Map<string, string[]>(); // categoryName → stoatChannelIds
    for (const ch of selectedChannels) {
      const stoatId = channelIdMap.get(ch.discordId);
      if (!stoatId) continue;
      const catName = ch.category ?? "Uncategorized";
      if (!categoryMap.has(catName)) categoryMap.set(catName, []);
      categoryMap.get(catName)!.push(stoatId);
    }

    // Also include channels that were matched but not in selectedChannels
    // (for "full" mode — categories include all mapped channels)
    for (const ch of channels.filter((c) => !c.selected)) {
      const existing = existingChannelMap.get(ch.stoatName.toLowerCase());
      if (!existing) continue;
      const catName = ch.category ?? "Uncategorized";
      if (!categoryMap.has(catName)) categoryMap.set(catName, []);
      const list = categoryMap.get(catName)!;
      if (!list.includes(existing.id)) list.push(existing.id);
    }

    const categories: Category[] = [];
    for (const [title, channelIds] of categoryMap) {
      categories.push({
        id: generateCategoryId(),
        title,
        channels: channelIds,
      });
    }

    if (categories.length > 0) {
      if (dryRun) {
        for (const cat of categories) {
          progress.dryRunLog.push(`SET category "${cat.title}" with ${cat.channels.length} channel(s)`);
        }
      } else {
        await stoatClient.editServer(stoatServerId, { categories });
        store.logMigration(guildId, "categories_set", null, stoatServerId, "success", undefined, discordUserId, stoatUserId);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    progress.errors.push({ action: "Set categories", error: msg });
    store.logMigration(guildId, "categories_set", null, stoatServerId, "error", msg, discordUserId, stoatUserId);
  }
  progress.completedSteps++;

  // --- Phase 4: Update server properties (description, system messages) ---
  checkAbort(signal);
  progress.currentAction = dryRun ? "[DRY RUN] Would update server properties..." : "Updating server properties...";
  if (onProgress) await onProgress(progress);

  if (guild) {
    try {
      const serverEditData: Record<string, unknown> = {};
      if (guild.description && guild.description !== server?.description) {
        serverEditData.description = guild.description;
      }

      if (Object.keys(serverEditData).length > 0) {
        if (dryRun) {
          progress.dryRunLog.push(`UPDATE server properties: ${Object.keys(serverEditData).join(", ")}`);
        } else {
          await stoatClient.editServer(stoatServerId, serverEditData);
          store.logMigration(guildId, "server_updated", null, stoatServerId, "success", undefined, discordUserId, stoatUserId);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      progress.errors.push({ action: "Update server properties", error: msg });
      store.logMigration(guildId, "server_updated", null, stoatServerId, "error", msg, discordUserId, stoatUserId);
    }
  }
  progress.completedSteps++;

  // --- Phase 5: Emoji migration (if requested) ---
  if (includeEmoji && guild) {
    await migrateEmoji(stoatClient, store, guildId, stoatServerId, guild, progress, onProgress, discordUserId, stoatUserId, dryRun, signal);
  }

  // --- Phase 6: Server media (icon/banner) migration (if requested) ---
  if (includeMedia && guild) {
    await migrateServerMedia(stoatClient, store, guildId, stoatServerId, guild, progress, onProgress, discordUserId, stoatUserId, dryRun, signal);
  }

  progress.currentAction = dryRun ? "Dry run complete!" : "Migration complete!";
  if (onProgress) await onProgress(progress);

  return progress;
}

/**
 * Migrate Discord guild emoji to Stoat server.
 * Downloads from Discord CDN, uploads to Autumn, creates emoji in Stoat.
 * Resolves name conflicts by appending incrementing suffix (name0, name1, ...).
 */
async function migrateEmoji(
  stoatClient: StoatClient,
  store: Store,
  guildId: string,
  stoatServerId: string,
  guild: import("discord.js").Guild,
  progress: MigrationProgress,
  onProgress?: ProgressCallback,
  discordUserId?: string,
  stoatUserId?: string,
  dryRun = false,
  signal?: AbortSignal
): Promise<void> {
  // Fetch existing Stoat emoji for dedup
  const existingEmojiNames = new Set<string>();
  try {
    const existingEmoji = await stoatClient.listEmoji(stoatServerId);
    for (const e of existingEmoji) {
      existingEmojiNames.add(e.name.toLowerCase());
    }
  } catch {
    // Server may not have any emoji yet, or endpoint may not be available
    progress.warnings.push("Could not fetch existing Stoat emoji for dedup — proceeding without");
  }

  for (const [, emoji] of guild.emojis.cache) {
    checkAbort(signal);

    // Resolve name conflicts
    let resolvedName = emoji.name ?? "emoji";
    if (existingEmojiNames.has(resolvedName.toLowerCase())) {
      let suffix = 0;
      while (existingEmojiNames.has(`${resolvedName}${suffix}`.toLowerCase())) {
        suffix++;
      }
      const originalName = resolvedName;
      resolvedName = `${resolvedName}${suffix}`;
      progress.warnings.push(`Emoji renamed: '${originalName}' → '${resolvedName}'`);
    }

    progress.currentAction = dryRun
      ? `[DRY RUN] Would migrate emoji: ${resolvedName}`
      : `Migrating emoji: ${resolvedName}`;
    if (onProgress) await onProgress(progress);

    if (dryRun) {
      progress.dryRunLog.push(`CREATE emoji "${resolvedName}"${emoji.animated ? " (animated)" : ""}`);
      progress.created++;
    } else {
      try {
        // Download emoji from Discord CDN
        const emojiUrl = emoji.imageURL({ size: 256, extension: emoji.animated ? "gif" : "png" });
        const response = await fetch(emojiUrl);
        if (!response.ok) throw new Error(`Failed to download emoji: ${response.status}`);
        let buffer: Uint8Array | null = new Uint8Array(await response.arrayBuffer());

        // Upload to Autumn
        const filename = `${resolvedName}.${emoji.animated ? "gif" : "png"}`;
        const uploaded = await stoatClient.uploadFile("emojis", buffer, filename);
        buffer = null; // Release memory immediately

        // Create emoji in Stoat
        await stoatClient.createEmoji(resolvedName, stoatServerId, uploaded.id);
        existingEmojiNames.add(resolvedName.toLowerCase());

        store.logMigration(guildId, "emoji_created", emoji.id, uploaded.id, "success", undefined, discordUserId, stoatUserId);
        progress.created++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        progress.errors.push({ action: `Emoji: ${resolvedName}`, error: msg });
        store.logMigration(guildId, "emoji_created", emoji.id, null, "error", msg, discordUserId, stoatUserId);
      }
    }

    progress.completedSteps++;
    if (!dryRun) await sleep(EMOJI_DELAY);
  }
}

/**
 * Migrate server icon and banner from Discord to Stoat.
 * Downloads images, uploads to Autumn, then calls editServer.
 */
async function migrateServerMedia(
  stoatClient: StoatClient,
  store: Store,
  guildId: string,
  stoatServerId: string,
  guild: import("discord.js").Guild,
  progress: MigrationProgress,
  onProgress?: ProgressCallback,
  discordUserId?: string,
  stoatUserId?: string,
  dryRun = false,
  signal?: AbortSignal
): Promise<void> {
  // --- Server icon ---
  checkAbort(signal);
  progress.currentAction = dryRun ? "[DRY RUN] Would migrate server icon..." : "Migrating server icon...";
  if (onProgress) await onProgress(progress);

  const iconUrl = guild.iconURL({ size: 1024, extension: "png" });
  if (iconUrl) {
    if (dryRun) {
      progress.dryRunLog.push("UPLOAD server icon to Autumn and set on server");
      progress.created++;
    } else {
      try {
        const response = await fetch(iconUrl);
        if (!response.ok) throw new Error(`Failed to download icon: ${response.status}`);
        let buffer: Uint8Array | null = new Uint8Array(await response.arrayBuffer());

        const uploaded = await stoatClient.uploadFile("icons", buffer, "server-icon.png");
        buffer = null; // Release memory

        await stoatClient.editServer(stoatServerId, { icon: uploaded.id });
        store.logMigration(guildId, "server_icon_set", null, stoatServerId, "success", undefined, discordUserId, stoatUserId);
        progress.created++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        progress.errors.push({ action: "Server icon", error: msg });
        progress.warnings.push(`Server icon upload failed: ${msg}`);
      }
    }
  } else {
    progress.skipped++;
  }
  progress.completedSteps++;

  // --- Server banner ---
  checkAbort(signal);
  progress.currentAction = dryRun ? "[DRY RUN] Would migrate server banner..." : "Migrating server banner...";
  if (onProgress) await onProgress(progress);

  const bannerUrl = guild.bannerURL({ size: 1024, extension: "png" });
  if (bannerUrl) {
    if (dryRun) {
      progress.dryRunLog.push("UPLOAD server banner to Autumn and set on server");
      progress.created++;
    } else {
      try {
        const response = await fetch(bannerUrl);
        if (!response.ok) throw new Error(`Failed to download banner: ${response.status}`);
        let buffer: Uint8Array | null = new Uint8Array(await response.arrayBuffer());

        const uploaded = await stoatClient.uploadFile("banners", buffer, "server-banner.png");
        buffer = null; // Release memory

        await stoatClient.editServer(stoatServerId, { banner: uploaded.id });
        store.logMigration(guildId, "server_banner_set", null, stoatServerId, "success", undefined, discordUserId, stoatUserId);
        progress.created++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        progress.errors.push({ action: "Server banner", error: msg });
        progress.warnings.push(`Server banner upload failed: ${msg}`);
      }
    }
  } else {
    progress.skipped++;
  }
  progress.completedSteps++;
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
