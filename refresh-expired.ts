#!/usr/bin/env bun
/**
 * Re-fetches expired Discord CDN links by querying the Discord API
 * for the original message, extracting the refreshed attachment URL,
 * and downloading the file.
 *
 * Reads failed entries from dl-progress.ndjson, filters to Discord CDN
 * 404s, re-fetches the message via REST, and downloads with the new URL.
 *
 * Crash-safe: appends results to dl-progress.ndjson so resume is automatic.
 *
 * Usage:
 *   bun refresh-expired.ts
 *   bun refresh-expired.ts --limit 100
 */

import { REST, Routes, type APIMessage } from "discord.js";
import { resolve } from "path";
import { mkdir, appendFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = import.meta.dir;
const OUTPUT_DIR = resolve(PROJECT_ROOT, "output");
const NDJSON_PATH = resolve(OUTPUT_DIR, "gifs.ndjson");
const DOWNLOAD_DIR = resolve(OUTPUT_DIR, "gifs");
const DL_PROGRESS_PATH = resolve(OUTPUT_DIR, "dl-progress.ndjson");
const REFRESH_PROGRESS_PATH = resolve(OUTPUT_DIR, "refresh-progress.ndjson");

const CONCURRENCY = 2;
const STAGGER_MS = 500;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? "0", 10) : 0;

// ── Discord REST client ─────────────────────────────────────────────────────

