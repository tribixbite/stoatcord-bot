/** SQLite schema definitions for stoatcord-bot */

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS server_links (
    discord_guild_id TEXT PRIMARY KEY,
    stoat_server_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS channel_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_channel_id TEXT NOT NULL UNIQUE,
    stoat_channel_id TEXT NOT NULL UNIQUE,
    discord_webhook_id TEXT,
    discord_webhook_token TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS role_links (
    discord_role_id TEXT PRIMARY KEY,
    stoat_role_id TEXT NOT NULL,
    server_link_guild_id TEXT NOT NULL REFERENCES server_links(discord_guild_id)
  );

  CREATE TABLE IF NOT EXISTS claim_codes (
    stoat_server_id TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    used_by_guild TEXT,
    used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS migration_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    action TEXT NOT NULL,
    discord_id TEXT,
    stoat_id TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

// Row types for query results
export interface ServerLinkRow {
  discord_guild_id: string;
  stoat_server_id: string;
  created_at: number;
}

export interface ChannelLinkRow {
  id: number;
  discord_channel_id: string;
  stoat_channel_id: string;
  discord_webhook_id: string | null;
  discord_webhook_token: string | null;
  active: number;
  created_at: number;
}

export interface RoleLinkRow {
  discord_role_id: string;
  stoat_role_id: string;
  server_link_guild_id: string;
}

export interface ClaimCodeRow {
  stoat_server_id: string;
  code: string;
  created_at: number;
  used_by_guild: string | null;
  used_at: number | null;
}

export interface MigrationLogRow {
  id: number;
  guild_id: string;
  action: string;
  discord_id: string | null;
  stoat_id: string | null;
  status: string;
  error_message: string | null;
  created_at: number;
}
