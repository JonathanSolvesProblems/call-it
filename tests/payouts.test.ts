import { describe, expect, it } from "vitest";
import { calculatePayouts } from "../src/bets/payouts.js";

describe("chat bet payouts", () => {
  it("splits the losing pool proportionally and gives the floor remainder to the largest winner", () => {
    const payout = calculatePayouts([
      { userId: "alice", outcomeIndex: 0, amount: 2 },
      { userId: "bob", outcomeIndex: 0, amount: 1 },
      { userId: "carol", outcomeIndex: 1, amount: 2 },
    ], 0);

    expect(payout.refunds).toBe(false);
    expect(payout.losingPool).toBe(2);
    expect(payout.payouts).toEqual({ alice: 4, bob: 1 });
    expect(payout.winners.find((winner) => winner.userId === "alice")?.profit).toBe(2);
  });

  it("refunds every stake if the winning outcome has no bettors", () => {
    const payout = calculatePayouts([
      { userId: "alice", outcomeIndex: 0, amount: 250 },
      { userId: "bob", outcomeIndex: 1, amount: 300 },
    ], 2);

    expect(payout.refunds).toBe(true);
    expect(payout.payouts).toEqual({ alice: 250, bob: 300 });
  });
});
