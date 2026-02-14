/** Stoat/Revolt API type definitions matching the REST API schema */

// --- Core entities ---

export interface User {
  _id: string;
  username: string;
  discriminator: string;
  display_name?: string;
  avatar?: AutumnResource;
  badges?: number;
  status?: UserStatus;
  flags?: number;
  bot?: BotInfo;
  online?: boolean;
}

export interface BotInfo {
  owner: string;
}

export interface UserStatus {
  text?: string;
  presence?: "Online" | "Idle" | "Focus" | "Busy" | "Invisible";
}

export interface AutumnResource {
  _id: string;
  tag: string;
  filename: string;
  metadata: {
    type: string;
    width?: number;
    height?: number;
  };
  content_type: string;
  size: number;
}

export interface Server {
  _id: string;
  owner: string;
  name: string;
  description?: string;
  channels: string[];
  categories?: Category[];
  system_messages?: SystemMessages;
  roles?: Record<string, Role>;
  default_permissions: number;
  icon?: AutumnResource;
  banner?: AutumnResource;
  flags?: number;
  nsfw?: boolean;
  analytics?: boolean;
  discoverable?: boolean;
}

export interface Category {
  id: string;
  title: string;
  channels: string[];
}

export interface SystemMessages {
  user_joined?: string;
  user_left?: string;
  user_kicked?: string;
  user_banned?: string;
}

export interface Role {
  name: string;
  permissions: PermissionsPair;
  colour?: string;
  hoist?: boolean;
  rank?: number;
}

/** Revolt permission pair: { a: allowed, d: denied } */
export interface PermissionsPair {
  a: number;
  d: number;
}

export type ChannelType =
  | "SavedMessages"
  | "DirectMessage"
  | "Group"
  | "TextChannel"
  | "VoiceChannel";

export interface Channel {
  _id: string;
  channel_type: ChannelType;
  server?: string;
  name?: string;
  description?: string;
  icon?: AutumnResource;
  default_permissions?: PermissionsPair;
  role_permissions?: Record<string, PermissionsPair>;
  nsfw?: boolean;
  last_message_id?: string;
  // DM/Group specific
  recipients?: string[];
  user?: string;
  owner?: string;
  active?: boolean;
}

export interface Message {
  _id: string;
  nonce?: string;
  channel: string;
  author: string;
  content?: string;
  attachments?: AutumnResource[];
  embeds?: Embed[];
  replies?: string[];
  edited?: string;
  masquerade?: Masquerade;
  // Push payload includes user object
  user?: User;
}

export interface Masquerade {
  name?: string;
  avatar?: string;
  colour?: string;
}

export interface Embed {
  type: string;
  url?: string;
  title?: string;
  description?: string;
  icon_url?: string;
  colour?: string;
}

export interface Member {
  _id: {
    server: string;
    user: string;
  };
  joined_at: string;
  nickname?: string;
  avatar?: AutumnResource;
  roles?: string[];
  timeout?: string;
}

// --- API request/response types ---

export interface CreateServerRequest {
  name: string;
  description?: string;
  nsfw?: boolean;
}

export interface CreateServerResponse {
  server: Server;
  channels: Channel[];
}

export interface CreateChannelRequest {
  type: "Text" | "Voice";
  name: string;
  description?: string;
  nsfw?: boolean;
}

export interface EditServerRequest {
  name?: string;
  description?: string;
  icon?: string;
  banner?: string;
  categories?: Category[];
  system_messages?: SystemMessages;
  nsfw?: boolean;
  discoverable?: boolean;
  analytics?: boolean;
}

export interface EditChannelRequest {
  name?: string;
  description?: string;
  icon?: string;
  nsfw?: boolean;
  archived?: boolean;
}

export interface CreateRoleResponse {
  id: string;
  role: Role;
}

export interface EditRoleRequest {
  name?: string;
  colour?: string;
  hoist?: boolean;
  rank?: number;
}

export interface SendMessageRequest {
  content?: string;
  nonce?: string;
  attachments?: string[];
  replies?: Array<{ id: string; mention: boolean }>;
  embeds?: Embed[];
  masquerade?: Masquerade;
}

export interface MessageQuery {
  limit?: number;
  before?: string;
  after?: string;
  sort?: "Latest" | "Oldest" | "Relevance";
  nearby?: string;
  include_users?: boolean;
}

export interface BulkMessagesResponse {
  messages: Message[];
  users?: User[];
  members?: Member[];
}

// --- WebSocket (Bonfire) event types ---

export type BonfireEvent =
  | { type: "Authenticated" }
  | { type: "Ready"; users: User[]; servers: Server[]; channels: Channel[]; members: Member[]; emojis?: unknown[] }
  | { type: "Pong"; data: number }
  | { type: "Message"; message: Message } // alias for the event — raw has no wrapper
  | BonfireMessageEvent
  | BonfireMessageUpdateEvent
  | BonfireMessageDeleteEvent;

export interface BonfireMessageEvent {
  type: "Message";
  // The message fields are at top level in the event
  _id: string;
  channel: string;
  author: string;
  content?: string;
  attachments?: AutumnResource[];
  embeds?: Embed[];
  masquerade?: Masquerade;
  replies?: string[]; // Array of message IDs this message replies to
}

export interface BonfireMessageUpdateEvent {
  type: "MessageUpdate";
  id: string;
  channel: string;
  data: Partial<Message>;
}

export interface BonfireMessageDeleteEvent {
  type: "MessageDelete";
  id: string;
  channel: string;
}

// --- Revolt permission bits (matching the Android app's PermissionBit) ---

export const PermissionBit = {
  // Server permissions
  ManageChannel: 1n << 0n,
  ManageServer: 1n << 1n,
  ManagePermissions: 1n << 2n,
  ManageRole: 1n << 3n,
  ManageCustomisation: 1n << 4n,
  KickMembers: 1n << 6n,
  BanMembers: 1n << 7n,
  TimeoutMembers: 1n << 36n,
  AssignRoles: 1n << 8n,
  ChangeNickname: 1n << 9n,
  ManageNicknames: 1n << 10n,
  ChangeAvatar: 1n << 11n,
  RemoveAvatars: 1n << 12n,

  // Channel permissions
  ViewChannel: 1n << 20n,
  ReadMessageHistory: 1n << 25n,
  SendMessage: 1n << 22n,
  ManageMessages: 1n << 23n,
  ManageWebhooks: 1n << 24n,
  InviteOthers: 1n << 21n,
  SendEmbeds: 1n << 26n,
  UploadFiles: 1n << 27n,
  Masquerade: 1n << 28n,
  React: 1n << 29n,
  Connect: 1n << 30n,
  Speak: 1n << 31n,
  Video: 1n << 32n,
  MuteMembers: 1n << 33n,
  DeafenMembers: 1n << 34n,
  MoveMembers: 1n << 35n,
} as const;
