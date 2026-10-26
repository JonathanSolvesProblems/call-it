import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatBetLedger } from "../src/bets/chat-ledger.js";
import { ChatBetService } from "../src/bets/chat-mode.js";
import { OverlayServer } from "../src/overlay/server.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("chat bet deadlines", () => {
  it("locks when the betting window ends and refunds after the maximum bet duration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-chat-mode-"));
    directories.push(directory);
    const ledger = await ChatBetLedger.open(join(directory, "channel.json"));
    const messages: string[] = [];
    const service = new ChatBetService(ledger, async (message) => { messages.push(message); }, new OverlayServer());
    await service.openBet({ question: "Next boss?", outcomes: ["Down", "Survives"], window_seconds: 30, reason: "The fight is starting." }, 10_000);

    expect(await service.checkDeadlines(40_000, 900)).toBe("window_end");
    expect(ledger.currentBet?.status).toBe("locked");
    expect(messages.at(-1)).toContain("LOCKED:");
    expect(await service.checkDeadlines(910_000, 900)).toBe("timeout");
    expect(ledger.currentBet?.status).toBe("refunded");
    expect(messages.at(-1)).toContain("Refunded:");
  });
});
