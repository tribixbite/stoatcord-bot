/** Push notification relay — routes Stoat WS events to FCM/WebPush devices */

import type { StoatWebSocket } from "../stoat/websocket.ts";
import type { StoatClient } from "../stoat/client.ts";
import type { User, Channel, BonfireMessageEvent } from "../stoat/types.ts";
import type { PushStore } from "./store.ts";
import type { FcmSender } from "./fcm.ts";
import type { WebPushSender } from "./webpush.ts";

/** Cached user info with TTL */
interface CachedUser {
  user: User;
  fetchedAt: number;
}

/** Cached channel info with TTL */
interface CachedChannel {
  channel: Channel;
  fetchedAt: number;
}

const USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CHANNEL_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Set up the push notification relay.
 * Hooks into Stoat WebSocket message events and routes notifications
 * to registered FCM/WebPush devices.
 */
export function setupPushRelay(opts: {
  stoatWs: StoatWebSocket;
  stoatClient: StoatClient;
  pushStore: PushStore;
  fcmSender: FcmSender | null;
  webPushSender: WebPushSender | null;
  botSelfId: string;
  cdnUrl: string;
}): void {
  const { stoatWs, stoatClient, pushStore, fcmSender, webPushSender, botSelfId, cdnUrl } = opts;
  const userCache = new Map<string, CachedUser>();
  const channelCache = new Map<string, CachedChannel>();

  stoatWs.on("message", async (event: BonfireMessageEvent) => {
    try {
      await handleMessage(event);
    } catch (err) {
      console.error("[push:relay] Error handling message:", err);
    }
  });

  async function handleMessage(event: BonfireMessageEvent): Promise<void> {
    console.log(
      `[push:relay] Processing message ${event._id} from ${event.author} in ${event.channel}`
    );

    // Skip messages from the bot itself
    if (event.author === botSelfId) {
      console.log("[push:relay] Skipped — bot's own message");
      return;
    }

    // Skip masqueraded messages (bridged from Discord)
    if (event.masquerade) {
      console.log("[push:relay] Skipped — masqueraded (bridged) message");
      return;
    }

    // Determine which users should receive push notifications
    const targetUserIds = new Set<string>();

    // Extract mentioned user IDs from content: <@userId>
    if (event.content) {
      const mentionRegex = /<@([A-Z0-9]{26})>/g;
      let match;
      while ((match = mentionRegex.exec(event.content)) !== null) {
        targetUserIds.add(match[1]!);
      }
      console.log(
        `[push:relay] Content mentions: ${targetUserIds.size} user(s) — content: "${event.content.slice(0, 100)}"`
      );
    }

    // Check if this is a DM/Group channel — notify all recipients
    const channel = await getChannel(event.channel);
    if (channel) {
      console.log(`[push:relay] Channel type: ${channel.channel_type}`);
      if (
        channel.channel_type === "DirectMessage" ||
        channel.channel_type === "Group"
      ) {
        // Notify all recipients in the DM/Group except the sender
        if (channel.recipients) {
          for (const recipientId of channel.recipients) {
            if (recipientId !== event.author) {
              targetUserIds.add(recipientId);
            }
          }
        }
        // For DMs, also check the "user" field (1-on-1 DMs)
        if (channel.user && channel.user !== event.author) {
          targetUserIds.add(channel.user);
        }
      }
    }

    // No targets — skip (server messages without mentions)
    if (targetUserIds.size === 0) {
      console.log("[push:relay] Skipped — no target users (no mentions, not a DM)");
      return;
    }

    // Remove the sender from targets (don't notify yourself)
    targetUserIds.delete(event.author);

    if (targetUserIds.size === 0) return;

    // Fetch author info for notification display
    const author = await getUser(event.author);
    if (!author) {
      console.warn(`[push:relay] Could not fetch author ${event.author}`);
      return;
    }

    // Build avatar URL
    const authorIcon = author.avatar
      ? `${cdnUrl}/avatars/${author.avatar._id}`
      : `${cdnUrl.replace("cdn.", "api.")}/users/${author._id}/default_avatar`;

    // Build the notification payload matching HandlerService expectations
    const notificationPayload = JSON.stringify({
      icon: authorIcon,
      message: {
        _id: event._id,
        channel: event.channel,
        author: event.author,
        content: event.content ?? "",
        attachments: event.attachments ?? [],
        user: {
          _id: author._id,
          username: author.username,
          discriminator: author.discriminator,
          display_name: author.display_name,
          avatar: author.avatar ?? null,
          bot: author.bot ?? null,
        },
      },
    });

    // Send to each target user's registered devices
    console.log(`[push:relay] Sending to ${targetUserIds.size} target user(s): ${[...targetUserIds].join(", ")}`);
    let sentCount = 0;
    for (const userId of targetUserIds) {
      const devices = pushStore.getDevicesByUserId(userId);
      console.log(`[push:relay] User ${userId}: ${devices.length} device(s) registered`);
      if (devices.length === 0) continue;

      for (const device of devices) {
        if (device.push_mode === "fcm" && device.fcm_token && fcmSender) {
          const success = await fcmSender.sendNotification(device.fcm_token, {
            payload: notificationPayload,
          });
          if (!success) {
            // Token invalid — remove device
            console.log(
              `[push:relay] Removing invalid FCM device ${device.device_id}`
            );
            pushStore.unregisterDevice(device.device_id);
          } else {
            sentCount++;
          }
        } else if (
          device.push_mode === "webpush" &&
          device.webpush_endpoint
        ) {
          // WebPush with encryption keys (RFC 8291)
          if (device.webpush_p256dh && device.webpush_auth && webPushSender) {
            const success = await webPushSender.sendNotification(
              {
                endpoint: device.webpush_endpoint,
                p256dh: device.webpush_p256dh,
                auth: device.webpush_auth,
              },
              notificationPayload
            );
            if (!success) {
              console.log(
                `[push:relay] Removing expired WebPush device ${device.device_id}`
              );
              pushStore.unregisterDevice(device.device_id);
            } else {
              sentCount++;
            }
          } else {
            // Plain HTTP POST for UP endpoints without encryption keys (e.g., ntfy)
            try {
              const res = await fetch(device.webpush_endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: notificationPayload,
              });
              if (res.ok) {
                sentCount++;
              } else if (res.status === 404 || res.status === 410) {
                console.log(
                  `[push:relay] Removing expired UP endpoint ${device.device_id}`
                );
                pushStore.unregisterDevice(device.device_id);
              } else {
                console.warn(
                  `[push:relay] UP plain POST failed for ${device.device_id}: ${res.status}`
                );
              }
            } catch (err) {
              console.warn(
                `[push:relay] UP plain POST error for ${device.device_id}:`,
                err
              );
            }
          }
        }
      }
    }

    if (sentCount > 0) {
      console.log(
        `[push:relay] Sent ${sentCount} push notification(s) for message ${event._id}`
      );
    }
  }

  /** Fetch user with cache */
  async function getUser(userId: string): Promise<User | null> {
    const cached = userCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < USER_CACHE_TTL) {
      return cached.user;
    }

    try {
      const user = await stoatClient.fetchUser(userId);
      userCache.set(userId, { user, fetchedAt: Date.now() });
      return user;
    } catch (err) {
      console.warn(`[push:relay] Failed to fetch user ${userId}:`, err);
      return null;
    }
  }

  /** Fetch channel with cache */
  async function getChannel(channelId: string): Promise<Channel | null> {
    const cached = channelCache.get(channelId);
    if (cached && Date.now() - cached.fetchedAt < CHANNEL_CACHE_TTL) {
      return cached.channel;
    }

    try {
      const channel = await stoatClient.getChannel(channelId);
      channelCache.set(channelId, { channel, fetchedAt: Date.now() });
      return channel;
    } catch (err) {
      console.warn(
        `[push:relay] Failed to fetch channel ${channelId}:`,
        err
      );
      return null;
    }
  }

  console.log("[push:relay] Push notification relay initialized");
}
