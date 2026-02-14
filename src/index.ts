/** stoatcord-bot — Discord↔Stoat migration & message bridge bot */

import { loadConfig } from "./config.ts";
import { Store } from "./db/store.ts";
import { createDiscordClient } from "./discord/client.ts";
import { registerCommands } from "./discord/commands.ts";
import { registerDiscordEvents } from "./discord/events.ts";
import { StoatClient } from "./stoat/client.ts";
import { StoatWebSocket } from "./stoat/websocket.ts";
import { setupStoatToDiscordRelay } from "./bridge/relay.ts";
import { handleListGuilds, handleGuildChannels } from "./api/server.ts";

async function main(): Promise<void> {
  // Load and validate config from .env
  const config = loadConfig();

  // Initialize SQLite database
  const store = new Store(config.dbPath);
  console.log("[db] Database initialized");

  // Initialize Stoat REST client
  const stoatClient = new StoatClient(config.stoatToken, config.stoatApiBase);

  // Verify Stoat bot token
  try {
    const self = await stoatClient.getSelf();
    console.log(
      `[stoat] Authenticated as ${self.display_name ?? self.username}#${self.discriminator}`
    );
  } catch (err) {
    console.error("[stoat] Failed to authenticate:", err);
    process.exit(1);
  }

  // Connect Stoat WebSocket for realtime events
  const stoatWs = new StoatWebSocket(config.stoatToken, config.stoatWsUrl);
  stoatWs.on("ready", () => {
    console.log("[stoat-ws] Ready — listening for messages");
  });
  stoatWs.connect();

  // Set up Stoat→Discord message relay
  setupStoatToDiscordRelay(stoatWs, store, config.stoatCdnUrl, stoatClient);

  // Create Discord client
  const discordClient = createDiscordClient();

  // Register Discord event handlers (includes Discord→Stoat relay)
  registerDiscordEvents(discordClient, store, stoatClient, config.stoatCdnUrl);

  // Login Discord bot
  await discordClient.login(config.discordToken);

  // Register slash commands once logged in
  if (discordClient.user) {
    await registerCommands(config.discordToken, discordClient.user.id);
  }

  // Start HTTP API server for Stoat app integration
  const apiPort = parseInt(process.env["API_PORT"] || "3210", 10);
  const apiKey = process.env["API_KEY"] || "";

  Bun.serve({
    port: apiPort,
    async fetch(req) {
      const url = new URL(req.url);

      // Auth check — require API key if configured
      if (apiKey && req.headers.get("x-api-key") !== apiKey) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      // CORS headers for mobile app
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "x-api-key, content-type",
      };

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Route: GET /api/guilds
      if (url.pathname === "/api/guilds" && req.method === "GET") {
        const res = handleListGuilds(discordClient);
        // Add CORS headers
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: { ...corsHeaders, "content-type": "application/json" },
        });
      }

      // Route: GET /api/guilds/:id/channels
      const channelMatch = url.pathname.match(/^\/api\/guilds\/(\d+)\/channels$/);
      if (channelMatch && req.method === "GET") {
        const guildId = channelMatch[1]!;
        const res = await handleGuildChannels(discordClient, guildId);
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: { ...corsHeaders, "content-type": "application/json" },
        });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
  console.log(`[api] HTTP API listening on port ${apiPort}`);

  // Status summary
  const linkedChannels = store.getLinkedChannelCount();
  const linkedServers = store.getLinkedServerCount();
  console.log(
    `[bot] Ready — ${linkedServers} server link(s), ${linkedChannels} channel bridge(s) active`
  );

  // Graceful shutdown
  const shutdown = () => {
    console.log("[bot] Shutting down...");
    stoatWs.disconnect();
    discordClient.destroy();
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[bot] Fatal error:", err);
  process.exit(1);
});
