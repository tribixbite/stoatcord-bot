/** Discord webhook management for sender impersonation in bridge */

import type { Client, TextChannel, Webhook } from "discord.js";

const WEBHOOK_NAME = "Stoatcord Bridge";

/**
 * Get or create a webhook for bridging in the given channel.
 * Reuses existing Stoatcord webhooks if one exists.
 */
export async function ensureWebhook(
  channel: TextChannel,
  client: Client
): Promise<Webhook> {
  // Check for existing bridge webhook
  const webhooks = await channel.fetchWebhooks();
  const existing = webhooks.find(
    (wh) => wh.name === WEBHOOK_NAME && wh.owner?.id === client.user?.id
  );

  if (existing) return existing;

  // Create new webhook
  return channel.createWebhook({
    name: WEBHOOK_NAME,
    reason: "Stoatcord message bridge",
  });
}

/** File attachment for webhook multipart upload */
export interface WebhookFile {
  data: Uint8Array;
  name: string;
}

/**
 * Send a message via webhook with custom username and avatar.
 * Used for Stoat→Discord bridging to show the Stoat user's identity.
 * Returns the Discord message ID for bridge_messages tracking.
 * When files are provided, uses multipart/form-data instead of JSON.
 */
export async function sendViaWebhook(
  webhookId: string,
  webhookToken: string,
  username: string,
  avatarUrl: string | undefined,
  content: string,
  files?: WebhookFile[]
): Promise<string> {
  // Use ?wait=true to get the created message back (includes ID)
  const url = `https://discord.com/api/v10/webhooks/${webhookId}/${webhookToken}?wait=true`;

  let res: Response;

  if (files && files.length > 0) {
    // Multipart upload with file attachments
    const formData = new FormData();
    const payload: Record<string, unknown> = { content, username };
    if (avatarUrl) {
      payload["avatar_url"] = avatarUrl;
    }
    formData.append("payload_json", JSON.stringify(payload));
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      formData.append(`files[${i}]`, new Blob([file.data]), file.name);
    }
    res = await fetch(url, { method: "POST", body: formData });
  } else {
    // Simple JSON body
    const body: Record<string, string> = { content, username };
    if (avatarUrl) {
      body["avatar_url"] = avatarUrl;
    }
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook send failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { id: string };
  return data.id;
}

/**
 * Edit a message previously sent via webhook.
 * Used for edit sync: Stoat edit → Discord webhook message edit.
 */
export async function editViaWebhook(
  webhookId: string,
  webhookToken: string,
  messageId: string,
  content: string
): Promise<void> {
  const url = `https://discord.com/api/v10/webhooks/${webhookId}/${webhookToken}/messages/${messageId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook edit failed: ${res.status} ${text}`);
  }
}

/**
 * Delete a message previously sent via webhook.
 * Used for delete sync: Stoat delete → Discord webhook message delete.
 */
export async function deleteViaWebhook(
  webhookId: string,
  webhookToken: string,
  messageId: string
): Promise<void> {
  const url = `https://discord.com/api/v10/webhooks/${webhookId}/${webhookToken}/messages/${messageId}`;
  const res = await fetch(url, {
    method: "DELETE",
  });

  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook delete failed: ${res.status} ${text}`);
  }
}
