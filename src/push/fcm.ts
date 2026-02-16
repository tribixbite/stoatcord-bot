/** FCM HTTP v1 API sender — JWT-based OAuth2 auth + data-only messages */

import { SignJWT, importPKCS8 } from "jose";

interface ServiceAccount {
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // ms timestamp
}

export class FcmSender {
  private serviceAccount: ServiceAccount;
  private projectId: string;
  private cachedToken: CachedToken | null = null;

  constructor(serviceAccountPath: string) {
    const raw = Bun.file(serviceAccountPath);
    // Synchronous read via JSON import — Bun supports this
    const json = JSON.parse(
      // bun:file .text() is async, so we use readFileSync for constructor
      require("fs").readFileSync(serviceAccountPath, "utf-8")
    ) as ServiceAccount;

    if (!json.project_id || !json.private_key || !json.client_email) {
      throw new Error(
        "[push:fcm] Invalid service account JSON — missing project_id, private_key, or client_email"
      );
    }

    this.serviceAccount = json;
    this.projectId = json.project_id;
    console.log(
      `[push:fcm] Loaded service account for project "${this.projectId}"`
    );
  }

  /** Get a valid OAuth2 access token, refreshing if expired or near expiry */
  async getAccessToken(): Promise<string> {
    // Return cached token if still valid (10-min buffer before expiry)
    if (
      this.cachedToken &&
      this.cachedToken.expiresAt > Date.now() + 10 * 60 * 1000
    ) {
      return this.cachedToken.accessToken;
    }

    console.log("[push:fcm] Refreshing OAuth2 access token...");

    const now = Math.floor(Date.now() / 1000);
    const privateKey = await importPKCS8(
      this.serviceAccount.private_key,
      "RS256"
    );

    // Create signed JWT for Google OAuth2 token exchange
    const jwt = await new SignJWT({
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.serviceAccount.client_email)
      .setAudience(
        this.serviceAccount.token_uri ||
          "https://oauth2.googleapis.com/token"
      )
      .setIssuedAt(now)
      .setExpirationTime(now + 3600) // 1 hour
      .sign(privateKey);

    // Exchange JWT for access token
    const tokenUrl =
      this.serviceAccount.token_uri || "https://oauth2.googleapis.com/token";
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `[push:fcm] Token exchange failed: ${res.status} ${res.statusText}: ${text}`
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    console.log(
      `[push:fcm] Got access token, expires in ${data.expires_in}s`
    );
    return data.access_token;
  }

  /**
   * Send an FCM data-only message to a device token.
   * Data-type messages always trigger onMessageReceived(), even in background.
   *
   * @returns true if sent successfully, false if token is invalid (should be removed)
   */
  async sendNotification(
    fcmToken: string,
    dataPayload: Record<string, string>
  ): Promise<boolean> {
    const accessToken = await this.getAccessToken();

    const url = `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`;
    const body = {
      message: {
        token: fcmToken,
        data: dataPayload,
        android: {
          priority: "high" as const,
        },
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      return true;
    }

    const errorText = await res.text().catch(() => "");

    // Token is invalid/unregistered — caller should remove from DB
    if (res.status === 404 || errorText.includes("UNREGISTERED")) {
      console.warn(
        `[push:fcm] Token unregistered, should remove: ${fcmToken.slice(0, 20)}...`
      );
      return false;
    }

    // Auth failure — try refreshing token once
    if (res.status === 401) {
      console.warn("[push:fcm] Auth failed, refreshing token and retrying...");
      this.cachedToken = null;
      const retryToken = await this.getAccessToken();
      const retryRes = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${retryToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (retryRes.ok) return true;
      const retryError = await retryRes.text().catch(() => "");
      console.error(
        `[push:fcm] Retry also failed: ${retryRes.status} ${retryError}`
      );
      return true; // don't remove token on auth issues
    }

    // Quota exceeded or server error — log but don't remove token
    console.error(
      `[push:fcm] Send failed: ${res.status} ${errorText.slice(0, 200)}`
    );
    return true; // keep token, transient error
  }
}
