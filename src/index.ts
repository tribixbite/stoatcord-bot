/** stoatcord-bot — Discord↔Stoat migration & message bridge bot */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "./config.ts";
import { Store } from "./db/store.ts";
import { createDiscordClient } from "./discord/client.ts";
import { registerCommands } from "./discord/commands.ts";
import { registerDiscordEvents } from "./discord/events.ts";
import { StoatClient } from "./stoat/client.ts";
import { StoatWebSocket } from "./stoat/websocket.ts";
import { setupStoatToDiscordRelay } from "./bridge/relay.ts";
import { handleListGuilds, handleGuildChannels } from "./api/server.ts";
import {
  handleListLinks,
  handleGuildLinks,
  handleCreateLink,
  handleDeleteLink,
} from "./api/links.ts";

/** Read full request body as string */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/** Send a Web API Response object through Node's http.ServerResponse */
async function sendResponse(
  webRes: Response,
  nodeRes: ServerResponse,
  extraHeaders: Record<string, string> = {}
): Promise<void> {
  const body = await webRes.text();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };
  nodeRes.writeHead(webRes.status, headers);
  nodeRes.end(body);
}

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

  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "x-api-key, content-type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${apiPort}`);
      const method = req.method ?? "GET";

      // Auth check — require API key if configured
      if (apiKey && req.headers["x-api-key"] !== apiKey) {
        res.writeHead(401, { ...corsHeaders, "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      // CORS preflight
      if (method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      // Route: GET /api/guilds
      if (url.pathname === "/api/guilds" && method === "GET") {
        return sendResponse(handleListGuilds(discordClient), res, corsHeaders);
      }

      // Route: GET /api/guilds/:id/channels
      const channelMatch = url.pathname.match(/^\/api\/guilds\/(\d+)\/channels$/);
      if (channelMatch && method === "GET") {
        const guildId = channelMatch[1]!;
        return sendResponse(await handleGuildChannels(discordClient, guildId), res, corsHeaders);
      }

      // Route: GET /api/links — list all active bridge links
      if (url.pathname === "/api/links" && method === "GET") {
        return sendResponse(handleListLinks(store, discordClient), res, corsHeaders);
      }

      // Route: GET /api/links/guild/:id — links for a specific guild
      const guildLinksMatch = url.pathname.match(/^\/api\/links\/guild\/(\d+)$/);
      if (guildLinksMatch && method === "GET") {
        const guildId = guildLinksMatch[1]!;
        return sendResponse(handleGuildLinks(store, discordClient, guildId), res, corsHeaders);
      }

      // Route: POST /api/links — create a new bridge link
      if (url.pathname === "/api/links" && method === "POST") {
        const body = await readBody(req);
        const reqBody = JSON.parse(body) as { discordChannelId: string; stoatChannelId: string };
        return sendResponse(await handleCreateLink(store, discordClient, reqBody), res, corsHeaders);
      }

      // Route: DELETE /api/links/:discordChannelId — remove a bridge link
      const deleteLinkMatch = url.pathname.match(/^\/api\/links\/(\d+)$/);
      if (deleteLinkMatch && method === "DELETE") {
        const discordChannelId = deleteLinkMatch[1]!;
        return sendResponse(handleDeleteLink(store, discordChannelId), res, corsHeaders);
      }

      // 404
      res.writeHead(404, { ...corsHeaders, "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      console.error("[api] Request error:", err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  server.listen(apiPort, () => {
    console.log(`[api] HTTP API listening on port ${apiPort}`);
  });

  // Status summary
  const linkedChannels = store.getLinkedChannelCount();
  const linkedServers = store.getLinkedServerCount();
  console.log(
    `[bot] Ready — ${linkedServers} server link(s), ${linkedChannels} channel bridge(s) active`
  );

  // Graceful shutdown
  const shutdown = () => {
    console.log("[bot] Shutting down...");
    server.close();
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
