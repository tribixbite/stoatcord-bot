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

/**
 * Send a message via webhook with custom username and avatar.
 * Used for Stoat→Discord bridging to show the Stoat user's identity.
 */
export async function sendViaWebhook(
  webhookId: string,
  webhookToken: string,
  username: string,
  avatarUrl: string | undefined,
  content: string
): Promise<void> {
  // Use Discord webhook API directly for simplicity
  const url = `https://discord.com/api/v10/webhooks/${webhookId}/${webhookToken}`;
  const body: Record<string, string> = { content, username };
  if (avatarUrl) {
    body["avatar_url"] = avatarUrl;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook send failed: ${res.status} ${text}`);
  }
}
