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
  it("announces a resolved outcome when nobody placed a stake", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-empty-chat-mode-"));
    directories.push(directory);
    const ledger = await ChatBetLedger.open(join(directory, "channel.json"));
    const messages: string[] = [];
    const overlay = new OverlayServer();
    const service = new ChatBetService(ledger, async (message) => { messages.push(message); }, overlay);
    await service.openBet({ question: "Next boss?", outcomes: ["Down", "Survives"], window_seconds: 30, reason: "The boss appears." }, 10_000);

    await service.resolveBet(0, "The nameplate says Dead.", "The Tide Wisp went down.", 40_000);

    expect(ledger.currentBet?.status).toBe("resolved");
    expect(ledger.balance("nobody")).toBe(1000);
    expect(messages.at(-1)).toBe("Down! No one bet on this one.");
    expect(messages.some((message) => message.startsWith("LOCKED:"))).toBe(false);
    expect(overlay.getState().bet).toMatchObject({ status: "resolved", winningOutcomeIndex: 0 });
  });

  it("replies to a bet command without an open bet no more than once every 30 seconds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-no-bet-reply-"));
    directories.push(directory);
    const ledger = await ChatBetLedger.open(join(directory, "channel.json"));
    const messages: string[] = [];
    const service = new ChatBetService(ledger, async (message) => { messages.push(message); }, new OverlayServer());

    await service.handleBetMessage("m1", "viewer", "!1 50", 1000);
    await service.handleBetMessage("m2", "viewer", "!1 50", 20_000);
    await service.handleBetMessage("m3", "viewer", "!1 50", 31_000);

    expect(messages).toEqual(["No bet open right now", "No bet open right now"]);
  });

  it("restores the bet status when a proposed resolution is rejected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-restore-bet-"));
    directories.push(directory);
    const ledger = await ChatBetLedger.open(join(directory, "channel.json"));
    const service = new ChatBetService(ledger, async () => {}, new OverlayServer());
    await service.openBet({ question: "Boss defeated?", outcomes: ["Yes", "No"], window_seconds: 60, reason: "The boss appears." }, 1000);
    await service.lockBet("The fight is underway.", 31_000);
    const lockedAtMs = ledger.currentBet?.lockedAtMs;

    await service.restoreBetStatus("open");

    expect(ledger.currentBet?.status).toBe("open");
    expect(ledger.currentBet?.lockedAtMs).toBeUndefined();
    expect(lockedAtMs).toBe(31_000);
  });

  it("locks when the betting window ends and refunds after the maximum bet duration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-chat-mode-"));
    directories.push(directory);
    const ledger = await ChatBetLedger.open(join(directory, "channel.json"));
    const messages: string[] = [];
    const service = new ChatBetService(ledger, async (message) => { messages.push(message); }, new OverlayServer());
    await service.openBet({ question: "Next boss?", outcomes: ["Down", "Survives"], window_seconds: 30, reason: "The fight is starting." }, 10_000);
    await service.handleBetMessage("stake-before-lock", "viewer", "!1 100", 20_000);

    expect(await service.checkDeadlines(40_000, 900)).toBe("window_end");
    expect(ledger.currentBet?.status).toBe("locked");
    expect(messages.at(-1)).toContain("LOCKED:");
    expect(await service.checkDeadlines(910_000, 900)).toBe("timeout");
    expect(ledger.currentBet?.status).toBe("refunded");
    expect(messages.at(-1)).toContain("Refunded:");
  });

  it("does not count a delayed duplicate bet message after a new bet opens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-chat-dedup-"));
    directories.push(directory);
    const ledger = await ChatBetLedger.open(join(directory, "channel.json"));
    const service = new ChatBetService(ledger, async () => {}, new OverlayServer());

    await service.handleBetMessage("same-message", "viewer", "!1 100", 1000);
    await service.openBet({ question: "Next boss?", outcomes: ["Down", "Survives"], window_seconds: 30, reason: "The fight is starting." }, 2000);
    await service.handleBetMessage("same-message", "viewer", "!1 100", 3000);

    expect(ledger.currentBet?.stakes).toEqual({});
    expect(ledger.balance("viewer")).toBe(1000);
  });
});
