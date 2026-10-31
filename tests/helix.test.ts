import { afterEach, describe, expect, it, vi } from "vitest";
import { HelixClient } from "../src/twitch/helix.js";
import type { TwitchAuth } from "../src/twitch/auth.js";

afterEach(() => vi.unstubAllGlobals());

describe("Helix chat messages", () => {
  it("returns the message id when Twitch sends the chat message", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ message_id: "message-1", is_sent: true, drop_reason: null }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const auth = { getToken: vi.fn().mockResolvedValue({ access_token: "token", refresh_token: "refresh" }) } as unknown as TwitchAuth;
    const client = new HelixClient("client", auth);

    await expect(client.sendChatMessage("broadcaster", "sender", "hello")).resolves.toBe("message-1");
    expect(fetch).toHaveBeenCalledWith("https://api.twitch.tv/helix/chat/messages", expect.objectContaining({ method: "POST" }));
  });

  it("logs Twitch drop reasons and treats dropped messages as unsent", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ message_id: "", is_sent: false, drop_reason: { code: "user_banned", message: "The sender is banned." } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const auth = { getToken: vi.fn().mockResolvedValue({ access_token: "token", refresh_token: "refresh" }) } as unknown as TwitchAuth;
    const client = new HelixClient("client", auth);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(client.sendChatMessage("broadcaster", "sender", "hello")).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith("Twitch dropped chat message: The sender is banned.");
  });
});
