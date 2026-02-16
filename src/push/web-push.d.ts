/** Type declarations for web-push (no @types/web-push available) */
declare module "web-push" {
  interface PushSubscription {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  }

  interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }

  interface SendOptions {
    TTL?: number;
    headers?: Record<string, string>;
    vapidDetails?: {
      subject: string;
      publicKey: string;
      privateKey: string;
    };
  }

  function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string
  ): void;

  function sendNotification(
    subscription: PushSubscription,
    payload: string | Buffer,
    options?: SendOptions
  ): Promise<{ statusCode: number; body: string }>;

  function generateVAPIDKeys(): VapidKeys;
}
