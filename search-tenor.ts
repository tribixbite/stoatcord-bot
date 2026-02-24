#!/usr/bin/env bun
/**
 * Finds replacement tenor GIFs for dead URLs by searching with keywords
 * extracted from the original URL slug. Accepts replacements where >= 80%
 * of the original keywords match the result's tags/slug.
 *
 * Uses Tenor v2 API (public web key) for search and tag matching.
 *
 * Crash-safe: appends results to search-tenor-progress.ndjson.
 *
 * Usage:
 *   bun search-tenor.ts
 *   bun search-tenor.ts --limit 5
 *   bun search-tenor.ts --threshold 0.7   # lower match threshold
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
const RECOVER_PROGRESS_PATH = resolve(OUTPUT_DIR, "recover-tenor-progress.ndjson");
const SEARCH_PROGRESS_PATH = resolve(OUTPUT_DIR, "search-tenor-progress.ndjson");

/** Tenor v2 API — public web key extracted from tenor.com */
const TENOR_API_URL = "https://tenor.googleapis.com/v2";
const TENOR_API_KEY = "AIzaSyC-P6_qz3FzCoXGLk6tgitZo4jEJ5mLzD8";
const TENOR_CLIENT_KEY = "tenor_web";

const STAGGER_MS = 1500;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? "0", 10) : 0;
const threshIdx = args.indexOf("--threshold");
const MATCH_THRESHOLD = threshIdx !== -1 ? parseFloat(args[threshIdx + 1] ?? "0.8") : 0.8;

// ── Types ───────────────────────────────────────────────────────────────────

interface RecoverRecord {
  originalUrl: string;
  mediaUrl: string;
  filename: string;
  size: number;
  status: "ok" | "skip" | "error";
  error?: string;
  method?: string;
}

interface SearchRecord {
  originalUrl: string;
  /** URL of the replacement GIF on tenor */
  replacementUrl: string;
  mediaUrl: string;
  filename: string;
  size: number;
  status: "ok" | "skip" | "error";
  error?: string;
  /** What percentage of keywords matched */
  matchScore: number;
  originalKeywords: string[];
  matchedKeywords: string[];
}

interface TenorResult {
  id: string;
  url: string;
  itemurl: string;
  tags: string[];
  content_description: string;
  media_formats: {
    gif?: { url: string; size: number };
    mediumgif?: { url: string; size: number };
    tinygif?: { url: string; size: number };
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function guessExtension(url: string, contentType?: string | null): string {
  try {
    const m = new URL(url).pathname.match(/\.(gif|gifv|mp4|webm|webp|png|jpg|jpeg)(\?|$)/i);
    if (m?.[1]) return m[1].toLowerCase();
  } catch {}
  if (contentType) {
    if (contentType.includes("gif")) return "gif";
    if (contentType.includes("mp4")) return "mp4";
    if (contentType.includes("webp")) return "webp";
  }
  return "gif";
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

async function record(rec: SearchRecord): Promise<void> {
  await appendFile(SEARCH_PROGRESS_PATH, JSON.stringify(rec) + "\n");
}

/**
 * Extract meaningful keywords from a tenor URL slug.
 * e.g. "octagon-meme-elmo-jack-black-stop-gif-26938003"
 *   → ["octagon", "meme", "elmo", "jack", "black", "stop"]
 */
function extractKeywords(url: string): string[] {
  // Parse the slug from the URL path
  let slug = "";
  try {
    const path = new URL(url).pathname;
    // /view/slug-gif-12345 or /IAoz.gif or /search/...
    const viewMatch = path.match(/\/view\/(.+)/);
    if (viewMatch) {
      slug = viewMatch[1];
    } else {
      slug = path.replace(/^\//, "").replace(/\.gif$/i, "");
    }
  } catch {
    return [];
  }

  // Split on hyphens, remove "gif", numeric IDs, and very short words
  const parts = slug.split("-").map((s) => s.toLowerCase());

  // Remove trailing numeric ID and "gif" marker
  const keywords: string[] = [];
  for (const part of parts) {
    if (part === "gif" || part === "gifs") continue;
    if (/^\d+$/.test(part)) continue; // pure numeric
    if (part.length < 2) continue;
    keywords.push(part);
  }

  return keywords;
}

/**
 * Normalize a tag or keyword for comparison.
 * Lowercases, strips common suffixes, splits multi-word tags.
 */
function normalizeTag(tag: string): string[] {
  return tag.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/[\s-]+/)
    .filter((w) => w.length >= 2);
}

/**
 * Calculate match score: what fraction of original keywords appear in the
 * candidate's tags + slug keywords.
 */
function calculateMatchScore(
  originalKeywords: string[],
  candidateTags: string[],
  candidateSlug: string,
): { score: number; matched: string[] } {
  // Build a set of all words from the candidate's tags and slug
  const candidateWords = new Set<string>();
  for (const tag of candidateTags) {
    for (const word of normalizeTag(tag)) {
      candidateWords.add(word);
    }
  }
  // Also add slug keywords
  for (const kw of extractKeywords(candidateSlug)) {
    candidateWords.add(kw);
  }

  // Check how many original keywords appear in the candidate
  const matched: string[] = [];
  for (const kw of originalKeywords) {
    if (candidateWords.has(kw)) {
      matched.push(kw);
    }
  }

  const score = originalKeywords.length > 0 ? matched.length / originalKeywords.length : 0;
  return { score, matched };
}

// ── Tenor API ───────────────────────────────────────────────────────────────

/**
 * Search Tenor for GIFs matching the given query string.
 */
async function searchTenor(query: string, limit = 10): Promise<TenorResult[]> {
  const params = new URLSearchParams({
    q: query,
    key: TENOR_API_KEY,
    client_key: TENOR_CLIENT_KEY,
    limit: String(limit),
    media_filter: "gif,mediumgif,tinygif",
  });
  const url = `${TENOR_API_URL}/search?${params}`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      },
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { results: TenorResult[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}

/**
 * Download a GIF from a URL.
 */
async function downloadGif(
  url: string,
  hash: string,
): Promise<{ filename: string; size: number } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
        },
      });
      if (!resp.ok) return null;

