/** stoatcord-bot — Discord↔Stoat migration & message bridge bot */

// Load .env first — grun doesn't pass env vars to child processes
import "./env.ts";

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

async function main(): Promise<void> {
  // Load and validate config from .env
  const config = loadConfig();

  // Initialize SQLite database (bun:sqlite)
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

  const server = Bun.serve({
    port: apiPort,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const method = req.method;

      // Auth check — require API key if configured
      if (apiKey && req.headers.get("x-api-key") !== apiKey) {
        return Response.json({ error: "Unauthorized" }, {
          status: 401,
          headers: corsHeaders,
        });
      }

      // CORS preflight
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      try {
        // Route: GET /api/guilds
        if (url.pathname === "/api/guilds" && method === "GET") {
          return addHeaders(handleListGuilds(discordClient), corsHeaders);
        }

        // Route: GET /api/guilds/:id/channels
        const channelMatch = url.pathname.match(
          /^\/api\/guilds\/(\d+)\/channels$/
        );
        if (channelMatch && method === "GET") {
          const guildId = channelMatch[1]!;
          return addHeaders(
            await handleGuildChannels(discordClient, guildId),
            corsHeaders
          );
        }

        // Route: GET /api/links — list all active bridge links
        if (url.pathname === "/api/links" && method === "GET") {
          return addHeaders(
            handleListLinks(store, discordClient),
            corsHeaders
          );
        }

        // Route: GET /api/links/guild/:id — links for a specific guild
        const guildLinksMatch = url.pathname.match(
          /^\/api\/links\/guild\/(\d+)$/
        );
        if (guildLinksMatch && method === "GET") {
          const guildId = guildLinksMatch[1]!;
          return addHeaders(
            handleGuildLinks(store, discordClient, guildId),
            corsHeaders
          );
        }

        // Route: POST /api/links — create a new bridge link
        if (url.pathname === "/api/links" && method === "POST") {
          const body = (await req.json()) as {
            discordChannelId: string;
            stoatChannelId: string;
          };
          return addHeaders(
            await handleCreateLink(store, discordClient, body),
            corsHeaders
          );
        }

        // Route: DELETE /api/links/:discordChannelId — remove a bridge link
        const deleteLinkMatch = url.pathname.match(/^\/api\/links\/(\d+)$/);
        if (deleteLinkMatch && method === "DELETE") {
          const discordChannelId = deleteLinkMatch[1]!;
          return addHeaders(
            handleDeleteLink(store, discordChannelId),
            corsHeaders
          );
        }

        // Route: POST /api/claim-code — generate a one-time claim code for a Stoat server
        if (url.pathname === "/api/claim-code" && method === "POST") {
          const body = (await req.json()) as { stoatServerId: string };
          if (!body.stoatServerId) {
            return Response.json(
              { error: "stoatServerId is required" },
              { status: 400, headers: corsHeaders }
            );
          }
          // Verify the bot can access this Stoat server
          try {
            await stoatClient.getServer(body.stoatServerId);
          } catch {
            return Response.json(
              { error: "Bot cannot access that Stoat server" },
              { status: 404, headers: corsHeaders }
            );
          }
          store.cleanExpiredCodes();
          const code = store.createClaimCode(body.stoatServerId);
          return addHeaders(
            Response.json({ code, expiresIn: "1 hour" }),
            corsHeaders
          );
        }

        // 404
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: corsHeaders,
        });
      } catch (err) {
        console.error("[api] Request error:", err);
        return Response.json({ error: "Internal server error" }, {
          status: 500,
          headers: corsHeaders,
        });
      }
    },
  });

  console.log(`[api] HTTP API listening on port ${server.port}`);

  // Status summary
  const linkedChannels = store.getLinkedChannelCount();
  const linkedServers = store.getLinkedServerCount();
  console.log(
    `[bot] Ready — ${linkedServers} server link(s), ${linkedChannels} channel bridge(s) active`
  );

  // Graceful shutdown
  const shutdown = () => {
    console.log("[bot] Shutting down...");
    server.stop();
    stoatWs.disconnect();
    discordClient.destroy();
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Clone a Response with extra headers appended */
function addHeaders(
  response: Response,
  headers: Record<string, string>
): Response {
  const newHeaders = new Headers(response.headers);
  for (const [k, v] of Object.entries(headers)) {
    newHeaders.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

main().catch((err) => {
  console.error("[bot] Fatal error:", err);
  process.exit(1);
});
