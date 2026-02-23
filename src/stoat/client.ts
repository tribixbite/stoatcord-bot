/** Stoat/Revolt REST API client with rate limit handling */

import { sleep } from "../util.ts"; // re-exports Bun.sleep
import type {
  User,
  Server,
  Channel,
  Member,
  Message,
  CreateServerRequest,
  CreateServerResponse,
  CreateChannelRequest,
  EditServerRequest,
  EditChannelRequest,
  CreateRoleResponse,
  EditRoleRequest,
  SendMessageRequest,
  MessageQuery,
  BulkMessagesResponse,
  PermissionsPair,
  BanInfo,
  MemberListResponse,
  EmojiInfo,
  AutumnUploadResponse,
} from "./types.ts";

interface RateLimitState {
  remaining: number;
  resetAt: number; // ms timestamp
  bucket: string;
}

export class StoatClient {
  private token: string;
  private baseUrl: string;
  private autumnUrl: string;
  private rateLimits = new Map<string, RateLimitState>();

  constructor(token: string, baseUrl: string, autumnUrl?: string) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, ""); // strip trailing slash
    this.autumnUrl = (autumnUrl ?? "https://autumn.stoat.chat").replace(/\/$/, "");
  }

  // --- Auth ---

  async getSelf(): Promise<User> {
    return this.request<User>("GET", "/users/@me");
  }

  async fetchUser(userId: string): Promise<User> {
    return this.request<User>("GET", `/users/${userId}`);
  }

  // --- Servers ---

  async createServer(
    name: string,
    description?: string
  ): Promise<CreateServerResponse> {
    const body: CreateServerRequest = { name, description };
    return this.request<CreateServerResponse>("POST", "/servers/create", body);
  }

  async getServer(id: string): Promise<Server> {
    return this.request<Server>("GET", `/servers/${id}`);
  }

  async editServer(
    id: string,
    data: Partial<EditServerRequest>
  ): Promise<Server> {
    return this.request<Server>("PATCH", `/servers/${id}`, data);
  }

  async fetchMember(serverId: string, userId: string): Promise<Member> {
    return this.request<Member>("GET", `/servers/${serverId}/members/${userId}`);
  }

  // --- Channels ---

  async createChannel(
    serverId: string,
    data: CreateChannelRequest
  ): Promise<Channel> {
    return this.request<Channel>(
      "POST",
      `/servers/${serverId}/channels`,
      data
    );
  }

  async getChannel(id: string): Promise<Channel> {
    return this.request<Channel>("GET", `/channels/${id}`);
  }

  async editChannel(
    id: string,
    data: Partial<EditChannelRequest>
  ): Promise<Channel> {
    return this.request<Channel>("PATCH", `/channels/${id}`, data);
  }

  async getMessages(
    channelId: string,
    params: MessageQuery = {}
  ): Promise<BulkMessagesResponse> {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.before) qs.set("before", params.before);
    if (params.after) qs.set("after", params.after);
    if (params.sort) qs.set("sort", params.sort);
    if (params.nearby) qs.set("nearby", params.nearby);
    if (params.include_users) qs.set("include_users", "true");
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return this.request<BulkMessagesResponse>(
      "GET",
      `/channels/${channelId}/messages${query}`
    );
  }

  async sendMessage(
    channelId: string,
    content: string,
    opts?: Partial<Omit<SendMessageRequest, "content">>
  ): Promise<Message> {
    const body: SendMessageRequest = { content, ...opts };
    return this.request<Message>(
      "POST",
      `/channels/${channelId}/messages`,
      body
    );
  }

  /** Edit a message's content */
  async editMessage(
    channelId: string,
    messageId: string,
    content: string
  ): Promise<Message> {
    return this.request<Message>(
      "PATCH",
      `/channels/${channelId}/messages/${messageId}`,
      { content }
    );
  }

  /** Delete a message */
  async deleteMessage(
    channelId: string,
    messageId: string
  ): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/channels/${channelId}/messages/${messageId}`
    );
  }

  // --- Roles ---

  async createRole(
    serverId: string,
    name: string
  ): Promise<CreateRoleResponse> {
    return this.request<CreateRoleResponse>(
      "POST",
      `/servers/${serverId}/roles`,
      { name }
    );
  }

  async editRole(
    serverId: string,
    roleId: string,
    data: Partial<EditRoleRequest>
  ): Promise<{ role: unknown }> {
    return this.request<{ role: unknown }>(
      "PATCH",
      `/servers/${serverId}/roles/${roleId}`,
      data
    );
  }

  async setRolePermissions(
    serverId: string,
    roleId: string,
    perms: PermissionsPair
  ): Promise<void> {
    await this.request<unknown>(
      "PUT",
      `/servers/${serverId}/permissions/${roleId}`,
      { permissions: perms }
    );
  }

  async setDefaultPermissions(
    serverId: string,
    permissions: number
  ): Promise<void> {
    await this.request<unknown>(
      "PUT",
      `/servers/${serverId}/permissions/default`,
      { permissions }
    );
  }

  // --- Bans ---

  async fetchBans(serverId: string): Promise<BanInfo[]> {
    return this.request<BanInfo[]>("GET", `/servers/${serverId}/bans`);
  }

  // --- Members ---

  async fetchMembers(serverId: string): Promise<MemberListResponse> {
    return this.request<MemberListResponse>(
      "GET",
      `/servers/${serverId}/members`
    );
  }

  // --- Emoji ---

  async listEmoji(serverId: string): Promise<EmojiInfo[]> {
    // Fetch all server emoji — Revolt returns them from the server object's emojis
    return this.request<EmojiInfo[]>(
      "GET",
      `/servers/${serverId}/emojis`
    );
  }

  async createEmoji(
    name: string,
    parentServerId: string,
    autumnId: string
  ): Promise<EmojiInfo> {
    return this.request<EmojiInfo>(
      "PUT",
      `/custom/emoji/${autumnId}`,
      { name, parent: { type: "Server", id: parentServerId } }
    );
  }

  // --- File uploads (Autumn CDN) ---

  /**
   * Upload a file to the Autumn CDN.
   * @param tag - Autumn tag: "attachments", "icons", "banners", "emojis", "avatars"
   * @param fileBuffer - Raw file data
   * @param filename - Filename with extension
   * @returns The Autumn file ID for use in API calls
   */
  async uploadFile(
    tag: string,
    fileBuffer: Buffer | Uint8Array,
    filename: string
  ): Promise<AutumnUploadResponse> {
    const formData = new FormData();
    const blob = new Blob([fileBuffer]);
    formData.append("file", blob, filename);

    const url = `${this.autumnUrl}/${tag}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-bot-token": this.token,
      },
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Autumn upload error: POST ${tag} → ${res.status} ${res.statusText}: ${text}`
      );
    }

    return (await res.json()) as AutumnUploadResponse;
  }

  // --- Channel permissions ---

  /**
   * Set role-specific permission overrides on a channel.
   * PUT /channels/{channel_id}/permissions/{role_id}
   */
  async setChannelRolePermissions(
    channelId: string,
    roleId: string,
    perms: PermissionsPair
  ): Promise<void> {
    await this.request<unknown>(
      "PUT",
      `/channels/${channelId}/permissions/${roleId}`,
      { permissions: perms }
    );
  }

  /**
   * Set default permission overrides on a channel.
   * PUT /channels/{channel_id}/permissions/default
   */
  async setChannelDefaultPermissions(
    channelId: string,
    perms: PermissionsPair
  ): Promise<void> {
    await this.request<unknown>(
      "PUT",
      `/channels/${channelId}/permissions/default`,
      { permissions: perms }
    );
  }

  // --- Internal: rate-limit-aware HTTP ---

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    // Derive a bucket key from the path (e.g. /servers/ABC/channels → servers)
    const bucket = this.deriveBucket(path);

    // Wait if rate-limited
    await this.waitForRateLimit(bucket);

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "x-bot-token": this.token,
      "User-Agent": "StoatcordBot/0.1.0 (Bun)",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // Track rate limit headers
    this.updateRateLimit(bucket, res.headers);

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
      console.warn(`[stoat] Rate limited on ${path}, waiting ${wait}ms`);
      await sleep(wait);
      return this.request<T>(method, path, body);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Stoat API error: ${method} ${path} → ${res.status} ${res.statusText}: ${text}`
      );
    }

    // Some endpoints return 204 No Content
    if (res.status === 204) {
      return undefined as T;
    }

    return (await res.json()) as T;
  }

  private deriveBucket(path: string): string {
    // /servers/{id}/channels → "server:{id}"
    // /channels/{id}/messages → "channel:{id}"
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "servers" && parts[1]) return `server:${parts[1]}`;
    if (parts[0] === "channels" && parts[1]) return `channel:${parts[1]}`;
    return "global";
  }

  private async waitForRateLimit(bucket: string): Promise<void> {
    const state = this.rateLimits.get(bucket);
    if (!state) return;
    if (state.remaining <= 0 && state.resetAt > Date.now()) {
      const wait = state.resetAt - Date.now() + 100; // +100ms buffer
      console.log(`[stoat] Waiting ${wait}ms for rate limit on ${bucket}`);
      await sleep(wait);
    }
  }

  private updateRateLimit(bucket: string, headers: Headers): void {
    const remaining = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset-after");
    if (remaining !== null) {
      this.rateLimits.set(bucket, {
        remaining: parseInt(remaining, 10),
        resetAt: reset
          ? Date.now() + parseInt(reset, 10) * 1000
          : Date.now() + 10000,
        bucket,
      });
    }
  }
}
