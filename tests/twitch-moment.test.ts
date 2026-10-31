import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatBetLedger } from "../src/bets/chat-ledger.js";
import { ChatBetService } from "../src/bets/chat-mode.js";
import { OverlayServer } from "../src/overlay/server.js";
import { HelixClient } from "../src/twitch/helix.js";
import type { TwitchAuth } from "../src/twitch/auth.js";
import { TwitchMomentRecorder } from "../src/twitch/moment-recorder.js";

afterEach(() => vi.unstubAllGlobals());

const token = { access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 60_000, scope: [], token_type: "bearer" };

describe("Twitch payout moments", () => {
  it("calls Create Clip and Create Stream Marker with their documented Helix requests", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      const body = String(url).endsWith("/clips?broadcaster_id=channel")
        ? { data: [{ id: "clip-1", edit_url: "https://clips.twitch.tv/clip-1/edit" }] }
        : { data: [{ id: "marker-1", position_seconds: 123, description: "Call It: Q -> Win" }] };
      return new Response(JSON.stringify(body), { status: 202 });
    }));
    const auth = { getToken: async () => token, refresh: vi.fn(async () => token) } as unknown as TwitchAuth;
    const helix = new HelixClient("client", auth);

    expect(await helix.createClip("channel")).toEqual({ id: "clip-1", edit_url: "https://clips.twitch.tv/clip-1/edit" });
    expect(await helix.createStreamMarker("channel", "Call It: Q -> Win" )).toMatchObject({ id: "marker-1", position_seconds: 123 });
    expect(calls.map(({ url }) => url)).toEqual([
      "https://api.twitch.tv/helix/clips?broadcaster_id=channel",
      "https://api.twitch.tv/helix/streams/markers",
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ user_id: "channel", description: "Call It: Q -> Win" });
  });

  it("records marker and clip after the payout announcement, then saves and exposes their details", async () => {
    const events: string[] = [];
    const helix = {
      createStreamMarker: vi.fn(async (_id: string, description: string) => { events.push(`marker:${description}`); return { id: "marker", position_seconds: 321, description }; }),
      createClip: vi.fn(async () => { events.push("clip:create"); return { id: "clip-42", edit_url: "https://clips.twitch.tv/clip-42/edit" }; }),
    } as unknown as HelixClient;
    const recorder = new TwitchMomentRecorder(helix, "channel", async (message) => { events.push(`chat:${message}`); }, () => true, (message) => events.push(`log:${message}`));
    const ledger = ChatBetLedger.inMemory();
    const service = new ChatBetService(ledger, async (message) => { events.push(`chat:${message}`); }, new OverlayServer(), recorder, () => true);
    await service.openBet({ question: "Will Anna win?", outcomes: ["Win", "Lose"], window_seconds: 30, reason: "The game starts." }, 10_000);
    events.length = 0;

    await service.resolveBet(0, "The result popup says Anna won.", "Anna won the game.", 40_000);

    expect(events[0]).toContain("chat:Win! No one bet on this one.");
    expect(events.slice(1)).toEqual([
      "marker:Call It: Will Anna win? -> Win",
      "clip:create",
      "chat:Clip: https://clips.twitch.tv/clip-42",
    ]);
    expect(ledger.currentBet).toMatchObject({ clipId: "clip-42", clipUrl: "https://clips.twitch.tv/clip-42", markerPositionSeconds: 321 });
    expect(service.overlayBet()).toMatchObject({ clipUrl: "https://clips.twitch.tv/clip-42" });
  });

  it("logs Twitch failures and keeps settlement without posting a failed clip link", async () => {
    const messages: string[] = [];
    const logs: string[] = [];
    const helix = {
      createStreamMarker: vi.fn(async () => { throw new Error("Twitch Helix /streams/markers failed (404): not live"); }),
      createClip: vi.fn(async () => { throw new Error("Twitch Helix /clips failed (429): rate limited"); }),
    } as unknown as HelixClient;
    const recorder = new TwitchMomentRecorder(helix, "channel", async (message) => { messages.push(message); }, () => true, (message) => logs.push(message));
    const service = new ChatBetService(ChatBetLedger.inMemory(), async (message) => { messages.push(message); }, new OverlayServer(), recorder, () => true, (message) => logs.push(message));
    await service.openBet({ question: "Will Anna win?", outcomes: ["Win", "Lose"], window_seconds: 30, reason: "The game starts." }, 10_000);

    await expect(service.resolveBet(0, "Visible result.", "Anna won.", 40_000)).resolves.toEqual({});

    expect(messages).toEqual([expect.stringContaining("BET:"), "Win! No one bet on this one."]);
    expect(logs).toEqual(["Call It stream marker failed (404).", "Call It clip creation failed (429)."]);
    expect(service.overlayBet()?.status).toBe("resolved");
  });
});
