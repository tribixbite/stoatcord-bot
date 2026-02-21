#!/usr/bin/env bun
/**
 * Standalone GIF scraper for a Discord guild.
 * Pulls all GIF URLs (tenor, giphy, klipy, gfycat, imgur, etc.)
 * from every accessible text channel and streams them to NDJSON on disk.
 * Final markdown is generated from the NDJSON at the end.
 *
 * Memory-safe: entries are flushed to disk per-channel, never held in bulk.
 *
 * Usage: bun scrape-gifs.ts [--dry-run] [--channel <id>] [--resume]
 */

import { REST, Routes, type APIMessage, type APIChannel, ChannelType } from "discord.js";
import { resolve } from "path";
import { mkdir, appendFile, unlink, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// ── Config ──────────────────────────────────────────────────────────────────

// import.meta.dir is the directory of this script (project root for root-level scripts)
const PROJECT_ROOT = import.meta.dir;
const GUILD_ID = "793967107116236841";
const OUTPUT_DIR = resolve(PROJECT_ROOT, "output");
const NDJSON_PATH = resolve(OUTPUT_DIR, "gifs.ndjson");    // streaming append target
const MD_PATH = resolve(OUTPUT_DIR, "gifs.md");            // final markdown output
const PROGRESS_PATH = resolve(OUTPUT_DIR, "gifs-progress.json"); // lightweight: just channel IDs + counts

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
  "imgur.com",  // imgur gif links (direct and album)
  "i.imgur.com",
];

/** File extensions that are GIFs */
const GIF_EXTENSIONS = [".gif", ".gifv"];

/** URL regex (loose — we filter by domain after) */
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RESUME = args.includes("--resume");
const channelFlagIdx = args.indexOf("--channel");
const CHANNEL_FILTER = channelFlagIdx !== -1 ? args[channelFlagIdx + 1] : null;

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

/** Lightweight progress — no gif data, just completed channel IDs */
interface ProgressState {
  completedChannels: string[];
  totalGifs: number;
}

// ── Progress management (lightweight — no gif data in memory) ───────────────

async function loadProgress(): Promise<ProgressState> {
  try {
    const file = Bun.file(PROGRESS_PATH);
    if (await file.exists()) {
      return await file.json() as ProgressState;
    }
  } catch { /* ignore corrupt file */ }
  return { completedChannels: [], totalGifs: 0 };
}

async function saveProgress(state: ProgressState): Promise<void> {
  await writeFile(PROGRESS_PATH, JSON.stringify(state));
}

/** Append an array of GifEntry to the NDJSON file (one JSON object per line) */
async function appendGifs(entries: GifEntry[]): Promise<void> {
  if (!entries.length) return;
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(NDJSON_PATH, lines);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Check whether a URL looks like a GIF */
function isGifUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (GIF_EXTENSIONS.some((ext) => lower.includes(ext))) return true;
  if (GIF_DOMAINS.some((domain) => lower.includes(domain))) return true;
  return false;
}

/** Extract all GIF URLs from a single message */
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

  // 1. URLs in message content
  const contentUrls = msg.content?.match(URL_REGEX) ?? [];
  for (const url of contentUrls) {
    if (isGifUrl(url) && !found.has(url)) {
      found.add(url);
      entries.push({ ...base, url });
    }
  }

  // 2. Embeds (tenor/giphy/klipy show up as rich embeds with video or image)
  for (const embed of msg.embeds ?? []) {
    const candidates = [
      embed.url,
      embed.thumbnail?.url,
      embed.thumbnail?.proxy_url,
      embed.video?.url,
      embed.video?.proxy_url,
      embed.image?.url,
      embed.image?.proxy_url,
    ].filter(Boolean) as string[];

    for (const url of candidates) {
      if (isGifUrl(url) && !found.has(url)) {
        found.add(url);
        entries.push({ ...base, url });
      }
    }
  }

  // 3. Attachments (direct .gif uploads)
  for (const att of msg.attachments ?? []) {
    if (isGifUrl(att.url) && !found.has(att.url)) {
      found.add(att.url);
      entries.push({ ...base, url: att.url });
    }
  }

  return entries;
}

/**
 * Fetch all messages from a channel, streaming GIF entries to disk.
 * Returns the count of gifs found (entries are NOT held in memory).
 */
