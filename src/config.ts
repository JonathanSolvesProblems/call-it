import { join } from "node:path";

export const TWITCH_SCOPES = [
  "user:read:chat",
  "user:write:chat",
  "user:bot",
  "channel:bot",
  "clips:edit",
  "channel:manage:broadcast",
  "channel:read:ads",
  "channel:manage:predictions",
  "channel:read:predictions",
] as const;

export interface Config {
  twitchClientId: string;
  tokenPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const twitchClientId = env.TWITCH_CLIENT_ID?.trim();
  if (!twitchClientId) {
    throw new Error("Missing TWITCH_CLIENT_ID. Add your Twitch app Client ID to .env.");
  }
  return { twitchClientId, tokenPath: join(process.cwd(), "data", "token.json") };
}

