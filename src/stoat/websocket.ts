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
        const data = JSON.parse(event.data as string);
        this.handleEvent(data);
      } catch (e) {
        console.error("[stoat-ws] Failed to parse message:", e);
      }
    };

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
    switch (data.type) {
      case "Authenticated":
        console.log("[stoat-ws] Authenticated successfully");
        this.startPing();
        break;

      case "Ready": {
        // Log server/channel count from Ready payload for debugging
        const servers = (data as any).servers ?? [];
        const channels = (data as any).channels ?? [];
        console.log(
          `[stoat-ws] Ready event received — ${servers.length} server(s), ${channels.length} channel(s)`
        );
        for (const handler of this.handlers.ready) {
          handler(data);
        }
        break;
      }

      case "Pong":
        // Expected response to our Ping
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
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "Ping", data: Date.now() }));
      }
    }, 30_000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
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
