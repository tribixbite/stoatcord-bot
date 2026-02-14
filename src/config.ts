/** Environment configuration with validation */

export interface Config {
  discordToken: string;
  stoatToken: string;
  stoatApiBase: string;
  stoatWsUrl: string;
  stoatCdnUrl: string;
  dbPath: string;
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
    dbPath: process.env["DB_PATH"] || "stoatcord.db",
  };
}
