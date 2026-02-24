#!/usr/bin/env bun
/**
 * GIF collection audit & cleanup script.
 *
 * 1. Probes Discord API for embed metadata on Discord-CDN-sourced GIFs
 *    to recover original source URLs (tenor, giphy, imgur, etc.)
 * 2. Removes junk files (HTML error pages, imgur "removed" placeholders)
 * 3. Deduplicates identical files (keeps first, removes extras)
 * 4. Moves files > 5MB to output/gifs-large/
 *
 * Usage:
 *   bun audit-gifs.ts              # full run
 *   bun audit-gifs.ts --dry-run    # show what would happen, don't modify
 *   bun audit-gifs.ts --skip-api   # skip Discord API probe
 */

import { resolve } from "path";
import { mkdir, rename, unlink, appendFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";

// ── Config ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = import.meta.dir;
const OUTPUT_DIR = resolve(PROJECT_ROOT, "output");
const GIFS_DIR = resolve(OUTPUT_DIR, "gifs");
const LARGE_DIR = resolve(OUTPUT_DIR, "gifs-large");
const NDJSON_PATH = resolve(OUTPUT_DIR, "gifs.ndjson");
const DL_PROGRESS_PATH = resolve(OUTPUT_DIR, "dl-progress.ndjson");
const METADATA_PATH = resolve(OUTPUT_DIR, "discord-embeds.ndjson");

const SIZE_THRESHOLD = 5 * 1024 * 1024; // 5MB
const STAGGER_MS = 300;

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SKIP_API = args.includes("--skip-api");

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
  status: string;
}

