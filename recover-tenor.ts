#!/usr/bin/env bun
/**
 * Recovers dead tenor GIF URLs via the Internet Archive Wayback Machine.
 *
 * For each dead tenor URL:
 * 1. Checks Wayback availability API for archived snapshots
 * 2. Fetches the archived HTML page and extracts og:image / og:video media URL
 * 3. Downloads the media (tries direct CDN first, then archive.org copy)
 *
 * Crash-safe: appends results to recover-tenor-progress.ndjson.
 *
 * Usage:
 *   bun recover-tenor.ts
 *   bun recover-tenor.ts --limit 5
 */

import { resolve } from "path";
import { mkdir, appendFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = import.meta.dir;
const OUTPUT_DIR = resolve(PROJECT_ROOT, "output");
const DOWNLOAD_DIR = resolve(OUTPUT_DIR, "gifs");
const DL_PROGRESS_PATH = resolve(OUTPUT_DIR, "dl-progress.ndjson");
const RECOVER_PROGRESS_PATH = resolve(OUTPUT_DIR, "recover-tenor-progress.ndjson");

/** Delay between archive.org requests — they rate-limit aggressively */
const ARCHIVE_DELAY_MS = 8000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? "0", 10) : 0;

// ── Types ───────────────────────────────────────────────────────────────────

interface DlRecord {
  originalUrl: string;
  mediaUrl: string;
  filename: string;
  size: number;
  status: "ok" | "skip" | "error";
  error?: string;
  /** Recovery method used */
  method?: "wayback-html" | "wayback-direct" | "wayback-media";
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function guessExtension(url: string, contentType?: string | null): string {
  // Strip archive.org wrapper from URL for extension guessing
  const cleanUrl = url.replace(/^https?:\/\/web\.archive\.org\/web\/\d+(?:id_)?\//, "");
  try {
    const m = new URL(cleanUrl).pathname.match(/\.(gif|gifv|mp4|webm|webp|png|jpg|jpeg)(\?|$)/i);
    if (m?.[1]) return m[1].toLowerCase();
  } catch {}
  if (contentType) {
    if (contentType.includes("gif")) return "gif";
    if (contentType.includes("mp4")) return "mp4";
    if (contentType.includes("webp")) return "webp";
  }
  return "gif";
}

async function loadDoneUrls(): Promise<Set<string>> {
  const done = new Set<string>();
  if (!existsSync(RECOVER_PROGRESS_PATH)) return done;
  const rl = createInterface({ input: createReadStream(RECOVER_PROGRESS_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).originalUrl); } catch {}
  }
  return done;
}

async function record(rec: DlRecord): Promise<void> {
  await appendFile(RECOVER_PROGRESS_PATH, JSON.stringify(rec) + "\n");
}

/**
 * Fetch with retry and backoff for archive.org rate limits.
 */
async function fetchWithRetry(
  url: string,
  opts: RequestInit = {},
  maxRetries = 3,
): Promise<Response | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
          ...(opts.headers as Record<string, string> ?? {}),
        },
      });
      if (resp.status === 429) {
        // Rate limited — wait significantly longer on each retry
        const retryAfter = parseInt(resp.headers.get("retry-after") ?? "30");
        const delay = Math.max(retryAfter * 1000, 15000 * (attempt + 1));
        console.log(`    ⏳ rate limited, waiting ${(delay / 1000).toFixed(0)}s…`);
        await Bun.sleep(delay);
        continue;
      }
      return resp;
    } catch (err: any) {
      if (attempt < maxRetries) {
        await Bun.sleep(3000 * (attempt + 1));
        continue;
      }
    }
  }
  return null;
}

// ── Wayback Machine ─────────────────────────────────────────────────────────

/**
 * Check Wayback Machine availability API for a URL.
 * Lighter than CDX, less likely to rate-limit.
 */
async function checkWaybackAvailability(url: string): Promise<{ timestamp: string; archiveUrl: string } | null> {
  const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const resp = await fetchWithRetry(apiUrl);
  if (!resp?.ok) return null;

  try {
    const data = await resp.json() as {
      archived_snapshots?: {
        closest?: { available: boolean; url: string; timestamp: string; status: string };
      };
    };
    const snap = data.archived_snapshots?.closest;
    if (!snap?.available || snap.status !== "200") return null;
    return { timestamp: snap.timestamp, archiveUrl: snap.url };
  } catch {
    return null;
  }
}

/**
 * Fetch an archived tenor page from the Wayback Machine and extract the
 * media URL from og:image / og:video meta tags or inline tenor CDN URLs.
 */
