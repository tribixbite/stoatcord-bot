/** Database store using bun:sqlite — channel links, server mappings, migration log */

import { Database } from "bun:sqlite";
import {
  SCHEMA_SQL,
  MIGRATIONS_V2,
  type ServerLinkRow,
  type ChannelLinkRow,
  type RoleLinkRow,
  type ClaimCodeRow,
  type MigrationRequestRow,
  type MigrationLogRow,
} from "./schema.ts";

const CURRENT_SCHEMA_VERSION = 2;

export class Store {
  private db: Database;

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

  /** Run incremental ALTER TABLE migrations, idempotent (ignores "duplicate column" errors) */
  private runMigrations(): void {
    const row = this.db
      .query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1")
      .get();
    const currentVersion = row?.version ?? 0;

    if (currentVersion < 2) {
      for (const stmt of MIGRATIONS_V2) {
        try {
          this.db.run(stmt);
        } catch {
          // Expected: "duplicate column name" if column already exists
        }
      }
    }

    this.db
      .query("INSERT OR REPLACE INTO schema_version (version) VALUES (?)")
      .run(CURRENT_SCHEMA_VERSION);
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

    // Mark as used (atomic — only one caller can succeed)
    this.db
      .query(
        "UPDATE claim_codes SET used_by_guild = ?, used_by_discord_user = ?, used_at = unixepoch() WHERE code = ? AND used_by_guild IS NULL"
      )
      .run(guildId, discordUserId, code);
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
}

/** Generate a 6-char alphanumeric claim code (uppercase for readability) */
function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