interface EmbedMeta {
  originalUrl: string;
  messageId: string;
  channelId: string;
  sourceUrl: string | null;
  sourceProvider: string | null;
  embedTitle: string | null;
  embedDescription: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fileMd5(buf: Buffer | Uint8Array): string {
  return createHash("md5").update(buf).digest("hex");
}

function isHtml(buf: Buffer | Uint8Array): boolean {
  const header = Buffer.from(buf.slice(0, 20)).toString("ascii").toLowerCase();
  return header.includes("<!doctype") || header.includes("<html") || header.includes("<!DOCTYPE");
}

/** The 503-byte imgur "removed" placeholder PNG */
function isImgurPlaceholder(buf: Buffer | Uint8Array): boolean {
  return buf.length === 503 && buf[0] === 0x89 && buf[1] === 0x50; // PNG header
}

// ── Phase 1: Discord API embed probe ────────────────────────────────────────

async function probeDiscordEmbeds(): Promise<void> {
  console.log("\n━━━ Phase 1: Discord API embed probe ━━━\n");

  if (SKIP_API) {
    console.log("  Skipped (--skip-api)");
    return;
  }

  const token = process.env["DISCORD_TOKEN"];
  if (!token) {
    console.log("  No DISCORD_TOKEN — skipping API probe");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);

  // Build a map of Discord CDN URLs → messageId/channelId from gifs.ndjson
  const cdnEntries: GifEntry[] = [];
  const rl = createInterface({ input: createReadStream(NDJSON_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as GifEntry;
      if (entry.url.includes("cdn.discordapp.com") || entry.url.includes("media.discordapp.net")) {
        cdnEntries.push(entry);
      }
    } catch {}
  }

  console.log(`  Found ${cdnEntries.length} Discord CDN entries with messageId`);

  // Check which ones we already probed
  const done = new Set<string>();
  if (existsSync(METADATA_PATH)) {
    const doneRl = createInterface({ input: createReadStream(METADATA_PATH), crlfDelay: Infinity });
    for await (const line of doneRl) {
      if (!line.trim()) continue;
      try { done.add(JSON.parse(line).messageId); } catch {}
    }
  }
  const pending = cdnEntries.filter((e) => !done.has(e.messageId));
  console.log(`  ${done.size} already probed, ${pending.length} remaining`);

  if (!pending.length) return;

  // Deduplicate by messageId (same message may have multiple GIF URLs)
  const byMessage = new Map<string, GifEntry>();
  for (const e of pending) {
    if (!byMessage.has(e.messageId)) byMessage.set(e.messageId, e);
  }
  console.log(`  ${byMessage.size} unique messages to fetch\n`);

  let found = 0, empty = 0, errors = 0;

  for (const [msgId, entry] of byMessage) {
    try {
      const msg = (await rest.get(
        Routes.channelMessage(entry.channelId, msgId),
      )) as any;

      // Extract embed source info
      const embeds = msg.embeds ?? [];
      let sourceUrl: string | null = null;
      let sourceProvider: string | null = null;
      let embedTitle: string | null = null;
      let embedDescription: string | null = null;

      for (const embed of embeds) {
        // Check if the embed has a URL pointing to the original source
        const eUrl = embed.url ?? embed.video?.url ?? embed.thumbnail?.proxy_url ?? null;
        if (eUrl && !eUrl.includes("cdn.discordapp.com") && !eUrl.includes("media.discordapp.net")) {
          sourceUrl = eUrl;
          sourceProvider = embed.provider?.name ?? null;
          embedTitle = embed.title ?? null;
          embedDescription = embed.description ?? null;
          break;
        }
      }

      // Also check message content for links
      if (!sourceUrl && msg.content) {
        const urlMatch = msg.content.match(/https?:\/\/(?:tenor\.com|giphy\.com|imgur\.com|gfycat\.com|i\.imgur\.com)[^\s)>]+/i);
        if (urlMatch) sourceUrl = urlMatch[0];
      }

      const meta: EmbedMeta = {
        originalUrl: entry.url,
        messageId: msgId,
        channelId: entry.channelId,
        sourceUrl,
        sourceProvider,
        embedTitle,
        embedDescription,
      };
      await appendFile(METADATA_PATH, JSON.stringify(meta) + "\n");

      if (sourceUrl) {
        found++;
        console.log(`  [${found + empty + errors}/${byMessage.size}] FOUND ${sourceProvider ?? "?"}: ${sourceUrl.slice(0, 70)}`);
      } else {
        empty++;
      }
    } catch (err: any) {
      errors++;
      // Message might be deleted
      const meta: EmbedMeta = {
        originalUrl: entry.url,
        messageId: msgId,
        channelId: entry.channelId,
        sourceUrl: null,
        sourceProvider: null,
        embedTitle: null,
        embedDescription: null,
      };
      await appendFile(METADATA_PATH, JSON.stringify(meta) + "\n");
    }

    await Bun.sleep(STAGGER_MS);
  }

  console.log(`\n  Source URLs found: ${found}`);
  console.log(`  No embed data: ${empty}`);
  console.log(`  Errors (deleted messages): ${errors}`);
}

// ── Phase 2: Remove junk ────────────────────────────────────────────────────

async function removeJunk(): Promise<{ removed: string[] }> {
  console.log("\n━━━ Phase 2: Remove junk files ━━━\n");

  const files = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: GIFS_DIR, dot: false }));
  let htmlCount = 0, placeholderCount = 0;
  const removed: string[] = [];

  for (const fn of files) {
    const path = resolve(GIFS_DIR, fn);
    const buf = Buffer.from(await Bun.file(path).arrayBuffer());

    if (isHtml(buf)) {
      htmlCount++;
      removed.push(fn);
      if (!DRY_RUN) await unlink(path);
    } else if (isImgurPlaceholder(buf)) {
      placeholderCount++;
      removed.push(fn);
      if (!DRY_RUN) await unlink(path);
    }
  }

  console.log(`  HTML error pages removed: ${htmlCount}`);
  console.log(`  Imgur placeholders removed: ${placeholderCount}`);
  if (DRY_RUN) console.log("  (dry-run — nothing deleted)");

  return { removed };
}

// ── Phase 3: Deduplicate ────────────────────────────────────────────────────

