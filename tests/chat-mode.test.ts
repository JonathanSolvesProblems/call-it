import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("batches accepted stake replies within three seconds", async () => {
    vi.useFakeTimers();
    try {
      const ledger = ChatBetLedger.inMemory();
      const messages: string[] = [];
      const service = new ChatBetService(ledger, async (message) => { messages.push(message); }, new OverlayServer());
      await service.openBet({ question: "Next point?", outcomes: ["Red", "Blue"], window_seconds: 60, reason: "The point is starting." }, 1000);
      messages.length = 0;

      await service.handleBetMessage("a", "alice-id", "!1 200", 2000, "alice");
      await service.handleBetMessage("b", "bob-id", "!2 300", 2500, "bob");
      expect(messages).toEqual([]);
      await vi.advanceTimersByTimeAsync(3000);

      expect(messages).toEqual(["@alice 200 on Red (800 left) · @bob 300 on Blue (700 left)"]);
    } finally { vi.useRealTimers(); }
  });

  it("replies once per viewer and bet with stake rejection reasons", async () => {
    const ledger = ChatBetLedger.inMemory();
    const messages: string[] = [];
    const service = new ChatBetService(ledger, async (message) => { messages.push(message); }, new OverlayServer());
    await service.openBet({ question: "Next point?", outcomes: ["Red", "Blue"], window_seconds: 60, reason: "The point is starting." }, 1000);
    messages.length = 0;

    await service.handleBetMessage("poor-1", "poor", "!1 2000", 2000, "poor");
    await service.handleBetMessage("poor-2", "poor", "!1 3000", 2100, "poor");
    await service.handleBetMessage("switch-1", "switcher", "!1 100", 2150, "switcher");
    await service.handleBetMessage("switch-2", "switcher", "!2 100", 2160, "switcher");
    await service.handleBetMessage("start", "locked", "!1 100", 2200, "locked");
    await service.lockBet("The point is live.", 32_000);
    await service.handleBetMessage("locked-bet", "locked", "!1 100", 33_000, "lockedViewer");
    await service.cancelBet("The point ended without a result.", 34_000);
    await service.handleBetMessage("closed-bet", "closed", "!1 100", 35_000, "closedViewer");

    expect(messages.filter((message) => message.includes("not enough points"))).toEqual(["@poor not enough points (1,000 left)."]);
    expect(messages).toContain("@switcher you are already on another outcome for this bet.");
    expect(messages).toContain("@lockedViewer that bet is locked.");
    expect(messages).toContain("@closedViewer that bet is closed.");
  });

  it("announces the biggest winner with correct singular and plural grammar", async () => {
    const ledger = ChatBetLedger.inMemory();
    const messages: string[] = [];
    const service = new ChatBetService(ledger, async (message) => { messages.push(message); }, new OverlayServer());
    await service.openBet({ question: "Next point?", outcomes: ["Red", "Blue"], window_seconds: 60, reason: "The point is starting." }, 1000);
    await service.handleBetMessage("a", "alice-id", "!1 100", 2000, "alice");
    await service.handleBetMessage("b", "bob-id", "!2 100", 2100, "bob");

    await service.resolveBet(0, "Visible score.", "Red took the point.", 32_000);

    expect(messages.at(-1)).toBe("Resolved: Red | @alice +200 pts | 1 winner | Red took the point.");
    expect(ledger.currentBet).toMatchObject({ settlementReason: "Red took the point.", winnerCount: 1, biggestPayout: 200, biggestWinnerLogin: "alice", checkedBySecondLook: true });
    expect(service.overlayBet()).toMatchObject({ resultReason: "Red took the point.", winnerCount: 1, biggestPayout: 200, checkedBySecondLook: true });

    await service.openBet({ question: "Next round?", outcomes: ["Green", "Gold"], window_seconds: 60, reason: "The next round starts." }, 33_000);
    await service.handleBetMessage("c", "alice-id", "!1 100", 34_000, "alice");
    await service.handleBetMessage("d", "carol-id", "!1 100", 34_100, "carol");
    await service.handleBetMessage("e", "bob-id", "!2 100", 34_200, "bob");
    await service.resolveBet(0, "The score changed.", "Green took it.", 64_000);
    expect(messages.at(-1)).toBe("Resolved: Green | @alice +150 pts | 2 winners | Green took it.");
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
