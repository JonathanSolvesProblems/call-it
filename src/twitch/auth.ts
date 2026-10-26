import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TWITCH_SCOPES } from "../config.js";

export interface TwitchToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string[];
  token_type: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
}

interface DeviceResponse {
  device_code: string;
  expires_in: number;
  interval: number;
  user_code: string;
  verification_uri: string;
}

const ID_URL = "https://id.twitch.tv/oauth2";

export class TwitchAuth {
  constructor(private readonly clientId: string, private readonly tokenPath: string) {}

  async getToken(): Promise<TwitchToken> {
    const saved = await this.readToken();
    if (saved) {
      if (saved.expires_at > Date.now() + 60_000) return saved;
      return this.refresh(saved.refresh_token);
    }
    return this.deviceFlow();
  }

  async refresh(refreshToken: string): Promise<TwitchToken> {
    const response = await fetch(`${ID_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(`Twitch token refresh failed (${response.status}): ${errorMessage(body)}`);
    return this.save(body as TokenResponse);
  }

  private async deviceFlow(): Promise<TwitchToken> {
    const response = await fetch(`${ID_URL}/device`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, scopes: TWITCH_SCOPES.join(" ") }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(`Twitch device authorization failed (${response.status}): ${errorMessage(body)}`);
    const device = body as DeviceResponse;
    console.log(`Authorize Call It at ${device.verification_uri} with code ${device.user_code}`);
    const expiresAt = Date.now() + device.expires_in * 1000;
    let interval = Math.max(device.interval, 1) * 1000;
    while (Date.now() < expiresAt) {
      await delay(interval);
      const tokenResponse = await fetch(`${ID_URL}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const tokenBody: unknown = await tokenResponse.json();
      if (tokenResponse.ok) return this.save(tokenBody as TokenResponse);
      const message = errorMessage(tokenBody);
      if (message === "authorization_pending") continue;
      if (message === "slow_down") {
        interval += 5000;
        continue;
      }
      throw new Error(`Twitch device authorization failed: ${message}`);
    }
    throw new Error("Twitch device authorization expired. Restart npm run live to request a new code.");
  }

  private async readToken(): Promise<TwitchToken | undefined> {
    try {
      return JSON.parse(await readFile(this.tokenPath, "utf8")) as TwitchToken;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async save(token: TokenResponse): Promise<TwitchToken> {
    const saved: TwitchToken = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + token.expires_in * 1000,
      scope: token.scope,
      token_type: token.token_type,
    };
    await mkdir(dirname(this.tokenPath), { recursive: true });
    await writeFile(this.tokenPath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    return saved;
  }
}

function errorMessage(value: unknown): string {
  if (typeof value === "object" && value !== null && "message" in value && typeof value.message === "string") return value.message;
  if (typeof value === "object" && value !== null && "error" in value && typeof value.error === "string") return value.error;
  return "unknown error";
}
