/** Discord.js v14 client setup */

import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildWebhooks,
    ],
    partials: [Partials.Message, Partials.Channel],
  });
}
