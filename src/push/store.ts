/** Push device subscription store — SQLite CRUD for push notification registration */

import type { Database } from "bun:sqlite";

/** SQL to create the push_devices table (called from schema init) */
export const PUSH_DEVICES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS push_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stoat_user_id TEXT NOT NULL,
    device_id TEXT NOT NULL UNIQUE,
    push_mode TEXT NOT NULL CHECK(push_mode IN ('fcm', 'webpush')),
    fcm_token TEXT,
    webpush_endpoint TEXT,
    webpush_p256dh TEXT,
    webpush_auth TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(stoat_user_id);
`;

export interface PushDeviceRow {
  id: number;
  stoat_user_id: string;
  device_id: string;
  push_mode: "fcm" | "webpush";
  fcm_token: string | null;
  webpush_endpoint: string | null;
  webpush_p256dh: string | null;
  webpush_auth: string | null;
  created_at: number;
  updated_at: number;
}

export class PushStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    // Create table if not exists (idempotent)
    this.db.exec(PUSH_DEVICES_SCHEMA);
    console.log("[push:store] Push devices table initialized");
  }

  /** Register or update a device's push subscription */
  registerDevice(opts: {
    stoatUserId: string;
    deviceId: string;
    pushMode: "fcm" | "webpush";
    fcmToken?: string;
    webpushEndpoint?: string;
    webpushP256dh?: string;
    webpushAuth?: string;
  }): void {
    this.db
      .query(
        `INSERT INTO push_devices
         (stoat_user_id, device_id, push_mode, fcm_token, webpush_endpoint, webpush_p256dh, webpush_auth)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           stoat_user_id = excluded.stoat_user_id,
           push_mode = excluded.push_mode,
           fcm_token = excluded.fcm_token,
           webpush_endpoint = excluded.webpush_endpoint,
           webpush_p256dh = excluded.webpush_p256dh,
           webpush_auth = excluded.webpush_auth,
           updated_at = unixepoch()`
      )
      .run(
        opts.stoatUserId,
        opts.deviceId,
        opts.pushMode,
        opts.fcmToken ?? null,
        opts.webpushEndpoint ?? null,
        opts.webpushP256dh ?? null,
        opts.webpushAuth ?? null
      );
  }

  /** Remove a device registration by device ID */
  unregisterDevice(deviceId: string): boolean {
    const result = this.db
      .query("DELETE FROM push_devices WHERE device_id = ?")
      .run(deviceId);
    return (result as { changes: number }).changes > 0;
  }

  /** Get all registered devices for a Stoat user */
  getDevicesByUserId(stoatUserId: string): PushDeviceRow[] {
    return this.db
      .query<PushDeviceRow, [string]>(
        "SELECT * FROM push_devices WHERE stoat_user_id = ?"
      )
      .all(stoatUserId);
  }

  /** Get a specific device by its unique device ID */
  getDeviceByDeviceId(deviceId: string): PushDeviceRow | null {
    return (
      this.db
        .query<PushDeviceRow, [string]>(
          "SELECT * FROM push_devices WHERE device_id = ?"
        )
        .get(deviceId) ?? null
    );
  }

  /** Get count of all registered devices */
  getDeviceCount(): number {
    const row = this.db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) as count FROM push_devices"
      )
      .get();
    return row?.count ?? 0;
  }

  /** Remove all devices for a user (e.g. on account deletion) */
  removeAllDevicesForUser(stoatUserId: string): number {
    const result = this.db
      .query("DELETE FROM push_devices WHERE stoat_user_id = ?")
      .run(stoatUserId);
    return (result as { changes: number }).changes;
  }

  /** Remove devices with a specific FCM token (token invalidation) */
  removeByFcmToken(fcmToken: string): number {
    const result = this.db
      .query("DELETE FROM push_devices WHERE fcm_token = ?")
      .run(fcmToken);
    return (result as { changes: number }).changes;
  }
}
