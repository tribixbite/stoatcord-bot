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
    last_bridged_discord_id TEXT,
    last_bridged_stoat_id TEXT,
    last_bridged_at INTEGER,
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

  CREATE TABLE IF NOT EXISTS bridge_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_message_id TEXT NOT NULL,
    stoat_message_id TEXT NOT NULL,
    discord_channel_id TEXT NOT NULL,
    stoat_channel_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_discord ON bridge_messages(discord_message_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_stoat ON bridge_messages(stoat_message_id);
  CREATE INDEX IF NOT EXISTS idx_bridge_created ON bridge_messages(created_at);

  CREATE TABLE IF NOT EXISTS archive_jobs (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    discord_channel_id TEXT NOT NULL,
    discord_channel_name TEXT,
    stoat_channel_id TEXT,
    direction TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    total_messages INTEGER DEFAULT 0,
    processed_messages INTEGER DEFAULT 0,
    last_message_id TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS archive_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES archive_jobs(id),
    discord_message_id TEXT NOT NULL,
    discord_channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_avatar_url TEXT,
    content TEXT,
    timestamp TEXT NOT NULL,
    edited_timestamp TEXT,
    reply_to_id TEXT,
    attachments_json TEXT,
    embeds_json TEXT,
    stoat_message_id TEXT,
    imported_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_archive_msgs_job ON archive_messages(job_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_msgs_unique ON archive_messages(job_id, discord_message_id);
`;

/**
 * Schema migrations for existing databases.
 * Each statement is run in a try/catch — "duplicate column" errors are expected and ignored.
 */
/**
 * V3 migration: add bridge_messages table for edit/delete/reaction sync.
 * Uses CREATE TABLE IF NOT EXISTS so it's idempotent on fresh DBs.
 */
/**
 * V5 migration: archive system tables for Discord message history export/import.
 */
export const MIGRATIONS_V5: string[] = [
  `CREATE TABLE IF NOT EXISTS archive_jobs (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    discord_channel_id TEXT NOT NULL,
    discord_channel_name TEXT,
    stoat_channel_id TEXT,
    direction TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    total_messages INTEGER DEFAULT 0,
    processed_messages INTEGER DEFAULT 0,
    last_message_id TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS archive_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES archive_jobs(id),
    discord_message_id TEXT NOT NULL,
    discord_channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_avatar_url TEXT,
    content TEXT,
    timestamp TEXT NOT NULL,
    edited_timestamp TEXT,
    reply_to_id TEXT,
    attachments_json TEXT,
    embeds_json TEXT,
    stoat_message_id TEXT,
    imported_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_archive_msgs_job ON archive_messages(job_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_msgs_unique ON archive_messages(job_id, discord_message_id)`,
];

/**
 * V4 migration: add outage recovery tracking to channel_links.
 */
export const MIGRATIONS_V4: string[] = [
  "ALTER TABLE channel_links ADD COLUMN last_bridged_discord_id TEXT",
  "ALTER TABLE channel_links ADD COLUMN last_bridged_stoat_id TEXT",
  "ALTER TABLE channel_links ADD COLUMN last_bridged_at INTEGER",
];

export const MIGRATIONS_V3: string[] = [
  `CREATE TABLE IF NOT EXISTS bridge_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_message_id TEXT NOT NULL,
    stoat_message_id TEXT NOT NULL,
    discord_channel_id TEXT NOT NULL,
    stoat_channel_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_discord ON bridge_messages(discord_message_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_stoat ON bridge_messages(stoat_message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bridge_created ON bridge_messages(created_at)`,
];

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
  last_bridged_discord_id: string | null;
  last_bridged_stoat_id: string | null;
  last_bridged_at: number | null;
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

export interface BridgeMessageRow {
  id: number;
  discord_message_id: string;
  stoat_message_id: string;
  discord_channel_id: string;
  stoat_channel_id: string;
  /** "d2s" = Discord-to-Stoat, "s2d" = Stoat-to-Discord */
  direction: "d2s" | "s2d";
  created_at: number;
}

export interface ArchiveJobRow {
  id: string;
  guild_id: string;
  discord_channel_id: string;
  discord_channel_name: string | null;
  stoat_channel_id: string | null;
  direction: "export" | "import";
  status: "pending" | "running" | "paused" | "completed" | "failed";
  total_messages: number;
  processed_messages: number;
  last_message_id: string | null;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  created_at: number;
}

export interface ArchiveMessageRow {
  id: number;
  job_id: string;
  discord_message_id: string;
  discord_channel_id: string;
  author_id: string;
  author_name: string;
  author_avatar_url: string | null;
  content: string | null;
  timestamp: string;
  edited_timestamp: string | null;
  reply_to_id: string | null;
  attachments_json: string | null;
  embeds_json: string | null;
  stoat_message_id: string | null;
  imported_at: number | null;
  created_at: number;
}
