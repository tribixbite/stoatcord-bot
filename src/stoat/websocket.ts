/** Stoat/Revolt Bonfire WebSocket client for realtime events */

import WS from "ws";

import type {
  BonfireMessageEvent,
  BonfireMessageUpdateEvent,
  BonfireMessageDeleteEvent,
  BonfireMessageReactEvent,
  BonfireMessageUnreactEvent,
  BonfireChannelStartTypingEvent,
  BonfireChannelUpdateEvent,
} from "./types.ts";

type MessageHandler = (event: BonfireMessageEvent) => void;
type MessageUpdateHandler = (event: BonfireMessageUpdateEvent) => void;
type MessageDeleteHandler = (event: BonfireMessageDeleteEvent) => void;
type MessageReactHandler = (event: BonfireMessageReactEvent) => void;
type MessageUnreactHandler = (event: BonfireMessageUnreactEvent) => void;
type ChannelStartTypingHandler = (event: BonfireChannelStartTypingEvent) => void;
type ChannelUpdateHandler = (event: BonfireChannelUpdateEvent) => void;
type ReadyHandler = (data: unknown) => void;

interface EventHandlers {
  message: MessageHandler[];
  messageUpdate: MessageUpdateHandler[];
  messageDelete: MessageDeleteHandler[];
  messageReact: MessageReactHandler[];
  messageUnreact: MessageUnreactHandler[];
  channelStartTyping: ChannelStartTypingHandler[];
  channelUpdate: ChannelUpdateHandler[];
  ready: ReadyHandler[];
}

export class StoatWebSocket {
  private token: string;
  private wsUrl: string;
  private apiBase: string;
  private ws: WS | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private livenessInterval: ReturnType<typeof setInterval> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private lastEventAt = 0;
  private pongCount = 0;
  private messageCount = 0;
  private pollMessageCount = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private shouldReconnect = true;
  /** Channel IDs from Ready payload — used for REST polling fallback */
  private channelIds: string[] = [];
  /** Track last seen message ID per channel to avoid reprocessing */
  private lastSeenMessageId = new Map<string, string>();
  /** Set of message IDs already processed (via WS or poll) to prevent duplicates */
  private processedMessages = new Set<string>();
  /** Bot's own user ID (from Ready payload or auth) */
  private botUserId = "";
  private handlers: EventHandlers = {
    message: [],
    messageUpdate: [],
    messageDelete: [],
    messageReact: [],
    messageUnreact: [],
    channelStartTyping: [],
    channelUpdate: [],
    ready: [],
  };

  constructor(token: string, wsUrl: string, apiBase?: string) {
    this.token = token;
    this.wsUrl = wsUrl;
    this.apiBase = apiBase || "https://stoat.chat/api";
  }

  /** Set the bot's user ID (called from index.ts after API auth) */
  setBotUserId(id: string): void {
    this.botUserId = id;
  }

  /** Register event handler */
  on(event: "message", handler: MessageHandler): void;
  on(event: "messageUpdate", handler: MessageUpdateHandler): void;
  on(event: "messageDelete", handler: MessageDeleteHandler): void;
  on(event: "messageReact", handler: MessageReactHandler): void;
  on(event: "messageUnreact", handler: MessageUnreactHandler): void;
  on(event: "channelStartTyping", handler: ChannelStartTypingHandler): void;
  on(event: "channelUpdate", handler: ChannelUpdateHandler): void;
  on(event: "ready", handler: ReadyHandler): void;
  on(event: keyof EventHandlers, handler: (...args: any[]) => void): void {
    (this.handlers[event] as ((...args: any[]) => void)[]).push(handler);
  }

  /** Safely invoke all handlers for an event, catching sync and async errors */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private safeDispatch<T>(eventName: string, handlers: ((arg: T) => any)[], arg: T): void {
    for (const handler of handlers) {
      try {
        const result = handler(arg);
        // Catch async handler rejections (handlers may return Promise)
        if (result && typeof result.catch === "function") {
          result.catch((err: unknown) =>
            console.error(`[stoat-ws] Async error in ${eventName} handler:`, err)
          );
        }
      } catch (err) {
        console.error(`[stoat-ws] Error in ${eventName} handler:`, err);
      }
    }
  }

  /** Check if WebSocket is currently connected */
  isConnected(): boolean {
    return this.ws?.readyState === WS.OPEN;
  }

  /** Debug state for diagnostics endpoint */
  getDebugState(): Record<string, unknown> {
    return {
      connected: this.ws?.readyState === WS.OPEN,
      readyState: this.ws?.readyState ?? -1,
      pongCount: this.pongCount,
      lastPongAgo: this.lastPongAt > 0 ? Math.round((Date.now() - this.lastPongAt) / 1000) : -1,
      lastEventAgo: this.lastEventAt > 0 ? Math.round((Date.now() - this.lastEventAt) / 1000) : -1,
      reconnectAttempts: this.reconnectAttempts,
      messageCount: this.messageCount,
      pollMessageCount: this.pollMessageCount,
      polledChannels: this.channelIds.length,
    };
  }

