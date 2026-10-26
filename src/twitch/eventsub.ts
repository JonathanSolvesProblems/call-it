import WebSocket from "ws";
import { HelixClient } from "./helix.js";

export interface ChatMessageEvent {
  broadcaster_user_id: string;
  chatter_user_id: string;
  chatter_user_login: string;
  message: { text: string };
  badges: Array<{ set_id: string; id: string }>;
  broadcaster_user_login: string;
}

export type EventSubMessage =
  | { type: "welcome"; sessionId: string; keepaliveSeconds: number }
  | { type: "keepalive" }
  | { type: "reconnect"; url: string }
  | { type: "revocation"; subscriptionType: string; status: string }
  | { type: "notification"; messageId?: string; subscriptionType: string; event: Record<string, unknown> }
  | { type: "unknown" };

export function parseEventSubMessage(raw: string | Buffer): EventSubMessage {
  let payload: any;
  try { payload = JSON.parse(raw.toString()); } catch { return { type: "unknown" }; }
  const messageType = payload?.metadata?.message_type;
  switch (messageType) {
    case "session_welcome":
      return { type: "welcome", sessionId: payload.payload.session.id, keepaliveSeconds: payload.payload.session.keepalive_timeout_seconds };
    case "session_keepalive": return { type: "keepalive" };
    case "session_reconnect": return { type: "reconnect", url: payload.payload.session.reconnect_url };
    case "revocation": return { type: "revocation", subscriptionType: payload.payload.subscription.type, status: payload.payload.subscription.status };
    case "notification": return {
      type: "notification",
      ...(typeof payload?.metadata?.message_id === "string" ? { messageId: payload.metadata.message_id } : {}),
      subscriptionType: payload.payload.subscription.type,
      event: payload.payload.event,
    };
    default: return { type: "unknown" };
  }
}

export interface EventSubHandlers {
  onChatMessage(event: ChatMessageEvent): Promise<void> | void;
  onStreamOnline(): Promise<void> | void;
  onStreamOffline(): Promise<void> | void;
  onAdBreak(): Promise<void> | void;
}

export class NotificationDeduper {
  private readonly ids = new Set<string>();
  private readonly orderedIds: string[] = [];

  constructor(private readonly capacity = 1000) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Notification dedupe capacity must be a positive integer.");
  }

  hasSeen(messageId: string): boolean {
    if (this.ids.has(messageId)) return true;
    this.ids.add(messageId);
    this.orderedIds.push(messageId);
    if (this.orderedIds.length > this.capacity) {
      const oldest = this.orderedIds.shift();
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return false;
  }
}

const SUBSCRIPTIONS = [
  "channel.chat.message",
  "stream.online",
  "stream.offline",
  "channel.ad_break.begin",
] as const;

export class EventSubClient {
  private stopped = false;
  private socket?: WebSocket;
  private readonly heartbeats = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private readonly notificationIds = new NotificationDeduper();

  constructor(
    private readonly helix: HelixClient,
    private readonly broadcasterId: string,
    private readonly userId: string,
    private readonly handlers: EventSubHandlers,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect("wss://eventsub.wss.twitch.tv/ws");
  }

  stop(): void {
    this.stopped = true;
    for (const heartbeat of this.heartbeats.values()) clearTimeout(heartbeat);
    this.heartbeats.clear();
    this.socket?.close();
  }

  private async connect(url: string, reconnecting = false): Promise<void> {
    const socket = new WebSocket(url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let welcomed = false;
      let keepaliveSeconds = 10;
      socket.on("message", (data) => {
        const message = parseEventSubMessage(data as Buffer);
        if (message.type === "welcome") keepaliveSeconds = message.keepaliveSeconds;
        this.armHeartbeat(socket, keepaliveSeconds);
        if (message.type === "welcome") {
          welcomed = true;
          if (!reconnecting) {
            void this.subscribe(message.sessionId).then(resolve, reject);
          } else resolve();
        } else if (message.type === "reconnect") {
          void this.connect(message.url, true).then(() => socket.close(1000, "reconnected"));
        } else if (message.type === "revocation") {
          console.error(`EventSub subscription revoked: ${message.subscriptionType} (${message.status})`);
        } else if (message.type === "notification") {
          if (message.messageId && this.notificationIds.hasSeen(message.messageId)) return;
          void this.dispatch(message.subscriptionType, message.event).catch((error: unknown) => console.error("EventSub handler failed", error));
        }
      });
      socket.on("error", (error) => { if (!welcomed) reject(error); else console.error("EventSub socket error", error); });
      socket.on("close", (code, reason) => {
        const heartbeat = this.heartbeats.get(socket);
        if (heartbeat) clearTimeout(heartbeat);
        this.heartbeats.delete(socket);
        if (!welcomed) reject(new Error(`EventSub closed before welcome (${code}): ${reason.toString()}`));
        if (!this.stopped && this.socket === socket) {
          console.warn("EventSub disconnected. Reconnecting in 2 seconds.");
          setTimeout(() => { if (!this.stopped) void this.connect("wss://eventsub.wss.twitch.tv/ws").catch(console.error); }, 2000);
        }
      });
    });
  }

  private async subscribe(sessionId: string): Promise<void> {
    for (const type of SUBSCRIPTIONS) {
      const condition = type === "channel.chat.message"
        ? { broadcaster_user_id: this.broadcasterId, user_id: this.userId }
        : { broadcaster_user_id: this.broadcasterId };
      await this.helix.createEventSubSubscription(type, condition, sessionId);
    }
    console.log(`EventSub subscriptions active: ${SUBSCRIPTIONS.join(", ")}`);
  }

  private async dispatch(type: string, event: Record<string, unknown>): Promise<void> {
    if (type === "channel.chat.message") {
      const chatMessage = event as unknown as ChatMessageEvent;
      if (chatMessage.chatter_user_id === this.userId) return;
      await this.handlers.onChatMessage(chatMessage);
    }
    if (type === "stream.online") await this.handlers.onStreamOnline();
    if (type === "stream.offline") await this.handlers.onStreamOffline();
    if (type === "channel.ad_break.begin") await this.handlers.onAdBreak();
  }

  private armHeartbeat(socket: WebSocket, seconds: number): void {
    const previous = this.heartbeats.get(socket);
    if (previous) clearTimeout(previous);
    const heartbeat = setTimeout(() => {
      console.error("EventSub keepalive timeout. Closing socket for reconnect.");
      socket.terminate();
    }, (seconds + 5) * 1000);
    this.heartbeats.set(socket, heartbeat);
  }
}