      const cl = resp.headers.get("content-length");
      if (cl && parseInt(cl) > MAX_FILE_SIZE) return null;

      const buf = await resp.arrayBuffer();
      if (buf.byteLength > MAX_FILE_SIZE || buf.byteLength < 100) return null;

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
  console.log(`Searching tenor for replacement GIFs (threshold: ${(MATCH_THRESHOLD * 100).toFixed(0)}%)…\n`);
  await mkdir(DOWNLOAD_DIR, { recursive: true });

  // 1. Load unrecovered URLs from the Wayback recovery attempt
  console.log("Loading unrecovered tenor URLs…");
  const unrecovered: string[] = [];
  if (!existsSync(RECOVER_PROGRESS_PATH)) {
    console.error("No recover-tenor-progress.ndjson found — run recover-tenor.ts first");
    process.exit(1);
  }
  const rl = createInterface({ input: createReadStream(RECOVER_PROGRESS_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as RecoverRecord;
      if (rec.status !== "ok") {
        unrecovered.push(rec.originalUrl);
      }
    } catch {}
  }
  console.log(`Found ${unrecovered.length} unrecovered tenor URLs`);

  // 2. Filter already-searched
  const done = await loadDoneUrls(SEARCH_PROGRESS_PATH);
  const pending = unrecovered.filter((u) => !done.has(u));
  console.log(`${done.size} already searched, ${pending.length} remaining`);

  if (!pending.length) { console.log("Nothing to do."); return; }

  const toProcess = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;
  if (LIMIT > 0) console.log(`--limit ${LIMIT}: processing ${toProcess.length} of ${pending.length}`);

  console.log(`\nSearching ${toProcess.length} URLs…\n`);

  let ok = 0, noMatch = 0, errors = 0;
  let totalBytes = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const originalUrl = toProcess[i];
    const hash = urlHash(originalUrl);
    const keywords = extractKeywords(originalUrl);

    if (keywords.length < 2) {
      // Too few keywords to search meaningfully
      await record({
        originalUrl, replacementUrl: "", mediaUrl: "", filename: "", size: 0,
        status: "skip", error: "too few keywords", matchScore: 0,
        originalKeywords: keywords, matchedKeywords: [],
      });
      noMatch++;
      console.log(`  [${i + 1}/${toProcess.length}] SKIP  ${originalUrl} (too few keywords: ${keywords.join(", ")})`);
      await Bun.sleep(STAGGER_MS);
      continue;
    }

    // Search tenor with the keywords
    const query = keywords.join(" ");
    const results = await searchTenor(query, 10);

    if (!results.length) {
      await record({
        originalUrl, replacementUrl: "", mediaUrl: "", filename: "", size: 0,
        status: "skip", error: "no search results", matchScore: 0,
        originalKeywords: keywords, matchedKeywords: [],
      });
      noMatch++;
      console.log(`  [${i + 1}/${toProcess.length}] MISS  ${originalUrl} (no results for "${query}")`);
      await Bun.sleep(STAGGER_MS);
      continue;
    }

    // Find best matching result above threshold
    let bestResult: TenorResult | null = null;
    let bestScore = 0;
    let bestMatched: string[] = [];

    for (const result of results) {
      const { score, matched } = calculateMatchScore(
        keywords,
        result.tags,
        result.itemurl || result.url,
      );
      if (score > bestScore) {
        bestScore = score;
        bestResult = result;
        bestMatched = matched;
      }
    }

    if (!bestResult || bestScore < MATCH_THRESHOLD) {
      await record({
        originalUrl, replacementUrl: "", mediaUrl: "", filename: "", size: 0,
        status: "skip", error: `best match ${(bestScore * 100).toFixed(0)}% < ${(MATCH_THRESHOLD * 100).toFixed(0)}%`,
        matchScore: bestScore, originalKeywords: keywords, matchedKeywords: bestMatched,
      });
      noMatch++;
      console.log(`  [${i + 1}/${toProcess.length}] LOW   ${originalUrl} (best: ${(bestScore * 100).toFixed(0)}%, need ${(MATCH_THRESHOLD * 100).toFixed(0)}%)`);
      await Bun.sleep(STAGGER_MS);
      continue;
    }

    // Download the best matching GIF
    const gifUrl = bestResult.media_formats?.gif?.url
      ?? bestResult.media_formats?.mediumgif?.url
      ?? bestResult.media_formats?.tinygif?.url;

    if (!gifUrl) {
      await record({
        originalUrl, replacementUrl: bestResult.itemurl ?? bestResult.url,
        mediaUrl: "", filename: "", size: 0,
        status: "error", error: "no GIF media in result",
        matchScore: bestScore, originalKeywords: keywords, matchedKeywords: bestMatched,
      });
      errors++;
      console.log(`  [${i + 1}/${toProcess.length}] ERR   ${originalUrl} (no GIF media format)`);
      await Bun.sleep(STAGGER_MS);
      continue;
    }

    const dl = await downloadGif(gifUrl, hash);
    if (!dl) {
      await record({
        originalUrl, replacementUrl: bestResult.itemurl ?? bestResult.url,
        mediaUrl: gifUrl, filename: "", size: 0,
        status: "error", error: "download failed",
        matchScore: bestScore, originalKeywords: keywords, matchedKeywords: bestMatched,
      });
      errors++;
      console.log(`  [${i + 1}/${toProcess.length}] FAIL  ${originalUrl} (download failed)`);
    } else {
      await record({
        originalUrl, replacementUrl: bestResult.itemurl ?? bestResult.url,
        mediaUrl: gifUrl, filename: dl.filename, size: dl.size,
        status: "ok",
        matchScore: bestScore, originalKeywords: keywords, matchedKeywords: bestMatched,
      });
      ok++;
      totalBytes += dl.size;
      console.log(`  [${i + 1}/${toProcess.length}] OK    ${originalUrl}`);
      console.log(`          → ${bestResult.itemurl ?? bestResult.url}`);
      console.log(`          ${(bestScore * 100).toFixed(0)}% match [${bestMatched.join(", ")}] → ${dl.filename} (${(dl.size / 1024).toFixed(0)}KB)`);
    }

    await Bun.sleep(STAGGER_MS);
  }

  console.log(`\n━━━ Done ━━━`);
  console.log(`Replaced: ${ok} (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`No match: ${noMatch}`);
  console.log(`Errors: ${errors}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
