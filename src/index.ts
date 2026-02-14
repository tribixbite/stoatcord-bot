/** stoatcord-bot — Discord↔Stoat migration & message bridge bot */

import { loadConfig } from "./config.ts";
import { Store } from "./db/store.ts";
import { createDiscordClient } from "./discord/client.ts";
import { registerCommands } from "./discord/commands.ts";
import { registerDiscordEvents } from "./discord/events.ts";
import { StoatClient } from "./stoat/client.ts";
import { StoatWebSocket } from "./stoat/websocket.ts";
import { setupStoatToDiscordRelay } from "./bridge/relay.ts";

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
  setupStoatToDiscordRelay(stoatWs, store, config.stoatCdnUrl);

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
