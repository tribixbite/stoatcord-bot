/**
 * Archive import pipeline: SQLite → Stoat.
 * Reads exported messages from archive_messages and sends them to Stoat
 * with masquerade to preserve author identity, embedded timestamps,
 * attachment re-hosting, reply chain reconstruction, and embed preservation.
 */

import type { StoatClient } from "../stoat/client.ts";
import type { Store } from "../db/store.ts";
import type { ArchiveMessageRow } from "../db/schema.ts";
import type { Embed, SendMessageRequest } from "../stoat/types.ts";
import { discordToRevolt, truncateForRevolt } from "../bridge/format.ts";
import { sleep } from "../util.ts";

/** Stoat rate limit: 10 messages per 10 seconds per channel */
const SEND_DELAY_MS = 1100;
/** Batch size for fetching un-imported messages from SQLite */
const IMPORT_BATCH_SIZE = 50;
/** Max attachment size for re-hosting (20MB Autumn limit) */
const MAX_REHOST_SIZE = 20 * 1024 * 1024;

export interface ImportOptions {
  /** Re-host Discord attachments to Autumn CDN (slower but preserves files) */
  rehostAttachments?: boolean;
  /** Reconstruct reply chains using Stoat replies[] (requires chronological import) */
  reconstructReplies?: boolean;
  /** Convert Discord embeds to Stoat embed format */
  preserveEmbeds?: boolean;
}

export interface ImportProgress {
  jobId: string;
  status: "running" | "paused" | "completed" | "failed";
  totalMessages: number;
  importedMessages: number;
  rehostSuccesses: number;
  rehostFailures: number;
  repliesLinked: number;
  error?: string;
}

export type ImportProgressCallback = (progress: ImportProgress) => void;

/**
 * Import archived messages into a Stoat channel.
 * Reads from archive_messages, sends with masquerade + timestamp header.
 * Optionally re-hosts attachments, reconstructs reply chains, and preserves embeds.
 */
export async function importToStoat(
  stoatClient: StoatClient,
  store: Store,
  jobId: string,
  stoatChannelId: string,
  signal?: AbortSignal,
  onProgress?: ImportProgressCallback,
  options: ImportOptions = {}
): Promise<number> {
  const {
    rehostAttachments = false,
    reconstructReplies = true,
    preserveEmbeds = false,
  } = options;

  const job = store.getArchiveJob(jobId);
  if (!job) throw new Error(`Archive job ${jobId} not found`);

  store.updateArchiveJobStatus(jobId, "running");

  const counts = store.getArchiveMessageCounts(jobId);
  let importedCount = counts.imported;
  let rehostSuccesses = 0;
  let rehostFailures = 0;
  let repliesLinked = 0;

  const reportProgress = (status: ImportProgress["status"], error?: string) => {
    onProgress?.({
      jobId,
      status,
      totalMessages: counts.total,
      importedMessages: importedCount,
      rehostSuccesses,
      rehostFailures,
      repliesLinked,
      error,
    });
  };

  reportProgress("running");

  try {
    let batch: ArchiveMessageRow[];

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
          const result = await sendArchivedMessage(
            stoatClient, store, stoatChannelId, msg, jobId,
            { rehostAttachments, reconstructReplies, preserveEmbeds }
          );
          if (result.stoatMsgId) {
            store.markArchiveMessageImported(msg.id, result.stoatMsgId);
            importedCount++;
            rehostSuccesses += result.rehostSuccesses;
            rehostFailures += result.rehostFailures;
            if (result.replyLinked) repliesLinked++;
          }
        } catch (err) {
          console.warn(
            `[archive] Failed to import message ${msg.discord_message_id}:`,
            err instanceof Error ? err.message : err
          );
        }

        await sleep(SEND_DELAY_MS);
      }

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

interface SendResult {
  stoatMsgId: string | null;
  rehostSuccesses: number;
  rehostFailures: number;
  replyLinked: boolean;
}

/**
 * Send a single archived message to Stoat with all enhancements.
 */
