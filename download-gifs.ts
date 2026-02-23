#!/usr/bin/env bun
/**
 * Downloads all GIF URLs collected by scrape-gifs.ts.
 *
 * Reads output/gifs.ndjson, deduplicates by URL, resolves landing-page
 * URLs (tenor, giphy, klipy) to their actual media, and downloads each
 * to output/gifs/<hash>.<ext>.
 *
 * Crash-safe: tracks completed URLs in a progress NDJSON so it can
 * resume mid-run after OOM or network failure.
 *
 * Usage:
 *   bun download-gifs.ts              # download all (auto-resumes)
 *   bun download-gifs.ts --fresh      # wipe downloads + progress, start over
 *   bun download-gifs.ts --limit 100  # download at most 100 new files
 */

import { resolve } from "path";
import { mkdir, appendFile, unlink, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = import.meta.dir;
const OUTPUT_DIR = resolve(PROJECT_ROOT, "output");
const NDJSON_PATH = resolve(OUTPUT_DIR, "gifs.ndjson");
const DOWNLOAD_DIR = resolve(OUTPUT_DIR, "gifs");
const DL_PROGRESS_PATH = resolve(OUTPUT_DIR, "dl-progress.ndjson");
const DL_INDEX_PATH = resolve(OUTPUT_DIR, "dl-index.json");

/** Concurrent download slots */
const CONCURRENCY = 3;

/** Delay between starting downloads (ms) — avoid hammering servers */
const STAGGER_MS = 300;

/** Max file size to download (50MB) */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** Download timeout per file (30s) */
const FETCH_TIMEOUT_MS = 30_000;

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FRESH = args.includes("--fresh");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? "0", 10) : 0;

// ── Types ───────────────────────────────────────────────────────────────────

interface GifEntry {
  url: string;
  channelId: string;
  channelName: string;
  messageId: string;
  authorTag: string;
  timestamp: string;
}

/** One line in dl-progress.ndjson — tracks each completed download */
interface DlRecord {
  /** Original URL from the scrape */
  originalUrl: string;
  /** Resolved media URL (may differ for tenor/giphy landing pages) */
  mediaUrl: string;
  /** Local filename in output/gifs/ */
  filename: string;
  /** File size in bytes */
  size: number;
  /** "ok" | "skip" | "error" */
  status: "ok" | "skip" | "error";
  /** Error message if status=error */
  error?: string;
}

// ── Progress tracking ───────────────────────────────────────────────────────

/** Load set of already-processed original URLs from progress NDJSON */
async function loadCompletedUrls(): Promise<Set<string>> {
  const completed = new Set<string>();
  if (!existsSync(DL_PROGRESS_PATH)) return completed;

  const rl = createInterface({ input: createReadStream(DL_PROGRESS_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as DlRecord;
      completed.add(rec.originalUrl);
    } catch { /* skip corrupt lines */ }
  }
  return completed;
}

/** Append a completed download record */
async function recordDownload(rec: DlRecord): Promise<void> {
  await appendFile(DL_PROGRESS_PATH, JSON.stringify(rec) + "\n");
}

// ── URL resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a landing-page URL to its actual media URL.
 * For tenor.com, giphy.com, klipy.com — fetch the page HTML and extract
 * the og:image or og:video meta tag which points to the actual .gif/.mp4.
 */
async function resolveMediaUrl(url: string): Promise<string> {
  const hostname = new URL(url).hostname;

  // Already a direct media URL — no resolution needed
  if (
    hostname === "cdn.discordapp.com" ||
    hostname === "media.discordapp.net" ||
    hostname === "i.imgur.com" ||
    hostname === "i.giphy.com" ||
    hostname === "media.giphy.com" ||
    hostname === "media2.giphy.com" ||
    hostname === "media.tenor.com" ||
    hostname === "c.tenor.com" ||
    hostname === "thumbs.gfycat.com"
  ) {
    return url;
  }

  // For landing pages, fetch HTML and extract og:image / og:video
  if (
    hostname === "tenor.com" ||
    hostname === "giphy.com" ||
    hostname === "www.giphy.com" ||
    hostname === "klipy.com" ||
    hostname === "www.klipy.com" ||
    hostname === "gfycat.com" ||
    hostname === "imgur.com" ||
    hostname === "www.imgur.com" ||
    hostname === "m.imgur.com"
  ) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; GifScraper/1.0)" },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return url; // fall back to original
      const html = await resp.text();

      // Try og:video first (usually the .mp4), then og:image (usually the .gif)
      const ogVideo = html.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"/i)?.[1]
        ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video"/i)?.[1];
      const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1]
        ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i)?.[1];

      // Prefer .gif over .mp4 for og:image, but take what we can get
      const resolved = ogImage ?? ogVideo;
      if (resolved) return resolved;
    } catch {
      // Failed to resolve — fall back to original URL
    }
  }

  return url;
}

// ── Download logic ──────────────────────────────────────────────────────────

/** Hash a URL to create a stable filename */
function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** Guess file extension from URL or content-type */
function guessExtension(url: string, contentType?: string | null): string {
  // Check URL path first
  const pathMatch = new URL(url).pathname.match(/\.(gif|gifv|mp4|webm|webp|png|jpg|jpeg)(\?|$)/i);
  if (pathMatch?.[1]) return pathMatch[1].toLowerCase();

  // Fall back to content-type
  if (contentType) {
    if (contentType.includes("gif")) return "gif";
    if (contentType.includes("mp4")) return "mp4";
    if (contentType.includes("webm")) return "webm";
    if (contentType.includes("webp")) return "webp";
    if (contentType.includes("png")) return "png";
    if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  }

  return "gif"; // default assumption
}

