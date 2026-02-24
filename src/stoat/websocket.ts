/** Stoat/Revolt Bonfire WebSocket client for realtime events */

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
  private ws: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private livenessInterval: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private lastEventAt = 0;
  private pongCount = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private shouldReconnect = true;
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

  constructor(token: string, wsUrl: string) {
    this.token = token;
    this.wsUrl = wsUrl;
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

  /** Check if WebSocket is currently connected */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Connect to the Bonfire WebSocket */
  connect(): void {
    this.shouldReconnect = true;
    const url = `${this.wsUrl}?format=json`;
    console.log(`[stoat-ws] Connecting to ${url}`);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log("[stoat-ws] Connected, authenticating...");
      this.reconnectAttempts = 0;
      // Send authentication
      this.ws?.send(
        JSON.stringify({ type: "Authenticate", token: this.token })
      );
    };

    this.ws.onmessage = (event) => {
      try {
        const raw = event.data as string;
        const data = JSON.parse(raw);
        // Debug: log every raw event type received
        if (data.type !== "Pong") {
          console.log(`[stoat-ws] <<< ${data.type} (${raw.length} bytes)`);
        }
        this.handleEvent(data);
      } catch (e) {
        console.error("[stoat-ws] Failed to parse message:", e);
      }
    };

    // Bun WebSocket may not auto-respond to RFC 6455 ping frames.
    // Attach a low-level ping handler if available (ws-compatible API).
    const wsAny = this.ws as any;
    if (typeof wsAny.on === "function") {
      wsAny.on("ping", (data: Buffer) => {
        console.log("[stoat-ws] Received RFC 6455 ping, sending pong");
        wsAny.pong?.(data);
      });
    }

    this.ws.onclose = (event) => {
      console.log(
        `[stoat-ws] Disconnected (code=${event.code}, reason=${event.reason})`
      );
      this.stopPing();
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (error) => {
      console.error("[stoat-ws] Error:", error);
    };
  }

  /** Gracefully disconnect */
  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPing();
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

        // Subscribe to each server for full event delivery (Bonfire protocol)
        for (const server of servers) {
          const subMsg = JSON.stringify({ type: "Subscribe", server_id: server._id });
          this.ws?.send(subMsg);
          console.log(`[stoat-ws] Subscribed to server: ${server.name} (${server._id})`);
        }

        for (const handler of this.handlers.ready) {
          handler(data);
        }
        break;
      }

      case "Pong":
        this.lastPongAt = Date.now();
        this.pongCount = (this.pongCount ?? 0) + 1;
        // Log every 10th pong (~5 min) to confirm connection is alive
        if (this.pongCount % 10 === 0) {
          console.log(`[stoat-ws] Pong #${this.pongCount} — connection alive`);
        }
        break;

      case "Message": {
        const msg = data as unknown as BonfireMessageEvent;
        console.log(
          `[stoat-ws] Message in ${msg.channel} from ${msg.author}` +
            (msg.masquerade ? " [masq]" : "") +
            (msg.content ? ` — "${msg.content.slice(0, 80)}"` : " (no content)")
        );
        for (const handler of this.handlers.message) {
          handler(msg);
        }
        break;
      }

      case "MessageUpdate":
        for (const handler of this.handlers.messageUpdate) {
          handler(data as unknown as BonfireMessageUpdateEvent);
        }
        break;

      case "MessageDelete":
        for (const handler of this.handlers.messageDelete) {
          handler(data as unknown as BonfireMessageDeleteEvent);
        }
        break;

      case "MessageReact":
        for (const handler of this.handlers.messageReact) {
          handler(data as unknown as BonfireMessageReactEvent);
        }
        break;

      case "MessageUnreact":
        for (const handler of this.handlers.messageUnreact) {
          handler(data as unknown as BonfireMessageUnreactEvent);
        }
        break;

      case "ChannelStartTyping":
        for (const handler of this.handlers.channelStartTyping) {
          handler(data as unknown as BonfireChannelStartTypingEvent);
        }
        break;

      case "ChannelUpdate":
        for (const handler of this.handlers.channelUpdate) {
          handler(data as unknown as BonfireChannelUpdateEvent);
        }
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
      if (this.ws?.readyState === WebSocket.OPEN) {
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