async function sendArchivedMessage(
  stoatClient: StoatClient,
  store: Store,
  channelId: string,
  msg: ArchiveMessageRow,
  jobId: string,
  options: { rehostAttachments: boolean; reconstructReplies: boolean; preserveEmbeds: boolean }
): Promise<SendResult> {
  const result: SendResult = {
    stoatMsgId: null,
    rehostSuccesses: 0,
    rehostFailures: 0,
    replyLinked: false,
  };

  const ts = new Date(msg.timestamp);
  const timestampStr = formatTimestamp(ts);

  let content = "";

  // Convert Discord markdown to Revolt format
  if (msg.content) {
    content = discordToRevolt(msg.content);
  }

  // Handle attachments
  const autumnIds: string[] = [];
  if (msg.attachments_json) {
    try {
      const attachments = JSON.parse(msg.attachments_json) as Array<{
        url: string; name: string; size?: number; id?: string;
      }>;

      for (const att of attachments) {
        if (options.rehostAttachments && (att.size ?? 0) <= MAX_REHOST_SIZE) {
          // Re-host: download from Discord CDN, upload to Autumn
          try {
            const res = await fetch(att.url);
            if (res.ok) {
              let buffer: Uint8Array | null = new Uint8Array(await res.arrayBuffer());
              if (buffer.length <= MAX_REHOST_SIZE) {
                const uploaded = await stoatClient.uploadFile(
                  "attachments", buffer, att.name ?? "attachment"
                );
                buffer = null; // Release memory immediately
                autumnIds.push(uploaded.id);
                result.rehostSuccesses++;
                // Brief delay between uploads to avoid Autumn rate limits
                await sleep(500);
                continue;
              }
              buffer = null; // Release oversized buffer
            }
          } catch (err) {
            console.warn(`[archive] Attachment re-host failed for ${att.name}:`, err);
            result.rehostFailures++;
          }
        }

        // Fallback: link to Discord CDN URL
        content += `\n[${att.name}](${att.url})`;
      }
    } catch {
      // Malformed JSON
    }
  }

  // Prepend timestamp header
  content = `*${timestampStr}*\n${content}`.trim();
  content = truncateForRevolt(content);

  if (!content && autumnIds.length === 0) return result;

  // Build send options
  const sendOpts: Partial<Omit<SendMessageRequest, "content">> = {
    masquerade: {
      name: msg.author_name,
      avatar: msg.author_avatar_url ?? undefined,
    },
  };

  // Attach re-hosted files
  if (autumnIds.length > 0) {
    sendOpts.attachments = autumnIds;
  }

  // Reconstruct reply chain
  if (options.reconstructReplies && msg.reply_to_id) {
    const parentStoatId = store.getImportedStoatId(jobId, msg.reply_to_id);
    if (parentStoatId) {
      sendOpts.replies = [{ id: parentStoatId, mention: false }];
      result.replyLinked = true;
    } else {
      // Parent not yet imported or not in this job — add quote fallback
      content = `> *Replying to an earlier message*\n${content}`;
      content = truncateForRevolt(content);
    }
  }

  // Preserve embeds
  if (options.preserveEmbeds && msg.embeds_json) {
    try {
      const discordEmbeds = JSON.parse(msg.embeds_json) as Array<{
        type?: string; title?: string; description?: string; url?: string;
        color?: number; footer?: string; image?: string; thumbnail?: string;
      }>;

      const stoatEmbeds: Embed[] = [];
      for (const e of discordEmbeds) {
        // Skip auto-generated link embeds (type "link" or "video")
        if (e.type === "link" || e.type === "video" || e.type === "gifv") continue;

        if (e.title || e.description) {
          stoatEmbeds.push({
            type: "Text",
            title: e.title,
            description: e.description,
            url: e.url,
            colour: e.color ? `#${e.color.toString(16).padStart(6, "0")}` : undefined,
            icon_url: e.thumbnail,
          });
        }
      }

      if (stoatEmbeds.length > 0) {
        sendOpts.embeds = stoatEmbeds;
      }
    } catch {
      // Malformed JSON
    }
  }

  const sent = await stoatClient.sendMessage(channelId, content || " ", sendOpts);
  result.stoatMsgId = sent._id ?? null;
  return result;
}

/** Format a Date as "YYYY-MM-DD HH:MM AM/PM UTC" — locale-independent */
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
