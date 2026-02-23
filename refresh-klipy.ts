#!/usr/bin/env bun
/**
 * Resolves klipy.com GIF URLs by re-fetching the Discord message and
 * extracting the actual static.klipy.com media URL from Discord's cached embed.
 *
 * Klipy's site is behind Cloudflare bot protection, but Discord's embed
 * unfurler already fetched and cached the real CDN URL (static.klipy.com).
 *
 * Crash-safe: appends results to refresh-klipy-progress.ndjson.
 *
 * Usage:
 *   bun refresh-klipy.ts
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
const KLIPY_PROGRESS_PATH = resolve(OUTPUT_DIR, "refresh-klipy-progress.ndjson");

const STAGGER_MS = 600; // be gentle with Discord API
const FETCH_TIMEOUT_MS = 30_000;

// ── Discord REST ────────────────────────────────────────────────────────────

const token = process.env["DISCORD_TOKEN"];
if (!token) { console.error("DISCORD_TOKEN required"); process.exit(1); }
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
  const m = new URL(url).pathname.match(/\.(gif|mp4|webm|webp|png|jpg)(\?|$)/i);
  if (m?.[1]) return m[1].toLowerCase();
  if (contentType?.includes("mp4")) return "mp4";
  if (contentType?.includes("webp")) return "webp";
  if (contentType?.includes("gif")) return "gif";
  return "mp4";
}

async function loadDoneUrls(path: string): Promise<Set<string>> {
  const done = new Set<string>();
  if (!existsSync(path)) return done;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).originalUrl); } catch {}
  }
  return done;
}

async function record(rec: DlRecord): Promise<void> {
  await appendFile(KLIPY_PROGRESS_PATH, JSON.stringify(rec) + "\n");
}

async function fetchMessage(channelId: string, messageId: string): Promise<APIMessage | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return (await rest.get(Routes.channelMessage(channelId, messageId))) as APIMessage;
    } catch (err: any) {
      if (err.status === 404 || err.status === 403) return null;
      const isTransient = ["ConnectionRefused", "ECONNRESET", "ETIMEDOUT"].includes(err.code)
        || [429, 500, 502, 503].includes(err.status);
      if (isTransient && attempt < 4) {
        await Bun.sleep(Math.min(2000 * Math.pow(2, attempt), 30_000));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function downloadUrl(url: string, hash: string): Promise<{ filename: string; size: number } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
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
  console.log("Resolving klipy.com URLs via Discord embed cache…\n");
  await mkdir(DOWNLOAD_DIR, { recursive: true });

  // 1. Find klipy URLs that failed download
  console.log("Loading failed klipy records…");
  const failedKlipy = new Set<string>();
  const rl1 = createInterface({ input: createReadStream(DL_PROGRESS_PATH), crlfDelay: Infinity });
  for await (const line of rl1) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as DlRecord;
    if ((rec.status === "error" || rec.status === "skip") && rec.originalUrl.includes("klipy.com")) {
      failedKlipy.add(rec.originalUrl);
    }
  }
  console.log(`Found ${failedKlipy.size} failed klipy URLs`);

  // 2. Get channel/message metadata from NDJSON
  const entries = new Map<string, GifEntry>();
  const rl2 = createInterface({ input: createReadStream(NDJSON_PATH), crlfDelay: Infinity });
  for await (const line of rl2) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as GifEntry;
    if (failedKlipy.has(entry.url) && !entries.has(entry.url)) {
      entries.set(entry.url, entry);
    }
  }
  console.log(`Matched ${entries.size} with message metadata`);

  // 3. Filter already-done
  const done = await loadDoneUrls(KLIPY_PROGRESS_PATH);
  const pending = [...entries.entries()].filter(([url]) => !done.has(url));
  console.log(`${done.size} already attempted, ${pending.length} remaining\n`);

  if (!pending.length) { console.log("Nothing to do."); return; }

  let ok = 0, dead = 0, errors = 0;
  let totalBytes = 0;

  for (let i = 0; i < pending.length; i++) {
    const [originalUrl, entry] = pending[i];
    const hash = urlHash(originalUrl);

    // Re-fetch the Discord message to get the embed
    const msg = await fetchMessage(entry.channelId, entry.messageId);
    if (!msg) {
      await record({ originalUrl, mediaUrl: "", filename: "", size: 0, status: "skip", error: "message gone" });
      dead++;
      continue;
    }

    // Find klipy embed with video or thumbnail from static.klipy.com
    let mediaUrl: string | null = null;
    for (const embed of msg.embeds ?? []) {
      if (!embed.url?.includes("klipy.com")) continue;
      // Prefer video (mp4) over thumbnail (webp)
      mediaUrl = embed.video?.url ?? embed.thumbnail?.url ?? null;
      if (mediaUrl) break;
    }

    if (!mediaUrl) {
      await record({ originalUrl, mediaUrl: "", filename: "", size: 0, status: "skip", error: "no klipy embed found" });
      dead++;
      continue;
    }

    // Download from static.klipy.com
    const result = await downloadUrl(mediaUrl, hash);
    if (!result) {
      await record({ originalUrl, mediaUrl, filename: "", size: 0, status: "error", error: "download failed" });
      errors++;
    } else {
      await record({ originalUrl, mediaUrl, filename: result.filename, size: result.size, status: "ok" });
      ok++;
      totalBytes += result.size;
    }

    if ((i + 1) % 10 === 0 || i + 1 === pending.length) {
      const pct = (((i + 1) / pending.length) * 100).toFixed(1);
      console.log(`  [${pct}%] ${i + 1}/${pending.length} — ${ok} ok, ${dead} dead, ${errors} err (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
    }

    await Bun.sleep(STAGGER_MS);
  }

  console.log(`\n━━━ Done ━━━`);
  console.log(`Recovered: ${ok} (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Dead: ${dead}`);
  console.log(`Errors: ${errors}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
