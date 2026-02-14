/** SQLite schema definitions for stoatcord-bot */

/** Base schema — creates all tables if they don't exist (fresh DB) */
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS server_links (
    discord_guild_id TEXT PRIMARY KEY,
    stoat_server_id TEXT NOT NULL,
    linked_by_discord_user TEXT,
    linked_by_stoat_user TEXT,
    auth_method TEXT,
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
    created_by_stoat_user TEXT,
    created_in_channel TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    used_by_guild TEXT,
    used_by_discord_user TEXT,
    used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS migration_requests (
    id TEXT PRIMARY KEY,
    discord_guild_id TEXT NOT NULL,
    discord_guild_name TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    discord_user_name TEXT NOT NULL,
    stoat_server_id TEXT NOT NULL,
    stoat_channel_id TEXT NOT NULL,
    stoat_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    approved_by_stoat_user TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    resolved_at INTEGER,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS migration_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    action TEXT NOT NULL,
    discord_id TEXT,
    stoat_id TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    discord_user_id TEXT,
    stoat_user_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

/**
 * Schema migrations for existing databases.
 * Each statement is run in a try/catch — "duplicate column" errors are expected and ignored.
 */
export const MIGRATIONS_V2: string[] = [
  // server_links: add user tracking
  "ALTER TABLE server_links ADD COLUMN linked_by_discord_user TEXT",
  "ALTER TABLE server_links ADD COLUMN linked_by_stoat_user TEXT",
  "ALTER TABLE server_links ADD COLUMN auth_method TEXT",
  // claim_codes: add who generated and who consumed
  "ALTER TABLE claim_codes ADD COLUMN created_by_stoat_user TEXT",
  "ALTER TABLE claim_codes ADD COLUMN created_in_channel TEXT",
  "ALTER TABLE claim_codes ADD COLUMN used_by_discord_user TEXT",
  // migration_log: add user tracking
  "ALTER TABLE migration_log ADD COLUMN discord_user_id TEXT",
  "ALTER TABLE migration_log ADD COLUMN stoat_user_id TEXT",
];

// Row types for query results

export interface ServerLinkRow {
  discord_guild_id: string;
  stoat_server_id: string;
  linked_by_discord_user: string | null;
  linked_by_stoat_user: string | null;
  auth_method: string | null;
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
  created_by_stoat_user: string | null;
  created_in_channel: string | null;
  created_at: number;
  used_by_guild: string | null;
  used_by_discord_user: string | null;
  used_at: number | null;
}

export interface MigrationRequestRow {
  id: string;
  discord_guild_id: string;
  discord_guild_name: string;
  discord_user_id: string;
  discord_user_name: string;
  stoat_server_id: string;
  stoat_channel_id: string;
  stoat_message_id: string | null;
  status: string;
  approved_by_stoat_user: string | null;
  created_at: number;
  resolved_at: number | null;
  expires_at: number;
}

export interface MigrationLogRow {
  id: number;
  guild_id: string;
  action: string;
  discord_id: string | null;
  stoat_id: string | null;
  status: string;
  error_message: string | null;
  discord_user_id: string | null;
  stoat_user_id: string | null;
  created_at: number;
}
