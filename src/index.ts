/** stoatcord-bot — Discord↔Stoat migration & message bridge bot */

// Global error handlers — prevent unhandled errors from crashing the bot
process.on("uncaughtException", (err) => {
  console.error("[bot] UNCAUGHT EXCEPTION — bot will continue running:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[bot] UNHANDLED REJECTION — bot will continue running:", reason);
});

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
import { runOutageRecovery } from "./bridge/recovery.ts";
import { setupStoatCommands } from "./stoat/commands.ts";
import { cancelAllPending } from "./migration/approval.ts";
import { handleListGuilds, handleGuildChannels } from "./api/server.ts";
import {
  handleListLinks,
  handleGuildLinks,
  handleCreateLink,
  handleDeleteLink,
} from "./api/links.ts";
import { PushStore } from "./push/store.ts";
import { FcmSender } from "./push/fcm.ts";
import { WebPushSender } from "./push/webpush.ts";
import { setupPushRelay } from "./push/relay.ts";

async function main(): Promise<void> {
  // Load and validate config from .env
  const config = loadConfig();

  // Initialize SQLite database (bun:sqlite)
  const store = new Store(config.dbPath);
  console.log("[db] Database initialized");

  // Initialize Stoat REST client
  const stoatClient = new StoatClient(config.stoatToken, config.stoatApiBase, config.stoatAutumnUrl);

  // Verify Stoat bot token and store bot user ID for command detection
  let botSelfId: string;
  try {
    const self = await stoatClient.getSelf();
    botSelfId = self._id;
    console.log(
      `[stoat] Authenticated as ${self.display_name ?? self.username}#${self.discriminator} (${botSelfId})`
    );
  } catch (err) {
    console.error("[stoat] Failed to authenticate:", err);
    process.exit(1);
  }

  // Startup cleanup — expire stale codes, pending requests, and old bridge mappings
  store.cleanExpiredCodes();
  const expiredReqs = store.cleanExpiredRequests();
  if (expiredReqs > 0) {
    console.log(`[db] Cleaned ${expiredReqs} expired migration request(s)`);
  }
  const prunedBridge = store.cleanOldBridgeMessages();
  if (prunedBridge > 0) {
    console.log(`[db] Pruned ${prunedBridge} old bridge message mapping(s)`);
  }
  // Backfill API tokens for any pre-existing server links without one
  const backfilled = store.backfillApiTokens();
  if (backfilled > 0) {
    console.log(`[db] Backfilled API tokens for ${backfilled} server link(s)`);
  }

  // Connect Stoat WebSocket for realtime events
  const stoatWs = new StoatWebSocket(config.stoatToken, config.stoatWsUrl);
  // discordClient is set later; use a mutable reference for the recovery closure
  let discordClientRef: ReturnType<typeof createDiscordClient> | null = null;
  stoatWs.on("ready", () => {
    console.log("[stoat-ws] Ready — listening for messages");
    // Run outage recovery on connect/reconnect
    runOutageRecovery(store, stoatClient, discordClientRef, config.stoatCdnUrl).catch((err) => {
      console.error("[recovery] Outage recovery failed:", err);
    });
  });
  stoatWs.connect();

  // Initialize push notification relay system
  const pushStore = new PushStore(store.database); // share the same bun:sqlite Database instance
  let fcmSender: FcmSender | null = null;
  let webPushSender: WebPushSender | null = null;

  if (config.pushEnabled) {
    // Initialize FCM sender if service account is available (file or env var)
    try {
      const saPath = config.firebaseServiceAccount;
      const hasEnvJson = !!process.env["FIREBASE_SA_JSON"];
      const hasFile = await Bun.file(saPath).exists();
      if (hasEnvJson || hasFile) {
        fcmSender = new FcmSender(saPath);
      } else {
        console.warn(
          `[push] Firebase service account not found at ${saPath} and FIREBASE_SA_JSON not set — FCM disabled`
        );
      }
    } catch (err) {
      console.error("[push] Failed to initialize FCM sender:", err);
    }

    // Initialize WebPush sender if VAPID keys are configured
    if (config.vapidPublicKey && config.vapidPrivateKey) {
      webPushSender = new WebPushSender(
        {
          publicKey: config.vapidPublicKey,
          privateKey: config.vapidPrivateKey,
        }
      );
    } else {
      console.log(
        "[push] VAPID keys not configured — WebPush/UnifiedPush disabled"
      );
    }

    // Set up the relay (hooks into WS message events)
    setupPushRelay({
      stoatWs,
      stoatClient,
      pushStore,
      fcmSender,
      webPushSender,
      botSelfId,
      cdnUrl: config.stoatCdnUrl,
    });

    console.log(
      `[push] Push relay enabled — FCM: ${fcmSender ? "yes" : "no"}, WebPush: ${webPushSender ? "yes" : "no"}`
    );
  } else {
    console.log("[push] Push relay disabled (PUSH_ENABLED=false)");
  }

  // Create Discord client (needed before setting up Stoat commands that reference it)
  let discordClient: ReturnType<typeof createDiscordClient> | null = null;
  try {
    discordClient = createDiscordClient();
    discordClientRef = discordClient;

    // Set up Stoat-side command handler (!stoatcord code, request, status, help)
    // and reply-based migration approval detection
    setupStoatCommands(stoatWs, store, stoatClient, botSelfId, discordClient, pushStore);

    // Set up Stoat→Discord message relay (includes typing, reactions, channel metadata sync)
    setupStoatToDiscordRelay(stoatWs, store, config.stoatCdnUrl, stoatClient, discordClient);

    // Register Discord event handlers (includes Discord→Stoat relay)
    registerDiscordEvents(discordClient, store, stoatClient, config.stoatCdnUrl);

    // Login Discord bot
    await discordClient.login(config.discordToken);

    // Register slash commands once logged in
    if (discordClient.user) {
      await registerCommands(config.discordToken, discordClient.user.id);
    }
  } catch (err) {
    console.warn("[discord] Discord connection failed (push relay still active):", (err as Error).message);
    discordClient = null;
  }

  // Start HTTP API server for Stoat app integration
  const apiPort = parseInt(process.env["PORT"] || process.env["API_PORT"] || "3210", 10);
  const apiKey = process.env["API_KEY"] || "";
  if (!apiKey) {
    console.warn("[api] WARNING: API_KEY is not set — all endpoints are unauthenticated!");
  }

  // CORS: restrict to known origins in production, allow all in dev
  const allowedOrigins = process.env["CORS_ORIGINS"]?.split(",") ?? ["*"];
  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": allowedOrigins[0]!,
    "Access-Control-Allow-Headers": "x-api-key, content-type, authorization",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };

  const server = Bun.serve({
    port: apiPort,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const method = req.method;

      // Auth check — require API key if configured
      // /api/health is exempt (uptime monitors)
      // Push endpoints (/api/push/*) accept either admin API key or per-user push token
      const reqApiKey = req.headers.get("x-api-key") ?? "";
      const isPushEndpoint = url.pathname.startsWith("/api/push/");
      const isAdminAuthed = apiKey && reqApiKey === apiKey;
      let pushTokenUserId: string | null = null; // set when authed via push token

      if (url.pathname !== "/api/health" && url.pathname !== "/api/push/vapid") {
        if (isPushEndpoint && !isAdminAuthed) {
          // Try per-user push token auth
          pushTokenUserId = reqApiKey ? store.getPushTokenUser(reqApiKey) : null;
          if (!pushTokenUserId) {
            return Response.json({ error: "Unauthorized" }, {
              status: 401,
              headers: corsHeaders,
            });
          }
        } else if (apiKey && !isAdminAuthed) {
          return Response.json({ error: "Unauthorized" }, {
            status: 401,
            headers: corsHeaders,
          });
        }
      }

      // CORS preflight
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Route: GET /api/health — minimal unauthenticated healthcheck
      if (url.pathname === "/api/health" && method === "GET") {
        return addHeaders(
          Response.json({ status: "ok" }),
          corsHeaders
        );
      }

      try {
        // Route: GET /api/guilds
        if (url.pathname === "/api/guilds" && method === "GET") {
          if (!discordClient) return Response.json({ error: "Discord not connected" }, { status: 503, headers: corsHeaders });
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
          const body = (await req.json()) as {
            stoatServerId: string;
            userId?: string;
            channelId?: string;
          };
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
          const code = store.createClaimCode(body.stoatServerId, body.userId, body.channelId);
          return addHeaders(
            Response.json({ code, expiresIn: "1 hour" }),
            corsHeaders
          );
        }

        // Route: POST /api/test-notify — send a test mention message to a Stoat channel
        if (url.pathname === "/api/test-notify" && method === "POST") {
          const body = (await req.json()) as {
            channelId: string;
            targetUserId: string;
          };
          if (!body.channelId || !body.targetUserId) {
            return Response.json(
              { error: "channelId and targetUserId are required" },
              { status: 400, headers: corsHeaders }
            );
          }
          try {
            const timestamp = new Date().toISOString();
            const msg = await stoatClient.sendMessage(
              body.channelId,
              `**Notification Test (API)** — <@${body.targetUserId}> test ping at ${timestamp}`
            );
            return addHeaders(
              Response.json({
                ok: true,
                messageId: msg._id,
                info: "Message sent with mention. If push is working, target user should receive a notification.",
              }),
              corsHeaders
            );
          } catch (err) {
            return Response.json(
              { error: "Failed to send test notification" },
              { status: 500, headers: corsHeaders }
            );
          }
        }

        // Route: GET /api/diag — bot diagnostics
        if (url.pathname === "/api/diag" && method === "GET") {
          try {
            const self = await stoatClient.getSelf();
            return addHeaders(
              Response.json({
                bot: {
                  id: self._id,
                  username: self.username,
                  isBot: !!self.bot,
                },
                discord: {
                  connected: discordClient?.isReady() ?? false,
                  guilds: discordClient?.guilds.cache.size ?? 0,
                  user: discordClient?.user?.tag ?? null,
                },
                stoat: {
                  wsConnected: stoatWs.isConnected(),
                  wsDebug: stoatWs.getDebugState(),
                },
                links: {
                  total: store.getAllActiveChannelLinks().length,
                },
                push: {
                  enabled: config.pushEnabled,
                  fcmConfigured: fcmSender !== null,
                  webPushConfigured: webPushSender !== null,
                  registeredDevices: pushStore.getDeviceCount(),
                },
              }),
              corsHeaders
            );
          } catch (err) {
            return Response.json(
              { error: "Diagnostics unavailable" },
              { status: 500, headers: corsHeaders }
            );
          }
        }

        // --- Push notification registration routes ---

        // Route: POST /api/push/register — register a device for push notifications
        if (url.pathname === "/api/push/register" && method === "POST") {
          const body = (await req.json()) as {
            userId: string;
            deviceId: string;
            mode: "fcm" | "webpush";
            fcmToken?: string;
            endpoint?: string;
            p256dh?: string;
            auth?: string;
          };
          if (!body.userId || !body.deviceId || !body.mode) {
            return Response.json(
              { error: "userId, deviceId, and mode are required" },
              { status: 400, headers: corsHeaders }
            );
          }
          if (body.mode === "fcm" && !body.fcmToken) {
            return Response.json(
              { error: "fcmToken required for FCM mode" },
              { status: 400, headers: corsHeaders }
            );
          }
          if (body.mode === "webpush" && !body.endpoint) {
            return Response.json(
              { error: "endpoint required for WebPush mode" },
              { status: 400, headers: corsHeaders }
            );
          }
          // Validate webpush endpoint URL to prevent SSRF
          if (body.mode === "webpush" && body.endpoint) {
            try {
              const epUrl = new URL(body.endpoint);
              const host = epUrl.hostname.toLowerCase();
              if (
                epUrl.protocol !== "https:" ||
                host === "localhost" || host === "127.0.0.1" || host === "::1" ||
                host.startsWith("10.") || host.startsWith("192.168.") ||
                host.startsWith("169.254.") || host.endsWith(".internal") || host.endsWith(".local")
              ) {
                return Response.json(
                  { error: "Invalid webpush endpoint — must be a public HTTPS URL" },
                  { status: 400, headers: corsHeaders }
                );
              }
            } catch {
              return Response.json(
                { error: "Invalid webpush endpoint URL" },
                { status: 400, headers: corsHeaders }
              );
            }
          }
          // When authed via push token, enforce user scoping — override the userId
          // to prevent registering devices under a different user
          const effectiveUserId = pushTokenUserId ?? body.userId;

          // p256dh and auth are optional — UnifiedPush distributors like ntfy
          // don't provide WebPush encryption keys, so relay.ts falls back to
          // plain HTTP POST for endpoints without them
          pushStore.registerDevice({
            stoatUserId: effectiveUserId,
            deviceId: body.deviceId,
            pushMode: body.mode,
            fcmToken: body.fcmToken,
            webpushEndpoint: body.endpoint,
            webpushP256dh: body.p256dh,
            webpushAuth: body.auth,
          });
          console.log(
            `[push] Registered device ${body.deviceId} (${body.mode}) for user ${effectiveUserId}${pushTokenUserId ? " (token-authed)" : ""}`
          );
          return addHeaders(
            Response.json({ ok: true, mode: body.mode }),
            corsHeaders
          );
        }

        // Route: DELETE /api/push/unregister — remove a device registration
        if (url.pathname === "/api/push/unregister" && method === "DELETE") {
          const body = (await req.json()) as { deviceId: string };
          if (!body.deviceId) {
            return Response.json(
              { error: "deviceId is required" },
              { status: 400, headers: corsHeaders }
            );
          }
          // When authed via push token, verify the device belongs to this user
          if (pushTokenUserId) {
            const device = pushStore.getDeviceByDeviceId(body.deviceId);
            if (device && device.stoat_user_id !== pushTokenUserId) {
              return Response.json(
                { error: "Device does not belong to your account" },
                { status: 403, headers: corsHeaders }
              );
            }
          }

          const removed = pushStore.unregisterDevice(body.deviceId);
          console.log(
            `[push] Unregistered device ${body.deviceId}: ${removed ? "found" : "not found"}${pushTokenUserId ? " (token-authed)" : ""}`
          );
          return addHeaders(
            Response.json({ ok: true, removed }),
            corsHeaders
          );
        }

        // Route: GET /api/push/status — check device registration status
        if (url.pathname === "/api/push/status" && method === "GET") {
          const deviceId = url.searchParams.get("deviceId");
          if (!deviceId) {
            return Response.json(
              { error: "deviceId query param required" },
              { status: 400, headers: corsHeaders }
            );
          }
          const device = pushStore.getDeviceByDeviceId(deviceId);

          // When authed via push token, only show the user's own device
          if (pushTokenUserId && device && device.stoat_user_id !== pushTokenUserId) {
            return addHeaders(
              Response.json({ registered: false, mode: null, updatedAt: null }),
              corsHeaders
            );
          }

          return addHeaders(
            Response.json({
              registered: device !== null,
              mode: device?.push_mode ?? null,
              updatedAt: device?.updated_at ?? null,
            }),
            corsHeaders
          );
        }

        // Route: GET /api/push/vapid — get VAPID public key for WebPush
        if (url.pathname === "/api/push/vapid" && method === "GET") {
          return addHeaders(
            Response.json({
              vapidPublicKey: config.vapidPublicKey || null,
            }),
            corsHeaders
          );
        }

        // --- Archive API routes (guild-scoped Bearer token auth) ---

        // Route: GET /api/archive/status — get archive job status
        if (url.pathname === "/api/archive/status" && method === "GET") {
          const auth = resolveGuildFromBearerToken(req, store);
          if ("error" in auth) {
            return Response.json({ error: auth.error }, { status: auth.status, headers: corsHeaders });
          }
          const authedGuildId = auth.guildId;

          const jobId = url.searchParams.get("jobId");
          if (jobId) {
            const job = store.getArchiveJob(jobId);
            if (!job) {
              return Response.json({ error: "Job not found" }, { status: 404, headers: corsHeaders });
            }
            // Enforce guild scoping — job must belong to the authed guild
            if (job.guild_id !== authedGuildId) {
              return Response.json({ error: "Job not found" }, { status: 404, headers: corsHeaders });
            }
            const counts = store.getArchiveMessageCounts(jobId);
            return addHeaders(Response.json({ ...job, counts }), corsHeaders);
          }

          // Return all jobs for the authed guild
          const jobs = store.getArchiveJobsForGuild(authedGuildId);
          return addHeaders(Response.json({ jobs }), corsHeaders);
        }

        // Route: POST /api/archive/start — start an archive export
        if (url.pathname === "/api/archive/start" && method === "POST") {
          const auth = resolveGuildFromBearerToken(req, store);
          if ("error" in auth) {
            return Response.json({ error: auth.error }, { status: auth.status, headers: corsHeaders });
          }
          if (!discordClient) return Response.json({ error: "Discord not connected" }, { status: 503, headers: corsHeaders });

          const body = (await req.json()) as {
            discordChannelId: string;
            stoatChannelId?: string;
            rehostAttachments?: boolean;
            preserveEmbeds?: boolean;
          };

          if (!body.discordChannelId) {
            return Response.json(
              { error: "discordChannelId is required" },
              { status: 400, headers: corsHeaders }
            );
          }

          // Verify the channel belongs to the authed guild
          const channel = discordClient.channels.cache.get(body.discordChannelId);
          if (!channel || !("guildId" in channel) || channel.guildId !== auth.guildId) {
            return Response.json(
              { error: "Channel not found in your guild" },
              { status: 403, headers: corsHeaders }
            );
          }

          // Check for existing active job
          const existing = store.getActiveExportJob(body.discordChannelId);
          if (existing) {
            return Response.json(
              { error: `Active job exists: ${existing.id} (${existing.status})` },
              { status: 409, headers: corsHeaders }
            );
          }

          // Lazy-import archive modules to avoid circular deps at startup
          const { exportDiscordChannel } = await import("./archive/export.ts");
          const { registerJob: regJob, unregisterJob: unregJob } = await import("./archive/manager.ts");

          const jobId = store.createArchiveJob({
            guildId: auth.guildId,
            discordChannelId: body.discordChannelId,
            discordChannelName: body.discordChannelId,
            stoatChannelId: body.stoatChannelId,
            direction: "export",
          });

          const signal = regJob(jobId);

          // Run export in background
          exportDiscordChannel(discordClient, store, jobId, body.discordChannelId, signal).then(() => {
            unregJob(jobId);
          }).catch((err) => {
            unregJob(jobId);
            console.error("[archive-api] Export failed:", err);
          });

          return addHeaders(
            Response.json({ jobId, status: "started" }, { status: 201 }),
            corsHeaders
          );
        }

        // Route: POST /api/archive/pause — pause a running job
        if (url.pathname === "/api/archive/pause" && method === "POST") {
          const auth = resolveGuildFromBearerToken(req, store);
          if ("error" in auth) {
            return Response.json({ error: auth.error }, { status: auth.status, headers: corsHeaders });
          }
          const body = (await req.json()) as { jobId: string };
          if (!body.jobId) {
            return Response.json({ error: "jobId is required" }, { status: 400, headers: corsHeaders });
          }
          const job = store.getArchiveJob(body.jobId);
          if (!job || job.guild_id !== auth.guildId) {
            return Response.json({ error: "Job not found" }, { status: 404, headers: corsHeaders });
          }
          if (job.status !== "running") {
            return Response.json({ error: `Job is ${job.status}, not running` }, { status: 400, headers: corsHeaders });
          }
          // Abort the running process via shared manager and update DB
          const { abortJob: doAbort } = await import("./archive/manager.ts");
          doAbort(body.jobId);
          store.updateArchiveJobStatus(body.jobId, "paused", {
            processedMessages: job.processed_messages,
          });
          return addHeaders(Response.json({ ok: true, status: "paused" }), corsHeaders);
        }

        // Route: POST /api/archive/resume — resume a paused job
        if (url.pathname === "/api/archive/resume" && method === "POST") {
          const auth = resolveGuildFromBearerToken(req, store);
          if ("error" in auth) {
            return Response.json({ error: auth.error }, { status: auth.status, headers: corsHeaders });
          }
          if (!discordClient) return Response.json({ error: "Discord not connected" }, { status: 503, headers: corsHeaders });

          const body = (await req.json()) as {
            jobId: string;
            rehostAttachments?: boolean;
            preserveEmbeds?: boolean;
          };
          if (!body.jobId) {
            return Response.json({ error: "jobId is required" }, { status: 400, headers: corsHeaders });
          }
          const job = store.getArchiveJob(body.jobId);
          if (!job || job.guild_id !== auth.guildId) {
            return Response.json({ error: "Job not found" }, { status: 404, headers: corsHeaders });
          }
          if (job.status !== "paused") {
            return Response.json({ error: `Job is ${job.status}, not paused` }, { status: 400, headers: corsHeaders });
          }

          const { registerJob: regJob2, unregisterJob: unregJob2 } = await import("./archive/manager.ts");

          if (job.direction === "export") {
            const { exportDiscordChannel } = await import("./archive/export.ts");
            const signal = regJob2(body.jobId);
            exportDiscordChannel(discordClient, store, body.jobId, job.discord_channel_id, signal).then(() => {
              unregJob2(body.jobId);
            }).catch((err) => {
              unregJob2(body.jobId);
              console.error("[archive-api] Export resume failed:", err);
            });
          } else if (job.direction === "import" && job.stoat_channel_id) {
            const { importToStoat } = await import("./archive/import.ts");
            const signal = regJob2(body.jobId);
            importToStoat(stoatClient, store, body.jobId, job.stoat_channel_id, signal, undefined, {
              rehostAttachments: body.rehostAttachments ?? false,
              reconstructReplies: true,
              preserveEmbeds: body.preserveEmbeds ?? false,
            }).then(() => {
              unregJob2(body.jobId);
            }).catch((err) => {
              unregJob2(body.jobId);
              console.error("[archive-api] Import resume failed:", err);
            });
          }

          return addHeaders(Response.json({ ok: true, status: "resumed" }), corsHeaders);
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
    cancelAllPending(); // reject any in-flight approval promises
    server.stop();
    stoatWs.disconnect();
    discordClient.destroy();
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Extract guild ID from a Bearer token in the Authorization header.
 * Returns the guild ID if the token is valid, null otherwise.
 */
function resolveGuildFromBearerToken(
  req: Request,
  store: Store
): { guildId: string } | { error: string; status: number } {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "Authorization header with Bearer token required", status: 401 };
  }
  const token = authHeader.slice(7);
  const link = store.getServerLinkByToken(token);
  if (!link) {
    return { error: "Invalid API token", status: 401 };
  }
  return { guildId: link.discord_guild_id };
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