  /** Connect to the Bonfire WebSocket */
  connect(): void {
    this.shouldReconnect = true;
    const url = `${this.wsUrl}?format=json`;
    console.log(`[stoat-ws] Connecting to ${url} (using ws library)`);

    this.ws = new WS(url);

    this.ws.on("open", () => {
      console.log("[stoat-ws] Connected, authenticating...");
      this.reconnectAttempts = 0;
      // Send authentication
      this.ws?.send(
        JSON.stringify({ type: "Authenticate", token: this.token })
      );
    });

    this.ws.on("message", (data: WS.Data) => {
      try {
        const raw = typeof data === "string" ? data : data.toString();
        const parsed = JSON.parse(raw);
        // Debug: log every raw event type received (including Pong for first 5)
        if (parsed.type !== "Pong" || this.pongCount < 5) {
          console.log(`[stoat-ws] <<< ${parsed.type} (${raw.length} bytes)${
            parsed.type === "Message" ? ` ch=${parsed.channel} from=${parsed.author}` : ""
          }`);
        }
        this.handleEvent(parsed);
      } catch (e) {
        console.error("[stoat-ws] Failed to parse message:", e);
      }
    });

    // Respond to RFC 6455 ping frames to keep connection alive
    this.ws.on("ping", (data: Buffer) => {
      console.log("[stoat-ws] Received RFC 6455 ping, sending pong");
      this.ws?.pong(data);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      console.log(
        `[stoat-ws] Disconnected (code=${code}, reason=${reason.toString()})`
      );
      this.stopPing();
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (error: Error) => {
      console.error("[stoat-ws] Error:", error.message);
    });
  }

  /** Gracefully disconnect */
  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPing();
    this.stopPolling();
    this.ws?.close(1000, "Shutting down");
    this.ws = null;
  }

  private handleEvent(data: { type: string; [key: string]: unknown }): void {
    this.lastEventAt = Date.now();
    switch (data.type) {
      case "Authenticated":
        console.log("[stoat-ws] Authenticated successfully");
        this.startPing();
        break;

      case "Ready": {
        // Log server/channel count and names from Ready payload for debugging
        const servers = (data as any).servers ?? [];
        const channels = (data as any).channels ?? [];
        const serverNames = servers.map((s: any) => `${s.name} (${s._id})`).join(", ");
        console.log(
          `[stoat-ws] Ready — ${servers.length} server(s): ${serverNames}`
        );
        console.log(
          `[stoat-ws] Ready — ${channels.length} channel(s) subscribed`
        );

        // Capture channel IDs for REST polling fallback and extract bot user ID
        this.channelIds = channels.map((c: any) => c._id || c);
        const users = (data as any).users ?? [];
        for (const u of users) {
          if (u.bot) {
            this.botUserId = u._id;
            break;
          }
        }

        // Subscribe to each server (required by Bonfire protocol for channel events)
        for (const server of servers) {
          const subMsg = JSON.stringify({ type: "Subscribe", server_id: server._id });
          this.ws?.send(subMsg);
          console.log(`[stoat-ws] Subscribed to server: ${server.name} (${server._id})`);
        }

        // Start REST polling fallback for message detection
        this.startPolling();

        this.safeDispatch("ready", this.handlers.ready, data);
        break;
      }

      case "Pong":
        this.lastPongAt = Date.now();
        this.pongCount = (this.pongCount ?? 0) + 1;
        if (this.pongCount % 10 === 0) {
          console.log(`[stoat-ws] Pong #${this.pongCount} — connection alive`);
        }
        break;

      case "Message": {
        const msg = data as unknown as BonfireMessageEvent;
        // Deduplicate: skip if already processed by WS or REST poll
        if (this.processedMessages.has(msg._id)) break;
        this.processedMessages.add(msg._id);
        this.messageCount++;
        console.log(
          `[stoat-ws] Message #${this.messageCount} in ${msg.channel} from ${msg.author}` +
            (msg.masquerade ? " [masq]" : "") +
            (msg.content ? ` — "${msg.content.slice(0, 80)}"` : " (no content)")
        );
        // Update last seen for polling
        this.lastSeenMessageId.set(msg.channel, msg._id);
        this.safeDispatch("message", this.handlers.message, msg);
        break;
      }

      case "MessageUpdate":
        this.safeDispatch("messageUpdate", this.handlers.messageUpdate, data as unknown as BonfireMessageUpdateEvent);
        break;

      case "MessageDelete":
        this.safeDispatch("messageDelete", this.handlers.messageDelete, data as unknown as BonfireMessageDeleteEvent);
        break;

      case "MessageReact":
        this.safeDispatch("messageReact", this.handlers.messageReact, data as unknown as BonfireMessageReactEvent);
        break;

      case "MessageUnreact":
        this.safeDispatch("messageUnreact", this.handlers.messageUnreact, data as unknown as BonfireMessageUnreactEvent);
        break;

      case "ChannelStartTyping":
        this.safeDispatch("channelStartTyping", this.handlers.channelStartTyping, data as unknown as BonfireChannelStartTypingEvent);
        break;

      case "ChannelUpdate":
        this.safeDispatch("channelUpdate", this.handlers.channelUpdate, data as unknown as BonfireChannelUpdateEvent);
        break;

      default:
        // Log unhandled event types for debugging
        console.log(`[stoat-ws] Unhandled event: ${data.type}`);
        break;
    }
  }

