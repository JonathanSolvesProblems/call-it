import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatBetLedger, parseBetCommand } from "../src/bets/chat-ledger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("chat-mode ledger", () => {
  it("parses default, explicit, and all-in stake amounts", () => {
    expect(parseBetCommand("!1", 2)).toEqual({ outcomeIndex: 0, amount: 100 });
    expect(parseBetCommand("!2 200", 2)).toEqual({ outcomeIndex: 1, amount: 200 });
    expect(parseBetCommand("!2 all", 2)).toEqual({ outcomeIndex: 1, amount: "all" });
    expect(parseBetCommand("!3 100", 2)).toBeUndefined();
    expect(parseBetCommand("!1 0", 2)).toBeUndefined();
  });

  it("deduplicates message ids, enforces one outcome, and persists balances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-ledger-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "channel.json");
    const ledger = await ChatBetLedger.open(path);
    expect(ledger.balance("viewer")).toBe(1000);
    await ledger.openBet("Winner?", ["A", "B"], 30, 10_000);
    expect(await ledger.placeStake("message-1", "viewer", { outcomeIndex: 0, amount: 200 }, 10_100)).toMatchObject({ accepted: true, balance: 800 });
    expect(await ledger.placeStake("message-1", "viewer", { outcomeIndex: 0, amount: 200 }, 10_101)).toMatchObject({ accepted: false, reason: "duplicate message" });
    expect(await ledger.placeStake("message-2", "viewer", { outcomeIndex: 1, amount: 100 }, 10_102)).toMatchObject({ accepted: false, reason: "one outcome per viewer" });
    expect(await ledger.placeStake("message-3", "viewer", { outcomeIndex: 0, amount: 1000 }, 10_103)).toMatchObject({ accepted: false, reason: "not enough points" });

    const reloaded = await ChatBetLedger.open(path);
    expect(reloaded.balance("viewer")).toBe(800);
    const saved = JSON.parse(await readFile(path, "utf8")) as { currentBet: { stakes: Record<string, { amount: number }> } };
    expect(saved.currentBet.stakes.viewer?.amount).toBe(200);
  });
});
