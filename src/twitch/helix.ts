import type { TwitchAuth, TwitchToken } from "./auth.js";

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  broadcaster_type: "" | "affiliate" | "partner";
}

export interface TwitchStream {
  id: string;
  user_id: string;
  type: string;
}

export interface TwitchClip { id: string; edit_url: string }
export interface TwitchStreamMarker { id: string; position_seconds: number; description: string }

export class HelixClient {
  private token?: TwitchToken;

  constructor(private readonly clientId: string, private readonly auth: TwitchAuth) {}

  async getUsers(login?: string): Promise<TwitchUser[]> {
    const query = login ? `?login=${encodeURIComponent(login)}` : "";
    return (await this.request<{ data: TwitchUser[] }>(`/users${query}`)).data;
  }

  async getStreams(userId: string): Promise<TwitchStream[]> {
    return (await this.request<{ data: TwitchStream[] }>(`/streams?user_id=${encodeURIComponent(userId)}`)).data;
  }

  async sendChatMessage(broadcasterId: string, senderId: string, message: string): Promise<string | undefined> {
    // Requires user:write:chat. Twitch accepts the broadcaster and sending user IDs.
    const response = await this.request<{ data: Array<{ message_id: string; is_sent?: boolean; drop_reason?: { code?: string; message?: string } | null }> }>("/chat/messages", {
      method: "POST",
      body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: senderId, message }),
    });
    const result = response.data[0];
    if (result?.is_sent === false) {
      const reason = result.drop_reason?.message ?? result.drop_reason?.code ?? "no reason provided";
      console.warn(`Twitch dropped chat message: ${reason}`);
      return undefined;
    }
    return result?.message_id;
  }

  async createClip(broadcasterId: string): Promise<TwitchClip | undefined> {
    // Requires user access token scope clips:edit.
    const response = await this.request<{ data: TwitchClip[] }>(`/clips?broadcaster_id=${encodeURIComponent(broadcasterId)}`, { method: "POST" });
    return response.data[0];
  }

  async createStreamMarker(userId: string, description: string): Promise<TwitchStreamMarker | undefined> {
    // Requires user access token scope channel:manage:broadcast.
    const response = await this.request<{ data: TwitchStreamMarker[] }>("/streams/markers", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, description: description.slice(0, 140) }),
    });
    return response.data[0];
  }

  async createEventSubSubscription(type: string, condition: Record<string, string>, sessionId: string): Promise<void> {
    await this.request("/eventsub/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        type,
        version: "1",
        condition,
        transport: { method: "websocket", session_id: sessionId },
      }),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    this.token ??= await this.auth.getToken();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`https://api.twitch.tv/helix${path}`, {
        ...init,
        headers: {
          "Client-Id": this.clientId,
          Authorization: `Bearer ${this.token.access_token}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
      if (response.status === 401 && attempt === 0) {
        this.token = await this.auth.refresh(this.token.refresh_token);
        continue;
      }
      if (!response.ok) throw new Error(`Twitch Helix ${path} failed (${response.status}): ${await response.text()}`);
      if (response.status === 204) return undefined as T;
      return await response.json() as T;
    }
    throw new Error(`Twitch Helix ${path} failed after token refresh`);
  }
}
