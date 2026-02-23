/**
 * Archive import pipeline: SQLite → Stoat.
 * Reads exported messages from archive_messages and sends them to Stoat
 * with masquerade to preserve author identity and embedded timestamps.
 */

import type { StoatClient } from "../stoat/client.ts";
import type { Store } from "../db/store.ts";
import type { ArchiveMessageRow } from "../db/schema.ts";
import { discordToRevolt, truncateForRevolt } from "../bridge/format.ts";
import { sleep } from "../util.ts";

/** Stoat rate limit: 10 messages per 10 seconds per channel */
const SEND_DELAY_MS = 1100;
/** Batch size for fetching un-imported messages from SQLite */
const IMPORT_BATCH_SIZE = 50;

export interface ImportProgress {
  jobId: string;
  status: "running" | "paused" | "completed" | "failed";
  totalMessages: number;
  importedMessages: number;
  error?: string;
}

export type ImportProgressCallback = (progress: ImportProgress) => void;

/**
 * Import archived messages into a Stoat channel.
 * Reads from archive_messages, sends with masquerade + timestamp header.
 *
 * @param stoatClient - Authenticated Stoat API client
 * @param store - Database store with archive methods
 * @param jobId - Archive job ID (export must be completed first)
 * @param stoatChannelId - Target Stoat channel
 * @param signal - Optional AbortSignal for cancellation
 * @param onProgress - Optional callback for progress updates
 * @returns Number of messages imported
 */
export async function importToStoat(
  stoatClient: StoatClient,
  store: Store,
  jobId: string,
  stoatChannelId: string,
  signal?: AbortSignal,
  onProgress?: ImportProgressCallback
): Promise<number> {
  const job = store.getArchiveJob(jobId);
  if (!job) throw new Error(`Archive job ${jobId} not found`);

  // Update job with target channel
  store.updateArchiveJobStatus(jobId, "running");

  const counts = store.getArchiveMessageCounts(jobId);
  let importedCount = counts.imported;

  const reportProgress = (status: ImportProgress["status"], error?: string) => {
    onProgress?.({
      jobId,
      status,
      totalMessages: counts.total,
      importedMessages: importedCount,
      error,
    });
  };

  reportProgress("running");

  try {
    let batch: ArchiveMessageRow[];

    // Process un-imported messages in batches
    while ((batch = store.getUnimportedMessages(jobId, IMPORT_BATCH_SIZE)).length > 0) {
      for (const msg of batch) {
        if (signal?.aborted) {
          store.updateArchiveJobStatus(jobId, "paused", {
            processedMessages: importedCount,
          });
          reportProgress("paused");
          return importedCount;
        }

        try {
          const stoatMsgId = await sendArchivedMessage(stoatClient, stoatChannelId, msg);
          if (stoatMsgId) {
            store.markArchiveMessageImported(msg.id, stoatMsgId);
            importedCount++;
          }
        } catch (err) {
          // Log but continue — don't fail the entire import on one message
          console.warn(
            `[archive] Failed to import message ${msg.discord_message_id}:`,
            err instanceof Error ? err.message : err
          );
        }

        await sleep(SEND_DELAY_MS);
      }

      // Update progress after each batch
      store.updateArchiveJobStatus(jobId, "running", {
        processedMessages: importedCount,
      });
      reportProgress("running");
    }

    store.updateArchiveJobStatus(jobId, "completed", {
      processedMessages: importedCount,
      totalMessages: counts.total,
    });
    reportProgress("completed");
    return importedCount;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    store.updateArchiveJobStatus(jobId, "failed", {
      error: errorMsg,
      processedMessages: importedCount,
    });
    reportProgress("failed", errorMsg);
    throw err;
  }
}

/**
 * Send a single archived message to Stoat with masquerade and timestamp.
 * Returns the Stoat message ID on success.
 */
async function sendArchivedMessage(
  stoatClient: StoatClient,
  channelId: string,
  msg: ArchiveMessageRow
): Promise<string | null> {
  // Build content with original timestamp header (locale-independent)
  const ts = new Date(msg.timestamp);
  const timestampStr = formatTimestamp(ts);

  let content = "";

  // Convert Discord markdown to Revolt format
  if (msg.content) {
    content = discordToRevolt(msg.content);
  }

  // Append attachment URLs (not re-hosting during archive import to avoid CDN flooding)
  if (msg.attachments_json) {
    try {
      const attachments = JSON.parse(msg.attachments_json) as Array<{ url: string; name: string }>;
      for (const att of attachments) {
        content += `\n[${att.name}](${att.url})`;
      }
    } catch {
      // Malformed JSON, skip attachments
    }
  }

  // Prepend timestamp header
  content = `*${timestampStr}*\n${content}`.trim();
  content = truncateForRevolt(content);

  if (!content) return null;

  const sent = await stoatClient.sendMessage(channelId, content, {
    masquerade: {
      name: msg.author_name,
      avatar: msg.author_avatar_url ?? undefined,
    },
  });

  return sent._id ?? null;
}

/** Format a Date as "YYYY-MM-DD HH:MM AM/PM" — locale-independent */
function formatTimestamp(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  let h = date.getUTCHours();
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${y}-${m}-${d} ${h}:${min} ${ampm} UTC`;
}
