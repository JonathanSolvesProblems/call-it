import { describe, expect, it } from "vitest";
import { validateAction, type GuardContext } from "../src/agent/guards.js";
import type { AgentAction } from "../src/agent/types.js";

const activeBet: GuardContext["bet"] = {
  status: "open",
  question: "Boss defeated?",
  outcomes: ["Yes", "No"],
  pools: [{ points: 0, bettors: 0 }, { points: 0, bettors: 0 }],
  openedAtMs: 0,
  expiresAtMs: 60_000,
};

function context(overrides: Partial<GuardContext> = {}): GuardContext {
  return { nowMs: 20_000, bet: null, lastOpenedAtMs: null, minGapSeconds: 60, live: true, paused: false, adBreak: false, ...overrides };
}

const openAction = (overrides: Partial<Extract<AgentAction, { tool: "open_bet" }>['arguments']> = {}): AgentAction => ({
  tool: "open_bet",
  arguments: { question: "Boss defeated?", outcomes: ["Yes", "No"], window_seconds: 60, reason: "The boss fight is starting.", ...overrides },
});

describe("agent action guards", () => {
  it("allows wait and a valid bet", () => {
    expect(validateAction({ tool: "wait", arguments: {} }, context())).toBeNull();
    expect(validateAction(openAction(), context())).toBeNull();
  });

  it("allows only one active bet and enforces the minimum gap", () => {
    expect(validateAction(openAction(), context({ bet: activeBet }))).toContain("already active");
    expect(validateAction(openAction(), context({ nowMs: 59_999, lastOpenedAtMs: 0 }))).toContain("60 seconds");
  });

  it("blocks opening during an ad break", () => {
    expect(validateAction(openAction(), context({ adBreak: true }))).toContain("ad break");
  });

  it("blocks actions when paused or offline", () => {
    expect(validateAction(openAction(), context({ paused: true }))).toContain("paused");
    expect(validateAction(openAction(), context({ live: false }))).toContain("offline");
  });

  it("enforces question, outcome count, outcome length, and prediction window limits", () => {
    expect(validateAction(openAction({ question: "q".repeat(46) }), context())).toContain("45 characters");
    expect(validateAction(openAction({ outcomes: ["only one"] }), context())).toContain("2 to 10");
    expect(validateAction(openAction({ outcomes: Array.from({ length: 11 }, (_, index) => `O${index}`) }), context())).toContain("2 to 10");
    expect(validateAction(openAction({ outcomes: ["x", "y".repeat(26)] }), context())).toContain("1 to 25");
    expect(validateAction(openAction({ window_seconds: 29 }), context())).toContain("30 to 1800");
    expect(validateAction(openAction({ window_seconds: 1801 }), context())).toContain("30 to 1800");
  });

  it("requires an active open bet to lock and a nonempty reason", () => {
    expect(validateAction({ tool: "lock_bet", arguments: { reason: "closing" } }, context())).toContain("no active bet");
    expect(validateAction({ tool: "lock_bet", arguments: { reason: "closing" } }, context({ bet: { ...activeBet, status: "locked" } }))).toContain("open bet");
    expect(validateAction({ tool: "lock_bet", arguments: { reason: " " } }, context({ bet: activeBet }))).toContain("empty");
  });

  it("requires an active bet, ten elapsed seconds, a valid outcome, and evidence to resolve", () => {
    const resolve: AgentAction = { tool: "resolve_bet", arguments: { outcome_index: 0, evidence: "Victory text in frame 2." } };
    expect(validateAction(resolve, context())).toContain("no active bet");
    expect(validateAction(resolve, context({ bet: { ...activeBet, openedAtMs: 15_000 } }))).toContain("first 10 seconds");
    expect(validateAction({ tool: "resolve_bet", arguments: { outcome_index: 2, evidence: "visible" } }, context({ bet: activeBet }))).toContain("out of range");
    expect(validateAction({ tool: "resolve_bet", arguments: { outcome_index: 0, evidence: " " } }, context({ bet: activeBet }))).toContain("Evidence");
    expect(validateAction(resolve, context({ bet: activeBet }))).toBeNull();
  });

  it("requires an active bet and a reason to cancel", () => {
    expect(validateAction({ tool: "cancel_bet", arguments: { reason: "unclear" } }, context())).toContain("no active bet");
    expect(validateAction({ tool: "cancel_bet", arguments: { reason: " " } }, context({ bet: activeBet }))).toContain("empty");
    expect(validateAction({ tool: "cancel_bet", arguments: { reason: "unclear" } }, context({ bet: activeBet }))).toBeNull();
  });
});
