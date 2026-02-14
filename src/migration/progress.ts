/** Rate-limit-aware batch migration executor with progress tracking */

import { sleep } from "../util.ts";
import type { StoatClient } from "../stoat/client.ts";
import type { Store } from "../db/store.ts";
import type { ChannelMapping } from "./channels.ts";
import type { RoleMapping } from "./roles.ts";
import type { Category } from "../stoat/types.ts";

export interface MigrationProgress {
  totalSteps: number;
  completedSteps: number;
  currentAction: string;
  errors: Array<{ action: string; error: string }>;
}

export type ProgressCallback = (progress: MigrationProgress) => Promise<void>;

// Rate limit delays (ms) — conservative to avoid 429s
const ROLE_DELAY = 2500; // server bucket: 5 req/10s
const CHANNEL_DELAY = 2500; // server bucket: 5 req/10s

/**
 * Execute a full server migration: roles → channels → categories.
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
  onProgress?: ProgressCallback
): Promise<MigrationProgress> {
  const selectedChannels = channels.filter((c) => c.selected);
  const selectedRoles = roles.filter((r) => r.selected);
  const totalSteps = selectedRoles.length + selectedChannels.length + 1; // +1 for categories

  const progress: MigrationProgress = {
    totalSteps,
    completedSteps: 0,
    currentAction: "Starting migration...",
    errors: [],
  };

  if (onProgress) await onProgress(progress);

  // --- Phase 1: Create roles ---
  const roleIdMap = new Map<string, string>(); // discordRoleId → stoatRoleId

  for (const role of selectedRoles) {
    progress.currentAction = `Creating role: ${role.stoatName}`;
    if (onProgress) await onProgress(progress);

    try {
      const result = await stoatClient.createRole(stoatServerId, role.stoatName);
      roleIdMap.set(role.discordId, result.id);

      // Set role color and permissions
      if (role.stoatColor) {
        await stoatClient.editRole(stoatServerId, result.id, {
          colour: role.stoatColor,
        });
      }
      await stoatClient.setRolePermissions(
        stoatServerId,
        result.id,
        role.permissions
      );

      store.linkRole(role.discordId, result.id, guildId);
      store.logMigration(
        guildId,
        "role_created",
        role.discordId,
        result.id,
        "success",
        undefined,
        discordUserId,
        stoatUserId
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      progress.errors.push({ action: `Role: ${role.stoatName}`, error: msg });
      store.logMigration(
        guildId,
        "role_created",
        role.discordId,
        null,
        "error",
        msg,
        discordUserId,
        stoatUserId
      );
    }

    progress.completedSteps++;
    await sleep(ROLE_DELAY);
  }

  // --- Phase 2: Create channels ---
  const channelIdMap = new Map<string, string>(); // discordChannelId → stoatChannelId

  for (const ch of selectedChannels) {
    progress.currentAction = `Creating channel: ${ch.stoatName}`;
    if (onProgress) await onProgress(progress);

    try {
      const result = await stoatClient.createChannel(stoatServerId, {
        type: ch.stoatType,
        name: ch.stoatName,
      });
      channelIdMap.set(ch.discordId, result._id);

      store.logMigration(
        guildId,
        "channel_created",
        ch.discordId,
        result._id,
        "success",
        undefined,
        discordUserId,
        stoatUserId
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      progress.errors.push({
        action: `Channel: ${ch.stoatName}`,
        error: msg,
      });
      store.logMigration(
        guildId,
        "channel_created",
        ch.discordId,
        null,
        "error",
        msg,
        discordUserId,
        stoatUserId
      );
    }

    progress.completedSteps++;
    await sleep(CHANNEL_DELAY);
  }

  // --- Phase 3: Set categories ---
  progress.currentAction = "Organizing categories...";
  if (onProgress) await onProgress(progress);

  try {
    // Group created channels by category
    const categoryMap = new Map<string, string[]>(); // categoryName → stoatChannelIds
    for (const ch of selectedChannels) {
      const stoatId = channelIdMap.get(ch.discordId);
      if (!stoatId) continue;
      const catName = ch.category ?? "Uncategorized";
      if (!categoryMap.has(catName)) categoryMap.set(catName, []);
      categoryMap.get(catName)!.push(stoatId);
    }

    // Build Revolt categories array
    const categories: Category[] = [];
    for (const [title, channelIds] of categoryMap) {
      categories.push({
        id: generateCategoryId(),
        title,
        channels: channelIds,
      });
    }

    if (categories.length > 0) {
      await stoatClient.editServer(stoatServerId, { categories });
      store.logMigration(
        guildId,
        "categories_set",
        null,
        stoatServerId,
        "success",
        undefined,
        discordUserId,
        stoatUserId
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    progress.errors.push({ action: "Set categories", error: msg });
    store.logMigration(
      guildId,
      "categories_set",
      null,
      stoatServerId,
      "error",
      msg,
      discordUserId,
      stoatUserId
    );
  }

  progress.completedSteps++;
  progress.currentAction = "Migration complete!";
  if (onProgress) await onProgress(progress);

  return progress;
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
