/**
 * Discord message history export pipeline.
 * Paginates through a Discord channel's messages and stores them in SQLite
 * for later import into Stoat. Supports resume via cursor tracking.
 */

import type { Client, TextChannel, Message as DiscordMessage } from "discord.js";
import type { Store } from "../db/store.ts";
import { sleep } from "../util.ts";

/** Maximum messages per Discord API fetch (API max is 100) */
const FETCH_LIMIT = 100;
/** Delay between fetches to stay well within Discord rate limits */
const FETCH_DELAY_MS = 1500;

export interface ExportProgress {
  jobId: string;
  channelName: string;
  status: "running" | "paused" | "completed" | "failed";
  totalExported: number;
  /** Discord snowflake ID of the oldest message exported so far */
  oldestMessageId: string | null;
  error?: string;
}

export type ExportProgressCallback = (progress: ExportProgress) => void;

/**
 * Export all messages from a Discord channel into archive_messages.
 * Paginates backwards from newest to oldest, storing each batch in SQLite.
 *
 * @param discordClient - Active Discord.js client
 * @param store - Database store with archive methods
 * @param jobId - Archive job ID (must be created via store.createArchiveJob first)
 * @param channelId - Discord channel to export
 * @param signal - Optional AbortSignal for cancellation
 * @param onProgress - Optional callback for progress updates
 * @returns Total messages exported
 */
export async function exportDiscordChannel(
  discordClient: Client,
  store: Store,
  jobId: string,
  channelId: string,
  signal?: AbortSignal,
  onProgress?: ExportProgressCallback
): Promise<number> {
  // Fetch channel (not just cache) for resilience after restarts
  let channel: TextChannel | undefined;
  try {
    const fetched = await discordClient.channels.fetch(channelId);
    if (fetched?.isTextBased()) {
      channel = fetched as TextChannel;
    }
  } catch {
    // fetch throws if channel doesn't exist
  }
  if (!channel) {
    store.updateArchiveJobStatus(jobId, "failed", { error: "Channel not found or not a text channel" });
    throw new Error(`Channel ${channelId} not found or not a text channel`);
  }

  // Check for existing resume cursor
  const job = store.getArchiveJob(jobId);
  let cursor: string | undefined = job?.last_message_id ?? undefined;
  let totalExported = job?.processed_messages ?? 0;

  store.updateArchiveJobStatus(jobId, "running");

  const reportProgress = (status: ExportProgress["status"], error?: string) => {
    onProgress?.({
      jobId,
      channelName: channel.name,
      status,
      totalExported,
      oldestMessageId: cursor ?? null,
      error,
    });
  };

  reportProgress("running");

  try {
    let hasMore = true;

    while (hasMore) {
      if (signal?.aborted) {
        store.updateArchiveJobStatus(jobId, "paused", {
          processedMessages: totalExported,
          lastMessageId: cursor,
        });
        reportProgress("paused");
        return totalExported;
      }

      // Fetch a batch of messages, paginating backwards
      const fetchOpts: { limit: number; before?: string } = { limit: FETCH_LIMIT };
      if (cursor) fetchOpts.before = cursor;

      const batch = await channel.messages.fetch(fetchOpts);
      if (batch.size === 0) {
        hasMore = false;
        break;
      }

      // Convert to storage format — skip system messages and webhook messages
      // (webhook messages are bridge-relayed content that already exists on the other platform)
      const toStore = [...batch.values()]
        .filter((m) => !m.system && !m.webhookId)
        .map((m) => serializeMessage(m, jobId));

      if (toStore.length > 0) {
        const inserted = store.storeArchiveMessages(toStore);
        totalExported += inserted;
      }

      // Update cursor to the oldest message in this batch
      const oldest = batch.last();
      if (oldest) {
        cursor = oldest.id;
      }

      // Save progress for resume
      store.updateArchiveJobStatus(jobId, "running", {
        processedMessages: totalExported,
        lastMessageId: cursor,
      });

      reportProgress("running");

      // If we got fewer than FETCH_LIMIT, we've reached the beginning
      if (batch.size < FETCH_LIMIT) {
        hasMore = false;
      } else {
        await sleep(FETCH_DELAY_MS);
      }
    }

    store.updateArchiveJobStatus(jobId, "completed", {
      processedMessages: totalExported,
      totalMessages: totalExported,
    });
    reportProgress("completed");
    return totalExported;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    store.updateArchiveJobStatus(jobId, "failed", {
      error: errorMsg,
      processedMessages: totalExported,
      lastMessageId: cursor,
    });
    reportProgress("failed", errorMsg);
    throw err;
  }
}

/** Convert a Discord message to the flat row format for archive_messages */
function serializeMessage(
  msg: DiscordMessage,
  jobId: string
): {
  jobId: string;
  discordMessageId: string;
  discordChannelId: string;
  authorId: string;
  authorName: string;
  authorAvatarUrl?: string;
  content?: string;
  timestamp: string;
  editedTimestamp?: string;
  replyToId?: string;
  attachmentsJson?: string;
  embedsJson?: string;
} {
  // Serialize attachments as JSON array
  const attachments = msg.attachments.size > 0
    ? JSON.stringify(
        [...msg.attachments.values()].map((a) => ({
          id: a.id,
          url: a.url,
          name: a.name,
          size: a.size,
          contentType: a.contentType,
        }))
      )
    : undefined;

  // Serialize embeds as JSON array (only non-auto-generated embeds)
  const embeds = msg.embeds.length > 0
    ? JSON.stringify(
        msg.embeds.map((e) => ({
          type: e.data.type,
          title: e.title,
          description: e.description,
          url: e.url,
          color: e.color,
          footer: e.footer?.text,
          image: e.image?.url,
          thumbnail: e.thumbnail?.url,
        }))
      )
    : undefined;

  return {
    jobId,
    discordMessageId: msg.id,
    discordChannelId: msg.channelId,
    authorId: msg.author.id,
    authorName: msg.author.displayName || msg.author.username,
    authorAvatarUrl: msg.author.displayAvatarURL({ size: 256, extension: "png" }),
    content: msg.content || undefined,
    timestamp: msg.createdAt.toISOString(),
    editedTimestamp: msg.editedAt?.toISOString(),
    replyToId: msg.reference?.messageId ?? undefined,
    attachmentsJson: attachments,
    embedsJson: embeds,
  };
}
