#!/usr/bin/env bun
/**
 * Standalone GIF scraper for a Discord guild.
 * Pulls all GIF URLs (tenor, giphy, klipy, gfycat, imgur, etc.)
 * from every accessible text channel and streams them to NDJSON on disk.
 *
 * Crash-safe: saves cursor position every 50 pages (~5k messages) so it
 * can resume mid-channel after OOM or network failure. Always resumes
 * automatically unless --fresh is passed.
 *
 * Usage:
 *   bun scrape-gifs.ts              # run (auto-resumes if prior progress exists)
 *   bun scrape-gifs.ts --fresh      # wipe prior progress and start from scratch
 *   bun scrape-gifs.ts --channel ID # scrape a single channel only
 *   bun scrape-gifs.ts --md-only    # skip scraping, just generate markdown from NDJSON
 */

import { REST, Routes, type APIMessage, type APIChannel, ChannelType } from "discord.js";
import { resolve } from "path";
import { mkdir, appendFile, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// ── Config ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = import.meta.dir;
const GUILD_ID = "793967107116236841";
const OUTPUT_DIR = resolve(PROJECT_ROOT, "output");
const NDJSON_PATH = resolve(OUTPUT_DIR, "gifs.ndjson");
const MD_PATH = resolve(OUTPUT_DIR, "gifs.md");
const PROGRESS_PATH = resolve(OUTPUT_DIR, "gifs-progress.json");

/** How often to flush progress (in pages of 100 messages each) */
const PROGRESS_FLUSH_INTERVAL = 50; // every ~5k messages

/**
 * Domains where ANY URL is a GIF/animation link (landing pages + media).
 * Discord CDN / media proxy are NOT included — they host all file types,
 * so we rely on the .gif/.gifv extension check for those.
 */
const GIF_DOMAINS = [
  "tenor.com",
  "media.tenor.com",
  "giphy.com",
  "media.giphy.com",
  "i.giphy.com",
  "klipy.com",
  "gfycat.com",
  "thumbs.gfycat.com",
  "imgur.com",
  "i.imgur.com",
];

const GIF_EXTENSIONS = [".gif", ".gifv"];
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FRESH = args.includes("--fresh");
const MD_ONLY = args.includes("--md-only");
const channelFlagIdx = args.indexOf("--channel");
const CHANNEL_FILTER = channelFlagIdx !== -1 ? args[channelFlagIdx + 1] : null;

// ── Discord REST client ─────────────────────────────────────────────────────

const token = process.env["DISCORD_TOKEN"];
if (!token && !MD_ONLY) {
  console.error("DISCORD_TOKEN is required — set it in .env");
  process.exit(1);
}

const rest = !MD_ONLY ? new REST({ version: "10" }).setToken(token!) : null!;

// ── Types ───────────────────────────────────────────────────────────────────

interface GifEntry {
  url: string;
  channelId: string;
  channelName: string;
  messageId: string;
  authorTag: string;
  timestamp: string;
}

/**
 * Crash-safe progress state.
 * Tracks completed channels AND the cursor within the current channel
 * so we can resume mid-channel after OOM/crash.
 */
interface ProgressState {
  completedChannels: string[];   // fully-scraped channel IDs
  totalGifs: number;             // running total across all channels
  /** Cursor for the channel currently being scraped (null if between channels) */
  current: {
    channelId: string;
    channelName: string;
    lastMessageId: string;       // Discord snowflake — resume pagination from here
    gifCount: number;            // gifs found so far in this channel
    pagesScanned: number;
  } | null;
}

// ── Progress management ─────────────────────────────────────────────────────

/**
 * Rebuild progress from existing NDJSON when the progress file is lost.
 * Scans channel IDs present in the NDJSON so we don't re-scrape them.
 * Lightweight: only reads channelId from each line, doesn't hold entries.
 */
async function rebuildProgressFromNdjson(): Promise<ProgressState> {
  const ndjsonFile = Bun.file(NDJSON_PATH);
  if (!(await ndjsonFile.exists())) {
    return { completedChannels: [], totalGifs: 0, current: null };
  }

  console.log("Progress file missing — rebuilding from existing NDJSON…");
  const channelIds = new Set<string>();
  let totalGifs = 0;

  const rl = createInterface({ input: createReadStream(NDJSON_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    totalGifs++;
    // Fast parse: just extract channelId without full JSON.parse
    const match = line.match(/"channelId":"([^"]+)"/);
    if (match?.[1]) channelIds.add(match[1]);
  }

  const state: ProgressState = {
    completedChannels: [...channelIds],
    totalGifs,
    current: null, // can't know the cursor, so treat all found channels as complete
  };

  console.log(`Recovered ${channelIds.size} channels, ${totalGifs} entries from NDJSON`);
  await saveProgress(state);
  return state;
}

async function loadProgress(): Promise<ProgressState> {
  try {
    const file = Bun.file(PROGRESS_PATH);
    if (await file.exists()) {
      return await file.json() as ProgressState;
    }
  } catch { /* ignore corrupt file */ }

  // No progress file — check if NDJSON exists and rebuild from it
  return await rebuildProgressFromNdjson();
}

async function saveProgress(state: ProgressState): Promise<void> {
  // Write to temp file then rename for atomicity
  const tmp = PROGRESS_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(state));
  await Bun.write(PROGRESS_PATH, await Bun.file(tmp).text());
  try { await unlink(tmp); } catch {}
}

/** Append GifEntries to NDJSON (one JSON object per line) */
async function appendGifs(entries: GifEntry[]): Promise<void> {
  if (!entries.length) return;
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(NDJSON_PATH, lines);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isGifUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (GIF_EXTENSIONS.some((ext) => lower.includes(ext))) return true;
  if (GIF_DOMAINS.some((domain) => lower.includes(domain))) return true;
  return false;
}

function extractGifs(msg: APIMessage, channelName: string): GifEntry[] {
  const found = new Set<string>();
  const entries: GifEntry[] = [];
  const base = {
    channelId: msg.channel_id,
    channelName,
    messageId: msg.id,
    authorTag: msg.author.username + (msg.author.discriminator !== "0" ? `#${msg.author.discriminator}` : ""),
    timestamp: msg.timestamp,
  };

  // URLs in message content
  for (const url of msg.content?.match(URL_REGEX) ?? []) {
    if (isGifUrl(url) && !found.has(url)) {
      found.add(url);
      entries.push({ ...base, url });
    }
  }

  // Embeds (tenor/giphy/klipy appear as rich embeds)
  for (const embed of msg.embeds ?? []) {
    for (const url of [
      embed.url, embed.thumbnail?.url, embed.thumbnail?.proxy_url,
      embed.video?.url, embed.video?.proxy_url,
      embed.image?.url, embed.image?.proxy_url,
    ].filter(Boolean) as string[]) {
      if (isGifUrl(url) && !found.has(url)) {
        found.add(url);
        entries.push({ ...base, url });
      }
    }
  }

  // Attachments (direct .gif uploads)
  for (const att of msg.attachments ?? []) {
    if (isGifUrl(att.url) && !found.has(att.url)) {
      found.add(att.url);
      entries.push({ ...base, url: att.url });
    }
  }

  return entries;
}

/** Fetch a page of messages with exponential-backoff retry */
async function fetchPage(channelId: string, before?: string): Promise<APIMessage[] | null> {
  const query: Record<string, string> = { limit: "100" };
  if (before) query.before = before;

  const MAX_RETRIES = 8;
  for (let attempt = 0; ; attempt++) {
    try {
      return (await rest.get(Routes.channelMessages(channelId), {
        query: new URLSearchParams(query),
      })) as APIMessage[];
    } catch (err: any) {
      if (err.status === 403 || err.status === 404) return null; // no access
      const isTransient = ["ConnectionRefused", "ECONNRESET", "ETIMEDOUT"].includes(err.code)
        || [429, 500, 502, 503].includes(err.status);
      if (isTransient && attempt < MAX_RETRIES) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 60_000);
        console.log(`  ⟳ Retry ${attempt + 1}/${MAX_RETRIES} in ${(delay / 1000).toFixed(0)}s (${err.code ?? err.status})…`);
        await Bun.sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Scrape a single channel, streaming gifs to NDJSON and saving cursor
 * progress periodically. Can resume mid-channel via the cursor in progress.
 */
async function scrapeChannel(
  channelId: string,
  channelName: string,
  progress: ProgressState,
): Promise<number> {
  // Check if we have a mid-channel cursor to resume from
  let before: string | undefined;
  let page = 0;
  let gifCount = 0;

  if (progress.current?.channelId === channelId && progress.current.lastMessageId) {
    before = progress.current.lastMessageId;
    page = progress.current.pagesScanned;
    gifCount = progress.current.gifCount;
    console.log(`  ↺ Resuming from message ${before} (page ~${page}, ${gifCount} gifs already)`);
  }

  // Set current channel cursor
  progress.current = {
    channelId,
    channelName,
    lastMessageId: before ?? "",
    gifCount,
    pagesScanned: page,
  };

  while (true) {
    const messages = await fetchPage(channelId, before);
    if (messages === null) {
      console.log(`  ⊘ No access to #${channelName} (${channelId}), skipping`);
      return gifCount;
    }
    if (!messages.length) break;

    // Extract gifs and flush to disk immediately
    const batch: GifEntry[] = [];
    for (const msg of messages) {
      batch.push(...extractGifs(msg, channelName));
    }
    if (batch.length) {
      await appendGifs(batch);
    }
    gifCount += batch.length;

    before = messages[messages.length - 1].id;
    page++;

    // Update cursor in progress state
    progress.current.lastMessageId = before;
    progress.current.gifCount = gifCount;
    progress.current.pagesScanned = page;

    // Flush progress to disk periodically
    if (page % PROGRESS_FLUSH_INTERVAL === 0) {
      await saveProgress(progress);
      console.log(`  … #${channelName}: ${page * 100}+ msgs, ${gifCount} gifs [saved]`);
    } else if (page % 10 === 0) {
      console.log(`  … #${channelName}: ${page * 100}+ msgs, ${gifCount} gifs`);
    }
  }

  return gifCount;
}

// ── Markdown generation (streaming read from NDJSON) ────────────────────────

async function generateMarkdown(): Promise<void> {
  const ndjsonFile = Bun.file(NDJSON_PATH);
  if (!(await ndjsonFile.exists())) {
    console.log("No NDJSON file found — nothing to generate.");
    return;
  }

  console.log("Generating markdown from NDJSON…");

  // Stream-read NDJSON, group by channel, dedup by URL
  const byChannel = new Map<string, GifEntry[]>();
  const seen = new Set<string>();
  let total = 0;
  let unique = 0;

  const rl = createInterface({ input: createReadStream(NDJSON_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    total++;
    const entry = JSON.parse(line) as GifEntry;
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    unique++;
    const list = byChannel.get(entry.channelName) ?? [];
    list.push(entry);
    byChannel.set(entry.channelName, list);
  }

  console.log(`Total entries: ${total}, unique URLs: ${unique}`);

  const sortedChannels = [...byChannel.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  let md = `# GIFs scraped from Discord guild ${GUILD_ID}\n\n`;
  md += `> Generated ${new Date().toISOString()}\n`;
  md += `> Total unique GIFs: ${unique}\n\n`;

  for (const [channelName, gifs] of sortedChannels) {
    md += `## #${channelName} (${gifs.length} gifs)\n\n`;
    gifs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    for (const g of gifs) {
      const date = new Date(g.timestamp).toISOString().slice(0, 10);
      md += `- ${g.url}  \n  *${g.authorTag} — ${date}*\n`;
    }
    md += "\n";
  }

  await writeFile(MD_PATH, md);
  console.log(`Written to ${MD_PATH}`);
  byChannel.clear();
  seen.clear();
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // --md-only: skip scraping, just rebuild markdown from existing NDJSON
  if (MD_ONLY) {
    await generateMarkdown();
    return;
  }

  console.log(`Scraping GIFs from guild ${GUILD_ID}…`);
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Load or reset progress
  let progress: ProgressState;
  if (FRESH) {
    console.log("(--fresh: starting from scratch)");
    try { await unlink(NDJSON_PATH); } catch {}
    try { await unlink(PROGRESS_PATH); } catch {}
    progress = { completedChannels: [], totalGifs: 0, current: null };
  } else {
    progress = await loadProgress();
    if (progress.completedChannels.length || progress.current) {
      const resumeInfo = progress.current
        ? `mid-channel ${progress.current.channelName} (page ~${progress.current.pagesScanned})`
        : "between channels";
      console.log(`Resuming: ${progress.completedChannels.length} channels done, ${progress.totalGifs} gifs, ${resumeInfo}`);
    }
  }

  if (CHANNEL_FILTER) console.log(`Filtering to channel: ${CHANNEL_FILTER}`);

  const completedSet = new Set(progress.completedChannels);

  // Get all channels in the guild
  const allChannels = (await rest.get(Routes.guildChannels(GUILD_ID))) as APIChannel[];

  const textTypes = new Set([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
  ]);

  let channels = allChannels.filter((ch: any) => textTypes.has(ch.type));
  if (CHANNEL_FILTER) {
    channels = channels.filter((ch: any) => ch.id === CHANNEL_FILTER);
  }

  console.log(`Found ${channels.length} text channels to scan\n`);

  let totalGifs = progress.totalGifs;

  for (const ch of channels) {
    const name = (ch as any).name ?? ch.id;

    // Skip fully completed channels
    if (completedSet.has(ch.id)) {
      console.log(`Skipping #${name} (${ch.id}) — done`);
      continue;
    }

    // If we have a mid-channel cursor for a DIFFERENT channel, that channel
    // was interrupted — it's already partially in the NDJSON, we just resume it.
    // If the cursor is for THIS channel, scrapeChannel handles the resume.
    // If the cursor is for a different channel that's not yet in completedSet,
    // mark it complete (its partial data is in NDJSON) and move on.
    if (progress.current && progress.current.channelId !== ch.id && !completedSet.has(progress.current.channelId)) {
      // The prior channel was interrupted before completion — skip for now,
      // we'll encounter it in the channel list and resume it properly.
    }

    console.log(`Scanning #${name} (${ch.id})…`);
    const count = await scrapeChannel(ch.id, name, progress);
    if (count) console.log(`  ✓ ${count} gifs`);
    totalGifs += count;

    // Mark channel complete, clear cursor
    progress.completedChannels.push(ch.id);
    progress.totalGifs = totalGifs;
    progress.current = null;
    await saveProgress(progress);
    completedSet.add(ch.id);
  }

  // Scan active threads
  try {
    const activeThreads = (await rest.get(Routes.guildActiveThreads(GUILD_ID))) as { threads: APIChannel[] };
    const threadChannels = activeThreads.threads.filter((t: any) =>
      !CHANNEL_FILTER || t.parent_id === CHANNEL_FILTER || t.id === CHANNEL_FILTER
    );

    if (threadChannels.length) {
      console.log(`\nScanning ${threadChannels.length} active threads…`);
      for (const th of threadChannels) {
        const name = (th as any).name ?? th.id;
        if (completedSet.has(th.id)) {
          console.log(`  Skipping thread ${name} — done`);
          continue;
        }
        console.log(`  Thread: ${name} (${th.id})`);
        const count = await scrapeChannel(th.id, `thread:${name}`, progress);
        if (count) console.log(`    ✓ ${count} gifs`);
        totalGifs += count;
        progress.completedChannels.push(th.id);
        progress.totalGifs = totalGifs;
        progress.current = null;
        await saveProgress(progress);
        completedSet.add(th.id);
      }
    }
  } catch {
    console.log("Could not fetch active threads (may lack permission)");
  }

  console.log(`\n━━━ Done ━━━`);
  console.log(`Total GIF entries: ${totalGifs}`);

  // Generate markdown
  await generateMarkdown();

  // Clean up progress file
  try { await unlink(PROGRESS_PATH); } catch {}
  console.log("Scrape complete, progress file cleaned up.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