async function fetchAndStreamChannel(channelId: string, channelName: string): Promise<number> {
  let before: string | undefined;
  let page = 0;
  let gifCount = 0;

  while (true) {
    const query: Record<string, string> = { limit: "100" };
    if (before) query.before = before;

    let messages: APIMessage[];
    const MAX_RETRIES = 5;
    let attempt = 0;
    while (true) {
      try {
        messages = (await rest.get(Routes.channelMessages(channelId), {
          query: new URLSearchParams(query),
        })) as APIMessage[];
        break;
      } catch (err: any) {
        if (err.status === 403 || err.status === 404) {
          console.log(`  ⊘ No access to #${channelName} (${channelId}), skipping`);
          return gifCount;
        }
        const isTransient = err.code === "ConnectionRefused"
          || err.code === "ECONNRESET"
          || err.code === "ETIMEDOUT"
          || err.status === 429
          || err.status === 500
          || err.status === 502
          || err.status === 503;
        if (isTransient && attempt < MAX_RETRIES) {
          attempt++;
          const delay = Math.min(2000 * Math.pow(2, attempt), 60_000);
          console.log(`  ⟳ Retry ${attempt}/${MAX_RETRIES} in ${(delay / 1000).toFixed(0)}s (${err.code ?? err.status})…`);
          await Bun.sleep(delay);
          continue;
        }
        throw err;
      }
    }

    if (!messages.length) break;

    // Extract gifs from this batch and flush to disk immediately
    const batch: GifEntry[] = [];
    for (const msg of messages) {
      batch.push(...extractGifs(msg, channelName));
    }
    if (batch.length && !DRY_RUN) {
      await appendGifs(batch);
    }
    gifCount += batch.length;

    before = messages[messages.length - 1].id;
    page++;

    if (page % 10 === 0) {
      console.log(`  … #${channelName}: ${page * 100}+ messages scanned, ${gifCount} gifs so far`);
    }
  }

  return gifCount;
}

// ── Markdown generation (streaming read from NDJSON) ────────────────────────

/** Read the NDJSON file line-by-line and produce the final markdown */
async function generateMarkdown(): Promise<void> {
  console.log("\nGenerating markdown from NDJSON…");

  // First pass: group URLs by channel, dedup by URL
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

  console.log(`Total GIF entries: ${total}, unique URLs: ${unique}`);

  // Build markdown in chunks to avoid huge string concat
  const sortedChannels = [...byChannel.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Write header
  let md = `# GIFs scraped from Discord guild ${GUILD_ID}\n\n`;
  md += `> Generated ${new Date().toISOString()}\n`;
  md += `> Total unique GIFs: ${unique}\n\n`;

  // Write channel sections
  for (const [channelName, gifs] of sortedChannels) {
    md += `## #${channelName} (${gifs.length} gifs)\n\n`;
    gifs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    for (const g of gifs) {
      const date = new Date(g.timestamp).toISOString().slice(0, 10);
      md += `- ${g.url}  \n`;
      md += `  *${g.authorTag} — ${date}*\n`;
    }
    md += "\n";
  }

  await writeFile(MD_PATH, md);
  console.log(`Written to ${MD_PATH}`);

  // Free the map
  byChannel.clear();
  seen.clear();
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Scraping GIFs from guild ${GUILD_ID}…`);
  if (DRY_RUN) console.log("(dry-run mode — no files will be written)");
  if (RESUME) console.log("(resume mode — skipping already-scraped channels)");
  if (CHANNEL_FILTER) console.log(`Filtering to channel: ${CHANNEL_FILTER}`);

  await mkdir(OUTPUT_DIR, { recursive: true });

  // Load prior progress if resuming
  const progress = RESUME ? await loadProgress() : { completedChannels: [], totalGifs: 0 };
  const completedSet = new Set(progress.completedChannels);

  // If not resuming, clear any prior NDJSON
  if (!RESUME) {
    try { await unlink(NDJSON_PATH); } catch { /* didn't exist */ }
  }

  if (RESUME && completedSet.size) {
    console.log(`Resuming: ${completedSet.size} channels done, ${progress.totalGifs} gifs on disk`);
  }

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
    if (completedSet.has(ch.id)) {
      console.log(`Skipping #${name} (${ch.id}) — already scraped`);
      continue;
    }
    console.log(`Scanning #${name} (${ch.id})…`);
    const count = await fetchAndStreamChannel(ch.id, name);
    if (count) console.log(`  ✓ ${count} gifs found`);
    totalGifs += count;

    // Save lightweight progress (just channel ID + running total)
    progress.completedChannels.push(ch.id);
    progress.totalGifs = totalGifs;
    if (!DRY_RUN) await saveProgress(progress);
  }

  // Also scan active threads
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
          console.log(`  Skipping thread ${name} — already scraped`);
          continue;
        }
        console.log(`  Thread: ${name} (${th.id})`);
        const count = await fetchAndStreamChannel(th.id, `thread:${name}`);
        if (count) console.log(`    ✓ ${count} gifs found`);
        totalGifs += count;
        progress.completedChannels.push(th.id);
        progress.totalGifs = totalGifs;
        if (!DRY_RUN) await saveProgress(progress);
      }
    }
  } catch {
    console.log("Could not fetch active threads (may lack permission)");
  }

  console.log(`\n━━━ Results ━━━`);
  console.log(`Total GIF entries written: ${totalGifs}`);

  if (DRY_RUN) return;

  // Generate final markdown from the NDJSON (streaming read, no bulk memory)
  await generateMarkdown();

  // Clean up progress file on success
  try { await unlink(PROGRESS_PATH); } catch {}
  console.log("Progress file cleaned up (scrape complete)");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
