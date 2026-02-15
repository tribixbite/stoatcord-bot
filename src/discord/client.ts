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
      // Privileged intents for migration snapshot — requires enabling in Discord portal.
      // Graceful fallback: snapshot sections skip data if these intents are not enabled.
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
    ],
    partials: [Partials.Message, Partials.Channel],
  });
}
