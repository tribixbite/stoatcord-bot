/** Environment configuration with validation */

export interface Config {
  discordToken: string;
  stoatToken: string;
  stoatApiBase: string;
  stoatWsUrl: string;
  stoatCdnUrl: string;
  stoatAutumnUrl: string;
  dbPath: string;
  // Push notification relay config
  pushEnabled: boolean;
  firebaseServiceAccount: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  pushBotApiUrl: string;
}

export function loadConfig(): Config {
  const discordToken = process.env["DISCORD_TOKEN"];
  const stoatToken = process.env["STOAT_TOKEN"];

  if (!discordToken) {
    throw new Error("DISCORD_TOKEN is required — set it in .env");
  }
  if (!stoatToken) {
    throw new Error("STOAT_TOKEN is required — set it in .env");
  }

  return {
    discordToken,
    stoatToken,
    stoatApiBase: process.env["STOAT_API_BASE"] || "https://api.stoat.chat/0.8",
    stoatWsUrl: process.env["STOAT_WS_URL"] || "wss://events.stoat.chat",
    stoatCdnUrl: process.env["STOAT_CDN_URL"] || "https://cdn.stoatusercontent.com",
    stoatAutumnUrl: process.env["STOAT_AUTUMN_URL"] || "https://autumn.stoat.chat",
    dbPath: process.env["DB_PATH"] || "stoatcord.db",
    // Push notification relay
    pushEnabled: process.env["PUSH_ENABLED"] !== "false",
    firebaseServiceAccount:
      process.env["FIREBASE_SERVICE_ACCOUNT"] || "./firebase-service-account.json",
    vapidPublicKey: process.env["VAPID_PUBLIC_KEY"] || "",
    vapidPrivateKey: process.env["VAPID_PRIVATE_KEY"] || "",
    pushBotApiUrl: process.env["PUSH_BOT_API_URL"] || `http://localhost:${process.env["API_PORT"] || "3210"}`,
  };
}