async function deduplicate(alreadyRemoved: Set<string>): Promise<{ removed: string[] }> {
  console.log("\n━━━ Phase 3: Deduplicate identical files ━━━\n");

  const files = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: GIFS_DIR, dot: false }));
  // Skip already-removed files
  const remaining = files.filter((fn) => !alreadyRemoved.has(fn));

  // Hash all files
  const hashMap = new Map<string, string[]>();
  let processed = 0;
  for (const fn of remaining) {
    const path = resolve(GIFS_DIR, fn);
    const buf = Buffer.from(await Bun.file(path).arrayBuffer());
    const hash = fileMd5(buf);
    const group = hashMap.get(hash) ?? [];
    group.push(fn);
    hashMap.set(hash, group);
    processed++;
    if (processed % 1000 === 0) console.log(`  Hashing: ${processed}/${remaining.length}…`);
  }

  // Find duplicates and keep the first (alphabetically), remove the rest
  let dupeGroups = 0;
  let dupeFiles = 0;
  const removed: string[] = [];

  for (const [, fns] of hashMap) {
    if (fns.length <= 1) continue;
    dupeGroups++;
    // Sort to get a deterministic "keep" file
    fns.sort();
    const keep = fns[0];
    for (const fn of fns.slice(1)) {
      dupeFiles++;
      removed.push(fn);
      if (!DRY_RUN) await unlink(resolve(GIFS_DIR, fn));
    }
  }

  console.log(`  Duplicate groups: ${dupeGroups}`);
  console.log(`  Extra copies removed: ${dupeFiles}`);
  if (DRY_RUN) console.log("  (dry-run — nothing deleted)");

  return { removed };
}

// ── Phase 4: Move large files ───────────────────────────────────────────────

async function moveLargeFiles(alreadyRemoved: Set<string>): Promise<void> {
  console.log("\n━━━ Phase 4: Move files > 5MB to gifs-large/ ━━━\n");

  if (!DRY_RUN) await mkdir(LARGE_DIR, { recursive: true });

  const files = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: GIFS_DIR, dot: false }));
  const remaining = files.filter((fn) => !alreadyRemoved.has(fn));

  let moved = 0;
  let totalSize = 0;

  for (const fn of remaining) {
    const path = resolve(GIFS_DIR, fn);
    const stat = Bun.file(path);
    if (stat.size > SIZE_THRESHOLD) {
      moved++;
      totalSize += stat.size;
      if (!DRY_RUN) await rename(path, resolve(LARGE_DIR, fn));
    }
  }

  console.log(`  Files moved: ${moved} (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);
  if (DRY_RUN) console.log("  (dry-run — nothing moved)");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`GIF collection audit${DRY_RUN ? " (DRY RUN)" : ""}`);

  const initialCount = (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: GIFS_DIR, dot: false }))).length;
  console.log(`Starting files: ${initialCount}`);

  // Phase 1: Discord API probe for embed metadata
  await probeDiscordEmbeds();

  // Phase 2: Remove junk
  const junk = await removeJunk();
  const removedSet = new Set(junk.removed);

  // Phase 3: Deduplicate
  const dedup = await deduplicate(removedSet);
  for (const fn of dedup.removed) removedSet.add(fn);

  // Phase 4: Move large files
  await moveLargeFiles(removedSet);

  // Summary
  const finalCount = DRY_RUN
    ? initialCount - removedSet.size
    : (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: GIFS_DIR, dot: false }))).length;
  const largeCount = DRY_RUN
    ? 0
    : existsSync(LARGE_DIR)
      ? (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: LARGE_DIR, dot: false }))).length
      : 0;

  console.log("\n━━━ Summary ━━━");
  console.log(`  Junk removed: ${junk.removed.length}`);
  console.log(`  Duplicates removed: ${dedup.removed.length}`);
  console.log(`  Files in gifs/: ${finalCount}`);
  console.log(`  Files in gifs-large/: ${largeCount}`);
  console.log(`  Total clean collection: ${finalCount + largeCount}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