  /** Send a ping every 30 seconds to keep the connection alive */
  private startPing(): void {
    this.stopPing();
    this.lastPongAt = Date.now();
    this.lastEventAt = Date.now();

    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WS.OPEN) {
        this.ws.send(JSON.stringify({ type: "Ping", data: Date.now() }));
      }
    }, 30_000);

    // Liveness monitor: warn if no events received for 90 seconds
    this.livenessInterval = setInterval(() => {
      const sincePong = Date.now() - this.lastPongAt;
      const sinceEvent = Date.now() - this.lastEventAt;
      if (sincePong > 90_000) {
        console.warn(
          `[stoat-ws] LIVENESS: No Pong in ${Math.round(sincePong / 1000)}s — connection may be dead`
        );
        // Force reconnect if no pong for 2+ minutes
        if (sincePong > 120_000) {
          console.warn("[stoat-ws] LIVENESS: Forcing reconnect due to missing Pong");
          this.ws?.close(4000, "Pong timeout");
        }
      } else if (sinceEvent > 90_000) {
        console.log(
          `[stoat-ws] LIVENESS: No events in ${Math.round(sinceEvent / 1000)}s (last Pong ${Math.round(sincePong / 1000)}s ago)`
        );
      }
    }, 30_000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = null;
    }
  }

  /**
   * REST API polling fallback — periodically checks channels for new messages.
   * Works around a Stoat Bonfire issue where bot WebSocket connections don't
   * receive Message events from other users in server channels.
   */
  private startPolling(): void {
    this.stopPolling();
    // Poll every 5 seconds — balances responsiveness vs API load
    const POLL_INTERVAL = 5_000;
    // Rotate through channels: poll a batch each cycle to spread API load
    const CHANNELS_PER_CYCLE = 10;
    let offset = 0;

    console.log(`[stoat-ws:poll] Starting REST poll fallback for ${this.channelIds.length} channels (every ${POLL_INTERVAL / 1000}s)`);

    this.pollInterval = setInterval(async () => {
      if (!this.channelIds.length) return;
      const batch: string[] = [];
      for (let i = 0; i < CHANNELS_PER_CYCLE && i < this.channelIds.length; i++) {
        const ch = this.channelIds[(offset + i) % this.channelIds.length];
        if (ch) batch.push(ch);
      }
      offset = (offset + CHANNELS_PER_CYCLE) % this.channelIds.length;

      for (const channelId of batch) {
        try {
          await this.pollChannel(channelId);
        } catch (err) {
          // Silently ignore poll errors — non-critical fallback
        }
      }
    }, POLL_INTERVAL);
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /** Poll a single channel for new messages via REST API */
  private async pollChannel(channelId: string): Promise<void> {
    const lastId = this.lastSeenMessageId.get(channelId);
    const url = lastId
      ? `${this.apiBase}/channels/${channelId}/messages?limit=10&after=${lastId}&sort=Latest`
      : `${this.apiBase}/channels/${channelId}/messages?limit=1&sort=Latest`;

    const resp = await fetch(url, {
      headers: { "x-bot-token": this.token },
    });
    if (!resp.ok) return;

    const messages = (await resp.json()) as any[];
    if (!messages.length) return;

    // Process messages in chronological order (API returns newest first)
    const sorted = messages.reverse();

    for (const msg of sorted) {
      // Skip if already processed
      if (this.processedMessages.has(msg._id)) continue;
      // Skip bot's own messages
      if (msg.author === this.botUserId) {
        this.lastSeenMessageId.set(channelId, msg._id);
        continue;
      }
      this.processedMessages.add(msg._id);
      this.pollMessageCount++;
      this.lastSeenMessageId.set(channelId, msg._id);

      console.log(
        `[stoat-ws:poll] Message from ${msg.author} in ${channelId}` +
          (msg.content ? ` — "${msg.content.slice(0, 80)}"` : " (no content)")
      );

      // Dispatch as if it came via WebSocket
      const event: BonfireMessageEvent = {
        type: "Message",
        _id: msg._id,
        channel: msg.channel || channelId,
        author: msg.author,
        content: msg.content,
        attachments: msg.attachments,
        embeds: msg.embeds,
        replies: msg.replies,
        masquerade: msg.masquerade,
      };
      this.messageCount++;
      this.safeDispatch("message", this.handlers.message, event);
    }

    // Prevent processedMessages set from growing unbounded
    if (this.processedMessages.size > 10000) {
      const entries = [...this.processedMessages];
      this.processedMessages = new Set(entries.slice(-5000));
    }
  }

  /** Exponential backoff reconnection */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        `[stoat-ws] Max reconnect attempts (${this.maxReconnectAttempts}) reached, giving up`
      );
      return;
    }

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      60_000
    );
    this.reconnectAttempts++;
    console.log(
      `[stoat-ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }
}
