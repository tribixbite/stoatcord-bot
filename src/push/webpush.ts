/** WebPush sender for UnifiedPush endpoints — RFC 8291 encryption + VAPID */

// WebPush via web-push package (optional dependency — FCM is the primary path).
// Install with: bun add web-push

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface WebPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * WebPush sender for UnifiedPush endpoints.
 * Sends encrypted payloads to the subscriber's distributor endpoint.
 */
export class WebPushSender {
  private vapidKeys: VapidKeys;
  private contactEmail: string;

  constructor(vapidKeys: VapidKeys, contactEmail = "mailto:push@stoat.chat") {
    this.vapidKeys = vapidKeys;
    this.contactEmail = contactEmail;
    console.log(
      `[push:webpush] Initialized with VAPID public key: ${vapidKeys.publicKey.slice(0, 20)}...`
    );
  }

  /**
   * Send a notification payload via WebPush encryption to a UnifiedPush endpoint.
   *
   * @returns true if sent successfully, false if subscription is expired/invalid
   */
  async sendNotification(
    subscription: WebPushSubscription,
    payload: string
  ): Promise<boolean> {
    try {
      // Use web-push library for RFC 8291 encryption + VAPID signing
      const webPush = await import("web-push");
      webPush.setVapidDetails(
        this.contactEmail,
        this.vapidKeys.publicKey,
        this.vapidKeys.privateKey
      );

      await webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
        },
        payload,
        { TTL: 3600 } // 1-hour time-to-live
      );

      return true;
    } catch (err: unknown) {
      const error = err as { statusCode?: number; message?: string };

      // 404 or 410 = subscription expired/invalid
      if (error.statusCode === 404 || error.statusCode === 410) {
        console.warn(
          `[push:webpush] Subscription expired (${error.statusCode}): ${subscription.endpoint.slice(0, 60)}...`
        );
        return false;
      }

      console.error(
        `[push:webpush] Send failed: ${error.message ?? error}`
      );
      return true; // keep subscription on transient errors
    }
  }

  /** Generate a new VAPID keypair (call once, store the result) */
  static generateVapidKeys(): VapidKeys {
    try {
      const webPush = require("web-push");
      const keys = webPush.generateVAPIDKeys();
      return {
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
      };
    } catch {
      console.error(
        "[push:webpush] web-push not installed — run: bun add web-push"
      );
      throw new Error("web-push package required for VAPID key generation");
    }
  }
}