async function extractMediaFromArchive(url: string, timestamp: string): Promise<string | null> {
  // id_ suffix = raw archived page without Wayback toolbar injection
  const archiveUrl = `https://web.archive.org/web/${timestamp}id_/${url}`;
  const resp = await fetchWithRetry(archiveUrl, { redirect: "follow" });
  if (!resp?.ok) return null;

  const html = await resp.text();

  // Extract og:video (usually mp4/gif) and og:image
  const ogVideo = html.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"/i)?.[1]
    ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video"/i)?.[1];
  const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1]
    ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i)?.[1];

  // Also search for direct tenor media CDN URLs in page source
  const mediaMatch = html.match(/https?:\/\/media1?\.tenor\.com\/[^\s"'<>]+\.(?:gif|mp4)/i)?.[0]
    ?? html.match(/https?:\/\/c\.tenor\.com\/[^\s"'<>]+\.(?:gif|mp4)/i)?.[0];

  // Prefer gif image over mp4 video, fall back to in-page media
  return ogImage ?? ogVideo ?? mediaMatch ?? null;
}

/**
 * Try to download a media file from Wayback Machine.
 * Skip direct CDN — these are dead tenor GIFs, the CDN always returns 404.
 *
 * Strategy:
 * 1. Try Wayback copy at the same timestamp as the archived HTML page
 * 2. If that fails, query availability API for the media URL specifically
 */
async function downloadMedia(
  mediaUrl: string,
  hash: string,
  htmlTimestamp?: string,
): Promise<{ filename: string; size: number; finalUrl: string } | null> {
  const urls: string[] = [];

  // 1. Try Wayback copy at the same timestamp as the HTML page (no extra API call)
  if (htmlTimestamp && !mediaUrl.includes("web.archive.org")) {
    urls.push(`https://web.archive.org/web/${htmlTimestamp}id_/${mediaUrl}`);
  }

  // 2. If the mediaUrl is already a Wayback URL, try it directly
  if (mediaUrl.includes("web.archive.org")) {
    urls.push(mediaUrl);
  }

  for (const url of urls) {
    const resp = await fetchWithRetry(url, { redirect: "follow" });
    if (!resp?.ok) continue;

    const ct = resp.headers.get("content-type") ?? "";
    // Sanity check: should be an image/video, not HTML error page
    if (ct.includes("text/html")) continue;

    const cl = resp.headers.get("content-length");
    if (cl && parseInt(cl) > MAX_FILE_SIZE) continue;

    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_FILE_SIZE || buf.byteLength < 100) continue;

    const ext = guessExtension(mediaUrl, ct);
    const filename = `${hash}.${ext}`;
    await Bun.write(resolve(DOWNLOAD_DIR, filename), buf);
    return { filename, size: buf.byteLength, finalUrl: url };
  }

  // 3. Fall back: query availability API for the media URL itself
  if (!mediaUrl.includes("web.archive.org")) {
    const wayback = await checkWaybackAvailability(mediaUrl);
    if (wayback) {
      const rawUrl = wayback.archiveUrl
        .replace("http://web.archive.org", "https://web.archive.org")
        .replace(/\/web\/(\d+)\//, `/web/$1id_/`);
      await Bun.sleep(ARCHIVE_DELAY_MS);
      const resp = await fetchWithRetry(rawUrl, { redirect: "follow" });
      if (resp?.ok) {
        const ct = resp.headers.get("content-type") ?? "";
        if (!ct.includes("text/html")) {
          const buf = await resp.arrayBuffer();
          if (buf.byteLength <= MAX_FILE_SIZE && buf.byteLength >= 100) {
            const ext = guessExtension(mediaUrl, ct);
            const filename = `${hash}.${ext}`;
            await Bun.write(resolve(DOWNLOAD_DIR, filename), buf);
            return { filename, size: buf.byteLength, finalUrl: rawUrl };
          }
        }
      }
    }
  }

  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Recovering dead tenor URLs via Wayback Machine…\n");
  await mkdir(DOWNLOAD_DIR, { recursive: true });

  // 1. Collect dead tenor URLs from dl-progress.ndjson
  console.log("Loading dead tenor URLs…");
  const deadTenor: string[] = [];
  const rl = createInterface({ input: createReadStream(DL_PROGRESS_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as DlRecord;
      if ((rec.status === "skip" || rec.status === "error") && rec.originalUrl.includes("tenor")) {
        deadTenor.push(rec.originalUrl);
      }
    } catch {}
  }
  console.log(`Found ${deadTenor.length} dead tenor URLs`);

  // 2. Filter already-attempted
  const done = await loadDoneUrls();
  const pending = deadTenor.filter((u) => !done.has(u));
  console.log(`${done.size} already attempted, ${pending.length} remaining`);

  if (!pending.length) { console.log("Nothing to do."); return; }

  const toProcess = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;
  if (LIMIT > 0) console.log(`--limit ${LIMIT}: processing ${toProcess.length} of ${pending.length}`);

  console.log(`\nProcessing ${toProcess.length} URLs…\n`);

  let ok = 0, notFound = 0, errors = 0;
  let totalBytes = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const originalUrl = toProcess[i];
    const hash = urlHash(originalUrl);
    const hostname = new URL(originalUrl).hostname;

    const isLandingPage = hostname === "tenor.com" && originalUrl.includes("/view/");
    const isDirectMedia = hostname === "media.tenor.com" || hostname === "c.tenor.com";
    const isDiscordCdn = hostname === "cdn.discordapp.com" || hostname === "media.discordapp.net";

    let mediaUrl: string | null = null;
    let method: DlRecord["method"] = "wayback-direct";
    let htmlTimestamp: string | undefined;

    if (isLandingPage) {
      // Strategy: check Wayback for archived HTML, extract media meta tags
      const snap = await checkWaybackAvailability(originalUrl);
      if (snap) {
        htmlTimestamp = snap.timestamp;
        await Bun.sleep(ARCHIVE_DELAY_MS);
        mediaUrl = await extractMediaFromArchive(originalUrl, snap.timestamp);
        method = "wayback-html";
      }
    } else if (isDirectMedia || isDiscordCdn) {
      // Strategy: try to get the file directly from archive.org
      const snap = await checkWaybackAvailability(originalUrl);
      if (snap) {
        mediaUrl = snap.archiveUrl
          .replace("http://web.archive.org", "https://web.archive.org")
          .replace(/\/web\/(\d+)\//, `/web/$1id_/`);
        method = "wayback-direct";
      }
    } else {
      // Short URL or other format — check Wayback, decide by content type
      const snap = await checkWaybackAvailability(originalUrl);
      if (snap) {
        htmlTimestamp = snap.timestamp;
        // Fetch and check — if it's HTML, extract media; if binary, download directly
        await Bun.sleep(ARCHIVE_DELAY_MS);
        const archiveUrl = snap.archiveUrl
          .replace("http://web.archive.org", "https://web.archive.org")
          .replace(/\/web\/(\d+)\//, `/web/$1id_/`);
        const probeResp = await fetchWithRetry(archiveUrl, { redirect: "follow" });
        if (probeResp?.ok) {
          const ct = probeResp.headers.get("content-type") ?? "";
          if (ct.includes("text/html")) {
            // It's an HTML page — extract media
            const html = await probeResp.text();
            const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1]
              ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i)?.[1];
            const ogVideo = html.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"/i)?.[1]
              ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video"/i)?.[1];
            mediaUrl = ogImage ?? ogVideo ?? null;
            method = "wayback-html";
          } else {
            // It's a binary file — use the archive URL directly
            mediaUrl = archiveUrl;
            method = "wayback-direct";
          }
        }
      }
    }

    if (!mediaUrl) {
      await record({ originalUrl, mediaUrl: "", filename: "", size: 0, status: "skip", error: "not in Wayback Machine" });
      notFound++;
      console.log(`  [${i + 1}/${toProcess.length}] MISS  ${originalUrl}`);
      await Bun.sleep(ARCHIVE_DELAY_MS);
      continue;
    }

    // Download the media
    const result = await downloadMedia(mediaUrl, hash, htmlTimestamp);
    if (!result) {
      await record({ originalUrl, mediaUrl, filename: "", size: 0, status: "error", error: "download failed", method });
      errors++;
      console.log(`  [${i + 1}/${toProcess.length}] FAIL  ${originalUrl}`);
    } else {
      await record({ originalUrl, mediaUrl, filename: result.filename, size: result.size, status: "ok", method });
      ok++;
      totalBytes += result.size;
      console.log(`  [${i + 1}/${toProcess.length}] OK    ${originalUrl} → ${result.filename} (${(result.size / 1024).toFixed(0)}KB) [${method}]`);
    }

    await Bun.sleep(ARCHIVE_DELAY_MS);
  }

  console.log(`\n━━━ Done ━━━`);
  console.log(`Recovered: ${ok} (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Not in Wayback: ${notFound}`);
  console.log(`Errors: ${errors}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
