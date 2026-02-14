/** Database store using bun:sqlite — channel links, server mappings, migration log */

import { Database } from "bun:sqlite";
import {
  SCHEMA_SQL,
  type ServerLinkRow,
  type ChannelLinkRow,
  type RoleLinkRow,
  type MigrationLogRow,
} from "./schema.ts";

export class Store {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    // Create tables
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // --- Server Links ---

  linkServer(discordGuildId: string, stoatServerId: string): void {
    this.db
      .query(
        "INSERT OR REPLACE INTO server_links (discord_guild_id, stoat_server_id) VALUES (?, ?)"
      )
      .run(discordGuildId, stoatServerId);
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

  // --- Migration Log ---

  logMigration(
    guildId: string,
    action: string,
    discordId: string | null,
    stoatId: string | null,
    status: "success" | "error" | "skipped",
    errorMessage?: string
  ): void {
    this.db
      .query(
        `INSERT INTO migration_log (guild_id, action, discord_id, stoat_id, status, error_message)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(guildId, action, discordId, stoatId, status, errorMessage ?? null);
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
