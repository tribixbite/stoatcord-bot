/** Database store using bun:sqlite — channel links, server mappings, migration log */

import { Database } from "bun:sqlite";
import {
  SCHEMA_SQL,
  MIGRATIONS_V2,
  MIGRATIONS_V3,
  MIGRATIONS_V4,
  MIGRATIONS_V5,
  type ServerLinkRow,
  type ChannelLinkRow,
  type RoleLinkRow,
  type ClaimCodeRow,
  type MigrationRequestRow,
  type MigrationLogRow,
  type BridgeMessageRow,
  type ArchiveJobRow,
  type ArchiveMessageRow,
} from "./schema.ts";

const CURRENT_SCHEMA_VERSION = 5;

export class Store {
  private db: Database;

  /** Expose the raw Database instance for shared use (e.g. push store) */
  get database(): Database {
    return this.db;
  }

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    // Create tables (works for fresh databases)
    this.db.exec(SCHEMA_SQL);
    // Run schema migrations for existing databases
    this.runMigrations();
  }

  close(): void {
    this.db.close();
  }

  /** Run incremental migrations, idempotent (ignores "duplicate column" / "already exists" errors) */
  private runMigrations(): void {
    const row = this.db
      .query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1")
      .get();
    const currentVersion = row?.version ?? 0;

    if (currentVersion < 2) {
      this.runMigrationBatch(MIGRATIONS_V2);
    }

    if (currentVersion < 3) {
      this.runMigrationBatch(MIGRATIONS_V3);
    }

    if (currentVersion < 4) {
      this.runMigrationBatch(MIGRATIONS_V4);
    }

    if (currentVersion < 5) {
      this.runMigrationBatch(MIGRATIONS_V5);
    }

    this.db
      .query("INSERT OR REPLACE INTO schema_version (version) VALUES (?)")
      .run(CURRENT_SCHEMA_VERSION);
  }

  /** Execute a batch of migration statements, ignoring safe errors */
  private runMigrationBatch(stmts: string[]): void {
    for (const stmt of stmts) {
      try {
        this.db.run(stmt);
      } catch (err) {
        const msg = String(err);
        // Ignore idempotent errors: duplicate column, table/index already exists
        if (
          msg.includes("duplicate column name") ||
          msg.includes("already exists")
        ) {
          continue;
        }
        console.error(`[db] Migration failed: ${stmt}`, err);
        throw err;
      }
    }
  }

  // --- Server Links ---

  linkServer(
    discordGuildId: string,
    stoatServerId: string,
    authMethod: "new_server" | "claim_code" | "live_approval",
    discordUserId?: string,
    stoatUserId?: string
  ): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO server_links
         (discord_guild_id, stoat_server_id, auth_method, linked_by_discord_user, linked_by_stoat_user)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(discordGuildId, stoatServerId, authMethod, discordUserId ?? null, stoatUserId ?? null);
  }

  getServerLink(discordGuildId: string): ServerLinkRow | null {
    return (
      this.db
        .query<ServerLinkRow, [string]>(
          "SELECT * FROM server_links WHERE discord_guild_id = ?"
        )
        .get(discordGuildId) ?? null
    );
  }

  getStoatServerForGuild(discordGuildId: string): string | null {
    const row = this.getServerLink(discordGuildId);
    return row?.stoat_server_id ?? null;
  }

  /** Check if a Stoat server ID is linked to any Discord guild */
  getGuildForStoatServer(stoatServerId: string): ServerLinkRow | null {
    return (
      this.db
        .query<ServerLinkRow, [string]>(
          "SELECT * FROM server_links WHERE stoat_server_id = ?"
        )
        .get(stoatServerId) ?? null
    );
  }

  // --- Channel Links ---

  linkChannel(
    discordChannelId: string,
    stoatChannelId: string,
    webhookId?: string,
    webhookToken?: string
  ): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO channel_links
         (discord_channel_id, stoat_channel_id, discord_webhook_id, discord_webhook_token)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        discordChannelId,
        stoatChannelId,
        webhookId ?? null,
        webhookToken ?? null
      );
  }

  unlinkChannel(discordChannelId: string): void {
    this.db
      .query("DELETE FROM channel_links WHERE discord_channel_id = ?")
      .run(discordChannelId);
  }

  getChannelByDiscordId(discordChannelId: string): ChannelLinkRow | null {
    return (
      this.db
        .query<ChannelLinkRow, [string]>(
          "SELECT * FROM channel_links WHERE discord_channel_id = ? AND active = 1"
        )
        .get(discordChannelId) ?? null
    );
  }

  getChannelByStoatId(stoatChannelId: string): ChannelLinkRow | null {
    return (
      this.db
        .query<ChannelLinkRow, [string]>(
          "SELECT * FROM channel_links WHERE stoat_channel_id = ? AND active = 1"
        )
        .get(stoatChannelId) ?? null
    );
  }

  getAllActiveChannelLinks(): ChannelLinkRow[] {
    return this.db
      .query<ChannelLinkRow, []>("SELECT * FROM channel_links WHERE active = 1")
      .all();
  }

  setWebhook(
    discordChannelId: string,
    webhookId: string,
    webhookToken: string
  ): void {
    this.db
      .query(
        "UPDATE channel_links SET discord_webhook_id = ?, discord_webhook_token = ? WHERE discord_channel_id = ?"
      )
      .run(webhookId, webhookToken, discordChannelId);
  }

  // --- Role Links ---

  linkRole(
    discordRoleId: string,
    stoatRoleId: string,
    guildId: string
  ): void {
    this.db
      .query(
        "INSERT OR REPLACE INTO role_links (discord_role_id, stoat_role_id, server_link_guild_id) VALUES (?, ?, ?)"
      )
      .run(discordRoleId, stoatRoleId, guildId);
  }

  getRoleByDiscordId(discordRoleId: string): RoleLinkRow | null {
    return (
      this.db
        .query<RoleLinkRow, [string]>(
          "SELECT * FROM role_links WHERE discord_role_id = ?"
        )
        .get(discordRoleId) ?? null
    );
  }

  getRolesForGuild(guildId: string): RoleLinkRow[] {
    return this.db
      .query<RoleLinkRow, [string]>(
        "SELECT * FROM role_links WHERE server_link_guild_id = ?"
      )
      .all(guildId);
  }

  // --- Claim Codes ---

  /** Generate a one-time claim code for linking a Stoat server to a Discord guild */
  createClaimCode(
    stoatServerId: string,
    createdByUser?: string,
    createdInChannel?: string
  ): string {
    const code = generateCode();
    this.db
      .query(
        `INSERT INTO claim_codes (stoat_server_id, code, created_by_stoat_user, created_in_channel)
         VALUES (?, ?, ?, ?)`
      )
      .run(stoatServerId, code, createdByUser ?? null, createdInChannel ?? null);
    return code;
  }

  /** Validate and consume a claim code. Returns the Stoat server ID if valid. */
  consumeClaimCode(
    code: string,
    guildId: string,
    discordUserId: string
  ): string | null {
    const row = this.db
      .query<ClaimCodeRow, [string]>(
        "SELECT * FROM claim_codes WHERE code = ? AND used_by_guild IS NULL"
      )
      .get(code);
    if (!row) return null;

    // Expire codes older than 1 hour
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    if (row.created_at < oneHourAgo) {
      this.db.query("DELETE FROM claim_codes WHERE code = ?").run(code);
      return null;
    }

    // Mark as used (atomic — only one caller can succeed via WHERE used_by_guild IS NULL)
    const result = this.db
      .query(
        "UPDATE claim_codes SET used_by_guild = ?, used_by_discord_user = ?, used_at = unixepoch() WHERE code = ? AND used_by_guild IS NULL"
      )
      .run(guildId, discordUserId, code);

    // If no rows updated, another caller consumed it between our SELECT and UPDATE
    if ((result as { changes: number }).changes === 0) return null;

    return row.stoat_server_id;
  }

  /** Look up a claim code without consuming it */
  getClaimCode(code: string): ClaimCodeRow | null {
    return (
      this.db
        .query<ClaimCodeRow, [string]>("SELECT * FROM claim_codes WHERE code = ?")
        .get(code) ?? null
    );
  }

  /** Clean up expired claim codes (older than 1 hour) */
  cleanExpiredCodes(): void {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    this.db
      .query("DELETE FROM claim_codes WHERE created_at < ? AND used_by_guild IS NULL")
      .run(oneHourAgo);
  }

  // --- Migration Requests (live approval flow) ---

  createMigrationRequest(req: {
    id: string;
    discordGuildId: string;
    discordGuildName: string;
    discordUserId: string;
    discordUserName: string;
    stoatServerId: string;
    stoatChannelId: string;
    expiresAt: number;
  }): void {
    this.db
      .query(
        `INSERT INTO migration_requests
         (id, discord_guild_id, discord_guild_name, discord_user_id, discord_user_name,
          stoat_server_id, stoat_channel_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.id,
        req.discordGuildId,
        req.discordGuildName,
        req.discordUserId,
        req.discordUserName,
        req.stoatServerId,
        req.stoatChannelId,
        req.expiresAt
      );
  }

  /** Store the Stoat message ID after the approval message is sent */
  setMigrationRequestMessageId(requestId: string, stoatMessageId: string): void {
    this.db
      .query("UPDATE migration_requests SET stoat_message_id = ? WHERE id = ?")
      .run(stoatMessageId, requestId);
  }

  /** Look up a pending request by the Stoat message ID it's replying to */
  getMigrationRequestByMessageId(stoatMessageId: string): MigrationRequestRow | null {
    return (
      this.db
        .query<MigrationRequestRow, [string]>(
          "SELECT * FROM migration_requests WHERE stoat_message_id = ? AND status = 'pending'"
        )
        .get(stoatMessageId) ?? null
    );
  }

  /** Get any pending request for a given Stoat server */
  getPendingRequestForServer(stoatServerId: string): MigrationRequestRow | null {
    return (
      this.db
        .query<MigrationRequestRow, [string]>(
          "SELECT * FROM migration_requests WHERE stoat_server_id = ? AND status = 'pending'"
        )
        .get(stoatServerId) ?? null
    );
  }

  /** Resolve a migration request (approve, reject, expire, cancel) */
  resolveMigrationRequest(
    requestId: string,
    status: "approved" | "rejected" | "expired" | "cancelled",
    approvedByUser?: string
  ): void {
    this.db
      .query(
        "UPDATE migration_requests SET status = ?, approved_by_stoat_user = ?, resolved_at = unixepoch() WHERE id = ?"
      )
      .run(status, approvedByUser ?? null, requestId);
  }

  /** Mark all stale pending requests as expired. Returns count cleaned. */
  cleanExpiredRequests(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .query(
        "UPDATE migration_requests SET status = 'expired', resolved_at = unixepoch() WHERE status = 'pending' AND expires_at < ?"
      )
      .run(now);
    return (result as { changes: number }).changes ?? 0;
  }

  // --- Migration Log ---

  logMigration(
    guildId: string,
    action: string,
    discordId: string | null,
    stoatId: string | null,
    status: "success" | "error" | "skipped",
    errorMessage?: string,
    discordUserId?: string,
    stoatUserId?: string
  ): void {
    this.db
      .query(
        `INSERT INTO migration_log
         (guild_id, action, discord_id, stoat_id, status, error_message, discord_user_id, stoat_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        guildId, action, discordId, stoatId, status,
        errorMessage ?? null, discordUserId ?? null, stoatUserId ?? null
      );
  }

  getMigrationLog(guildId: string): MigrationLogRow[] {
    return this.db
      .query<MigrationLogRow, [string]>(
        "SELECT * FROM migration_log WHERE guild_id = ? ORDER BY created_at DESC"
      )
      .all(guildId);
  }

  /** Update last-bridged message IDs for outage recovery tracking */
  updateLastBridged(
    discordChannelId: string,
    discordMessageId: string,
    stoatMessageId: string
  ): void {
    this.db
      .query(
        `UPDATE channel_links
         SET last_bridged_discord_id = ?, last_bridged_stoat_id = ?, last_bridged_at = unixepoch()
         WHERE discord_channel_id = ?`
      )
      .run(discordMessageId, stoatMessageId, discordChannelId);
  }

  // --- Bridge Messages ---

  /** Store a bridged message ID pair for edit/delete/reaction sync */
  storeBridgeMessage(
    discordMessageId: string,
    stoatMessageId: string,
    discordChannelId: string,
    stoatChannelId: string,
    direction: "d2s" | "s2d"
  ): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO bridge_messages
         (discord_message_id, stoat_message_id, discord_channel_id, stoat_channel_id, direction)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(discordMessageId, stoatMessageId, discordChannelId, stoatChannelId, direction);
  }

  /** Look up a bridged message by its Discord message ID */
  getBridgeMessageByDiscordId(discordMessageId: string): BridgeMessageRow | null {
    return (
      this.db
        .query<BridgeMessageRow, [string]>(
          "SELECT * FROM bridge_messages WHERE discord_message_id = ?"
        )
        .get(discordMessageId) ?? null
    );
  }

  /** Look up a bridged message by its Stoat message ID */
  getBridgeMessageByStoatId(stoatMessageId: string): BridgeMessageRow | null {
    return (
      this.db
        .query<BridgeMessageRow, [string]>(
          "SELECT * FROM bridge_messages WHERE stoat_message_id = ?"
        )
        .get(stoatMessageId) ?? null
    );
  }

  /** Remove a bridge message mapping (after deletion) */
  deleteBridgeMessage(discordMessageId: string): void {
    this.db
      .query("DELETE FROM bridge_messages WHERE discord_message_id = ?")
      .run(discordMessageId);
  }

  /** Remove a bridge message mapping by Stoat ID */
  deleteBridgeMessageByStoatId(stoatMessageId: string): void {
    this.db
      .query("DELETE FROM bridge_messages WHERE stoat_message_id = ?")
      .run(stoatMessageId);
  }

  /** Clean up old bridge message mappings (default: older than 30 days) */
  cleanOldBridgeMessages(maxAgeDays = 30): number {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86_400;
    const result = this.db
      .query("DELETE FROM bridge_messages WHERE created_at < ?")
      .run(cutoff);
    return (result as { changes: number }).changes ?? 0;
  }

  // --- Status / Stats ---

  getLinkedChannelCount(): number {
    const row = this.db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) as count FROM channel_links WHERE active = 1"
      )
      .get();
    return row?.count ?? 0;
  }

  getLinkedServerCount(): number {
    const row = this.db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) as count FROM server_links"
      )
      .get();
    return row?.count ?? 0;
  }

  // --- Archive Jobs ---

  /** Create a new archive job. Auto-generates an ID if not provided. Returns the job ID. */
  createArchiveJob(job: {
    id?: string;
    guildId: string;
    discordChannelId: string;
    discordChannelName?: string;
    stoatChannelId?: string;
    direction: "export" | "import";
  }): string {
    const id = job.id ?? crypto.randomUUID().slice(0, 8);
    this.db
      .query(
        `INSERT INTO archive_jobs (id, guild_id, discord_channel_id, discord_channel_name, stoat_channel_id, direction)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, job.guildId, job.discordChannelId,
        job.discordChannelName ?? null, job.stoatChannelId ?? null, job.direction
      );
    return id;
  }

  getArchiveJob(jobId: string): ArchiveJobRow | null {
    return (
      this.db
        .query<ArchiveJobRow, [string]>("SELECT * FROM archive_jobs WHERE id = ?")
        .get(jobId) ?? null
    );
  }

  /** Get all jobs for a guild, most recent first */
  getArchiveJobsForGuild(guildId: string): ArchiveJobRow[] {
    return this.db
      .query<ArchiveJobRow, [string]>(
        "SELECT * FROM archive_jobs WHERE guild_id = ? ORDER BY created_at DESC"
      )
      .all(guildId);
  }

  /** Get the active (running/pending) export job for a channel, if any */
  getActiveExportJob(discordChannelId: string): ArchiveJobRow | null {
    return (
      this.db
        .query<ArchiveJobRow, [string]>(
          "SELECT * FROM archive_jobs WHERE discord_channel_id = ? AND direction = 'export' AND status IN ('pending', 'running', 'paused') LIMIT 1"
        )
        .get(discordChannelId) ?? null
    );
  }

  updateArchiveJobStatus(
    jobId: string,
    status: "running" | "paused" | "completed" | "failed",
    extra?: { error?: string; totalMessages?: number; processedMessages?: number; lastMessageId?: string }
  ): void {
    const sets: string[] = ["status = ?"];
    const params: (string | number | null)[] = [status];

    if (status === "running") {
      sets.push("started_at = COALESCE(started_at, unixepoch())");
    }
    if (status === "completed" || status === "failed") {
      sets.push("completed_at = unixepoch()");
    }
    if (extra?.error !== undefined) {
      sets.push("error = ?");
      params.push(extra.error);
    }
    if (extra?.totalMessages !== undefined) {
      sets.push("total_messages = ?");
      params.push(extra.totalMessages);
    }
    if (extra?.processedMessages !== undefined) {
      sets.push("processed_messages = ?");
      params.push(extra.processedMessages);
    }
    if (extra?.lastMessageId !== undefined) {
      sets.push("last_message_id = ?");
      params.push(extra.lastMessageId);
    }

    params.push(jobId);
    this.db.query(`UPDATE archive_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  // --- Archive Messages ---

  /** Store a batch of exported Discord messages. Uses INSERT OR IGNORE for idempotent resumes. */
  storeArchiveMessages(
    messages: Array<{
      jobId: string;
      discordMessageId: string;
      discordChannelId: string;
      authorId: string;
      authorName: string;
      authorAvatarUrl?: string;
      content?: string;
      timestamp: string;
      editedTimestamp?: string;
      replyToId?: string;
      attachmentsJson?: string;
      embedsJson?: string;
    }>
  ): number {
    const stmt = this.db.query(
      `INSERT OR IGNORE INTO archive_messages
       (job_id, discord_message_id, discord_channel_id, author_id, author_name, author_avatar_url,
        content, timestamp, edited_timestamp, reply_to_id, attachments_json, embeds_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let inserted = 0;
    const tx = this.db.transaction(() => {
      for (const m of messages) {
        const result = stmt.run(
          m.jobId, m.discordMessageId, m.discordChannelId, m.authorId, m.authorName,
          m.authorAvatarUrl ?? null, m.content ?? null, m.timestamp,
          m.editedTimestamp ?? null, m.replyToId ?? null,
          m.attachmentsJson ?? null, m.embedsJson ?? null
        );
        inserted += (result as { changes: number }).changes;
      }
    });
    tx();
    return inserted;
  }

  /** Get un-imported archive messages for a job, ordered by timestamp (oldest first) */
  getUnimportedMessages(jobId: string, limit = 50): ArchiveMessageRow[] {
    return this.db
      .query<ArchiveMessageRow, [string, number]>(
        "SELECT * FROM archive_messages WHERE job_id = ? AND stoat_message_id IS NULL ORDER BY timestamp ASC LIMIT ?"
      )
      .all(jobId, limit);
  }

  /** Mark an archive message as imported */
  markArchiveMessageImported(id: number, stoatMessageId: string): void {
    this.db
      .query("UPDATE archive_messages SET stoat_message_id = ?, imported_at = unixepoch() WHERE id = ?")
      .run(stoatMessageId, id);
  }

  /** Look up the Stoat message ID for an imported archive message by its Discord ID */
  getImportedStoatId(jobId: string, discordMessageId: string): string | null {
    const row = this.db
      .query<{ stoat_message_id: string | null }, [string, string]>(
        "SELECT stoat_message_id FROM archive_messages WHERE job_id = ? AND discord_message_id = ? LIMIT 1"
      )
      .get(jobId, discordMessageId);
    return row?.stoat_message_id ?? null;
  }

  /** Count total and imported messages for a job */
  getArchiveMessageCounts(jobId: string): { total: number; imported: number } {
    const total = this.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM archive_messages WHERE job_id = ?"
      )
      .get(jobId)?.count ?? 0;
    const imported = this.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM archive_messages WHERE job_id = ? AND stoat_message_id IS NOT NULL"
      )
      .get(jobId)?.count ?? 0;
    return { total, imported };
  }
}

/** Generate a 6-char alphanumeric claim code using crypto-secure randomness */
function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
  const randomBytes = new Uint8Array(6);
  crypto.getRandomValues(randomBytes);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[randomBytes[i]! % chars.length];
  }
  return code;
}