/** Download a single file with retries */
async function downloadFile(
  originalUrl: string,
  index: number,
  total: number,
): Promise<DlRecord> {
  // Resolve landing page to actual media URL
  let mediaUrl: string;
  try {
    mediaUrl = await resolveMediaUrl(originalUrl);
  } catch {
    mediaUrl = originalUrl;
  }

  const hash = urlHash(originalUrl);

  try {
    const MAX_RETRIES = 3;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(mediaUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; GifScraper/1.0)" },
          redirect: "follow",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!resp.ok) {
          if (resp.status === 404 || resp.status === 410) {
            // Dead link — skip permanently
            return { originalUrl, mediaUrl, filename: "", size: 0, status: "skip", error: `HTTP ${resp.status}` };
          }
          throw new Error(`HTTP ${resp.status}`);
        }

        // Check content-length before downloading
        const cl = resp.headers.get("content-length");
        if (cl && parseInt(cl) > MAX_FILE_SIZE) {
          return { originalUrl, mediaUrl, filename: "", size: 0, status: "skip", error: `Too large: ${cl} bytes` };
        }

        const ext = guessExtension(mediaUrl, resp.headers.get("content-type"));
        const filename = `${hash}.${ext}`;
        const filePath = resolve(DOWNLOAD_DIR, filename);

        const buf = await resp.arrayBuffer();
        if (buf.byteLength > MAX_FILE_SIZE) {
          return { originalUrl, mediaUrl, filename: "", size: 0, status: "skip", error: `Too large: ${buf.byteLength} bytes` };
        }

        await Bun.write(filePath, buf);

        const pct = ((index / total) * 100).toFixed(1);
        if (index % 50 === 0 || index === total) {
          console.log(`  [${pct}%] ${index}/${total} — ${filename} (${(buf.byteLength / 1024).toFixed(0)}KB)`);
        }

        return { originalUrl, mediaUrl, filename, size: buf.byteLength, status: "ok" };
      } catch (err: any) {
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          const delay = 2000 * Math.pow(2, attempt);
          await Bun.sleep(delay);
          continue;
        }
      }
    }

    return { originalUrl, mediaUrl, filename: "", size: 0, status: "error", error: lastErr?.message ?? "unknown" };
  } catch (err: any) {
    return { originalUrl, mediaUrl, filename: "", size: 0, status: "error", error: err.message };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("GIF downloader");
  await mkdir(DOWNLOAD_DIR, { recursive: true });

  if (FRESH) {
    console.log("--fresh: wiping prior downloads and progress");
    try { await unlink(DL_PROGRESS_PATH); } catch {}
    // Don't rm -rf the gifs dir, just let new downloads overwrite
  }

  // Load unique URLs from NDJSON
  console.log("Reading NDJSON…");
  const allUrls: string[] = [];
  const seen = new Set<string>();
  const rl = createInterface({ input: createReadStream(NDJSON_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as GifEntry;
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    allUrls.push(entry.url);
  }
  console.log(`${allUrls.length} unique URLs`);

  // Load already-completed downloads
  const completed = await loadCompletedUrls();
  const pending = allUrls.filter((u) => !completed.has(u));
  console.log(`${completed.size} already downloaded, ${pending.length} remaining`);

  if (!pending.length) {
    console.log("Nothing to download.");
    return;
  }

  const toDownload = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;
  if (LIMIT > 0) console.log(`--limit ${LIMIT}: downloading ${toDownload.length} of ${pending.length}`);

  console.log(`\nDownloading ${toDownload.length} files (concurrency=${CONCURRENCY})…\n`);

  let ok = 0, skipped = 0, errors = 0;
  let totalBytes = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
    const batch = toDownload.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((url, j) => downloadFile(url, completed.size + i + j + 1, completed.size + toDownload.length))
    );

    for (const rec of results) {
      await recordDownload(rec);
      if (rec.status === "ok") { ok++; totalBytes += rec.size; }
      else if (rec.status === "skip") skipped++;
      else errors++;
    }

    // Stagger to avoid rate limiting
    if (i + CONCURRENCY < toDownload.length) {
      await Bun.sleep(STAGGER_MS);
    }
  }

  console.log(`\n━━━ Done ━━━`);
  console.log(`Downloaded: ${ok} (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Skipped: ${skipped} (dead links, too large)`);
  console.log(`Errors: ${errors}`);

  // Build index JSON mapping original URL → local file
  console.log("\nBuilding index…");
  const index: Record<string, { filename: string; mediaUrl: string; size: number }> = {};
  const rl2 = createInterface({ input: createReadStream(DL_PROGRESS_PATH), crlfDelay: Infinity });
  for await (const line of rl2) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as DlRecord;
      if (rec.status === "ok") {
        index[rec.originalUrl] = { filename: rec.filename, mediaUrl: rec.mediaUrl, size: rec.size };
      }
    } catch {}
  }
  await Bun.write(DL_INDEX_PATH, JSON.stringify(index, null, 2));
  console.log(`Index: ${Object.keys(index).length} entries → ${DL_INDEX_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
