import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEventSubMessage } from "../src/twitch/eventsub.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/eventsub-${name}.json`, import.meta.url)), "utf8");

describe("EventSub message parsing", () => {
  it("parses welcome, keepalive, reconnect and revocation samples", () => {
    expect(parseEventSubMessage(fixture("welcome"))).toEqual({ type: "welcome", sessionId: "sess-123", keepaliveSeconds: 10 });
    expect(parseEventSubMessage(fixture("keepalive"))).toEqual({ type: "keepalive" });
    expect(parseEventSubMessage(fixture("reconnect"))).toEqual({ type: "reconnect", url: "wss://eventsub.wss.twitch.tv?reconnect=true" });
    expect(parseEventSubMessage(fixture("revocation"))).toEqual({ type: "revocation", subscriptionType: "channel.chat.message", status: "authorization_revoked" });
  });

  it("parses notification samples", () => {
    expect(parseEventSubMessage(fixture("notification"))).toEqual({ type: "notification", subscriptionType: "stream.online", event: expect.objectContaining({ broadcaster_user_id: "42", id: "stream-1" }) });
  });

  it("returns unknown for malformed or unrecognized payloads", () => {
    expect(parseEventSubMessage("not-json")).toEqual({ type: "unknown" });
    expect(parseEventSubMessage(JSON.stringify({ metadata: { message_type: "future_message" } }))).toEqual({ type: "unknown" });
  });
});