const token = process.env["DISCORD_TOKEN"];
if (!token) {
  console.error("DISCORD_TOKEN is required — set it in .env");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

// ── Types ───────────────────────────────────────────────────────────────────

interface GifEntry {
  url: string;
  channelId: string;
  channelName: string;
  messageId: string;
  authorTag: string;
  timestamp: string;
}

interface DlRecord {
  originalUrl: string;
  mediaUrl: string;
  filename: string;
  size: number;
  status: "ok" | "skip" | "error";
  error?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function guessExtension(url: string, contentType?: string | null): string {
  const pathMatch = new URL(url).pathname.match(/\.(gif|gifv|mp4|webm|webp|png|jpg|jpeg)(\?|$)/i);
  if (pathMatch?.[1]) return pathMatch[1].toLowerCase();
  if (contentType) {
    if (contentType.includes("gif")) return "gif";
    if (contentType.includes("mp4")) return "mp4";
    if (contentType.includes("webp")) return "webp";
  }
  return "gif";
}

/** Load already-refreshed URLs so we don't redo them */
async function loadRefreshedUrls(): Promise<Set<string>> {
  const done = new Set<string>();
  if (!existsSync(REFRESH_PROGRESS_PATH)) return done;
  const rl = createInterface({ input: createReadStream(REFRESH_PROGRESS_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as DlRecord;
      done.add(rec.originalUrl);
    } catch {}
  }
  return done;
}

async function recordRefresh(rec: DlRecord): Promise<void> {
  await appendFile(REFRESH_PROGRESS_PATH, JSON.stringify(rec) + "\n");
}

/** Fetch a single message from Discord API with retries */
async function fetchMessage(channelId: string, messageId: string): Promise<APIMessage | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return (await rest.get(Routes.channelMessage(channelId, messageId))) as APIMessage;
    } catch (err: any) {
      if (err.status === 404 || err.status === 403) return null; // deleted/inaccessible
      const isTransient = ["ConnectionRefused", "ECONNRESET", "ETIMEDOUT"].includes(err.code)
        || [429, 500, 502, 503].includes(err.status);
      if (isTransient && attempt < 4) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 30_000);
        await Bun.sleep(delay);
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Download a file from a URL */
async function downloadUrl(url: string, hash: string): Promise<{ filename: string; size: number } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return null;

      const cl = resp.headers.get("content-length");
      if (cl && parseInt(cl) > MAX_FILE_SIZE) return null;

      const buf = await resp.arrayBuffer();
      if (buf.byteLength > MAX_FILE_SIZE) return null;

      const ext = guessExtension(url, resp.headers.get("content-type"));
      const filename = `${hash}.${ext}`;
      await Bun.write(resolve(DOWNLOAD_DIR, filename), buf);
      return { filename, size: buf.byteLength };
    } catch {
      if (attempt < 2) await Bun.sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Refreshing expired Discord CDN links…\n");
  await mkdir(DOWNLOAD_DIR, { recursive: true });

  // 1. Collect failed Discord CDN entries from dl-progress.ndjson
  //    We need the originalUrl + the original GifEntry (for channelId/messageId)
  console.log("Loading failed download records…");
  const failedUrls = new Set<string>();
  const rl1 = createInterface({ input: createReadStream(DL_PROGRESS_PATH), crlfDelay: Infinity });
  for await (const line of rl1) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as DlRecord;
    if (rec.status !== "skip" && rec.status !== "error") continue;
    // Only Discord CDN/media URLs
    const host = new URL(rec.originalUrl).hostname;
    if (host === "cdn.discordapp.com" || host === "media.discordapp.net") {
      failedUrls.add(rec.originalUrl);
    }
  }
  console.log(`Found ${failedUrls.size} expired Discord CDN URLs`);

  // 2. Look up channelId + messageId for each from the original NDJSON
  console.log("Loading source metadata from NDJSON…");
  const entries = new Map<string, GifEntry>();
  const rl2 = createInterface({ input: createReadStream(NDJSON_PATH), crlfDelay: Infinity });
  for await (const line of rl2) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as GifEntry;
    if (failedUrls.has(entry.url) && !entries.has(entry.url)) {
      entries.set(entry.url, entry);
    }
  }
  console.log(`Matched ${entries.size} entries with channel/message metadata`);

  // 3. Filter out already-refreshed
  const refreshed = await loadRefreshedUrls();
  const pending = [...entries.entries()].filter(([url]) => !refreshed.has(url));
  console.log(`${refreshed.size} already attempted, ${pending.length} remaining`);

  if (!pending.length) {
    console.log("Nothing to refresh.");
    return;
  }

  const toProcess = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;
  if (LIMIT > 0) console.log(`--limit ${LIMIT}: processing ${toProcess.length} of ${pending.length}`);

  console.log(`\nRefreshing ${toProcess.length} URLs (concurrency=${CONCURRENCY})…\n`);

  let ok = 0, stillDead = 0, errors = 0;
  let totalBytes = 0;

  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);

    const results = await Promise.all(batch.map(async ([originalUrl, entry]) => {
      const hash = urlHash(originalUrl);

      // Re-fetch the message to get a fresh attachment URL
      const msg = await fetchMessage(entry.channelId, entry.messageId);
      if (!msg) {
        return { originalUrl, mediaUrl: originalUrl, filename: "", size: 0, status: "skip" as const, error: "message deleted/inaccessible" };
      }

      // Find a matching attachment or embed with a .gif URL
      const originalPath = new URL(originalUrl).pathname.replace(/\?.*$/, "");
      // Extract just the filename portion for matching
      const originalFilename = originalPath.split("/").pop() ?? "";

      let freshUrl: string | null = null;

      // Check attachments
      for (const att of msg.attachments ?? []) {
        const attPath = new URL(att.url).pathname;
        const attFilename = attPath.split("/").pop() ?? "";
        if (attFilename === originalFilename || attPath === originalPath) {
          freshUrl = att.url;
          break;
        }
      }

      // Check embeds if no attachment match
      if (!freshUrl) {
        for (const embed of msg.embeds ?? []) {
          for (const candidate of [
            embed.thumbnail?.url, embed.image?.url, embed.video?.url,
            embed.thumbnail?.proxy_url, embed.image?.proxy_url, embed.video?.proxy_url,
          ].filter(Boolean) as string[]) {
            if (candidate.includes(".gif") || candidate.includes(".gifv")) {
              freshUrl = candidate;
              break;
            }
          }
          if (freshUrl) break;
        }
      }

      // Also check all attachments for any .gif if exact match failed
      if (!freshUrl) {
        for (const att of msg.attachments ?? []) {
          if (att.url.includes(".gif")) {
            freshUrl = att.url;
            break;
          }
        }
      }

      if (!freshUrl) {
        return { originalUrl, mediaUrl: originalUrl, filename: "", size: 0, status: "skip" as const, error: "no matching attachment in message" };
      }

      // Download with fresh URL
      const result = await downloadUrl(freshUrl, hash);
      if (!result) {
        return { originalUrl, mediaUrl: freshUrl, filename: "", size: 0, status: "error" as const, error: "download failed" };
      }

      return { originalUrl, mediaUrl: freshUrl, filename: result.filename, size: result.size, status: "ok" as const };
    }));

    for (const rec of results) {
      await recordRefresh(rec);
      if (rec.status === "ok") { ok++; totalBytes += rec.size; }
      else if (rec.status === "skip") stillDead++;
      else errors++;
    }

    const done = Math.min(i + CONCURRENCY, toProcess.length);
    if (done % 50 === 0 || done === toProcess.length) {
      const pct = ((done / toProcess.length) * 100).toFixed(1);
      console.log(`  [${pct}%] ${done}/${toProcess.length} — ${ok} recovered, ${stillDead} dead, ${errors} errors`);
    }

    if (i + CONCURRENCY < toProcess.length) {
      await Bun.sleep(STAGGER_MS);
    }
  }

  console.log(`\n━━━ Done ━━━`);
  console.log(`Recovered: ${ok} (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Dead (deleted messages): ${stillDead}`);
  console.log(`Errors: ${errors}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
