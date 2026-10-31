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
  return { nowMs: 20_000, mode: "chat", bet: null, lastOpenedAtMs: null, minGapSeconds: 180, live: true, paused: false, adBreak: false, ...overrides };
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
    expect(validateAction(openAction({ question: "Does the attempt succeed?", reason: "A risky attempt is starting." }), context({ nowMs: 179_999, lastOpenedAtMs: 0 }))).toContain("180 seconds");
    expect(validateAction(openAction({ reason: "Boss appears on screen." }), context({ nowMs: 60_000, lastOpenedAtMs: 0 }))).toBeNull();
  });

  it("blocks opening during an ad break", () => {
    expect(validateAction(openAction(), context({ adBreak: true }))).toContain("ad break");
  });

  it("blocks actions when paused or offline", () => {
    expect(validateAction(openAction(), context({ paused: true }))).toContain("paused");
    expect(validateAction(openAction(), context({ live: false }))).toContain("offline");
  });

  it("enforces chat and native question limits, outcome count, outcome length, and window limits", () => {
    expect(validateAction(openAction({ question: "q".repeat(91) }), context())).toContain("90 characters");
    expect(validateAction(openAction({ question: "q".repeat(90) }), context())).toBeNull();
    expect(validateAction(openAction({ question: "q".repeat(46) }), context({ mode: "native" }))).toContain("45 characters");
    expect(validateAction(openAction({ question: "q".repeat(45) }), context({ mode: "native" }))).toBeNull();
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
    expect(validateAction({ tool: "lock_bet", arguments: { reason: "closing" } }, context({ nowMs: 29_999, bet: activeBet }))).toContain("30 seconds");
    expect(validateAction({ tool: "lock_bet", arguments: { reason: "closing" } }, context({ nowMs: 30_000, bet: activeBet }))).toBeNull();
  });

  it("blocks another resolution proposal for 15 seconds after a rejection", () => {
    const resolve: AgentAction = { tool: "resolve_bet", arguments: { outcome_index: 0, evidence: "The tracker marks the boss defeated.", reason: "The boss went down." } };
    expect(validateAction(resolve, context({ nowMs: 34_999, bet: activeBet, lastRejectedResolutionAtMs: 20_000 })))
      .toBe("The last proposal was rejected; wait for new evidence.");
    expect(validateAction(resolve, context({ nowMs: 35_000, bet: activeBet, lastRejectedResolutionAtMs: 20_000 }))).toBeNull();
  });

  it("requires an active bet, enough betting time or visible outcome, a valid outcome, and evidence to resolve", () => {
    const resolve: Extract<AgentAction, { tool: "resolve_bet" }> = { tool: "resolve_bet", arguments: { outcome_index: 0, evidence: "Victory text in frame 2.", reason: "The boss was defeated." } };
    expect(validateAction(resolve, context())).toContain("no active bet");
    expect(validateAction({ ...resolve, arguments: { ...resolve.arguments, evidence: "The fight continues." } }, context({ bet: { ...activeBet, openedAtMs: 15_000 } }))).toContain("30 seconds");
    for (const evidence of ["Nameplate marked Dead", "Nameplate shows 0 HP", "Combat log says killed", "Experience awarded", "Loot dropped"]) {
      expect(validateAction({ ...resolve, arguments: { ...resolve.arguments, evidence } }, context({ bet: { ...activeBet, openedAtMs: 15_000 } }))).toBeNull();
    }
    expect(validateAction(resolve, context({ bet: activeBet, frameTimestampsMs: [0] }))).toContain("after the bet opened");
    expect(validateAction(resolve, context({ bet: activeBet, frameTimestampsMs: [1] }))).toBeNull();
    expect(validateAction({ tool: "resolve_bet", arguments: { outcome_index: 2, evidence: "visible", reason: "invalid" } }, context({ bet: activeBet }))).toContain("out of range");
    expect(validateAction({ tool: "resolve_bet", arguments: { outcome_index: 0, evidence: " ", reason: "invalid" } }, context({ bet: activeBet }))).toContain("Evidence");
    expect(validateAction(resolve, context({ bet: activeBet }))).toBeNull();
  });

  it("requires an active bet and a reason to cancel", () => {
    expect(validateAction({ tool: "cancel_bet", arguments: { reason: "unclear" } }, context())).toContain("no active bet");
    expect(validateAction({ tool: "cancel_bet", arguments: { reason: " " } }, context({ bet: activeBet }))).toContain("empty");
    expect(validateAction({ tool: "cancel_bet", arguments: { reason: "unclear" } }, context({ bet: activeBet }))).toBeNull();
    const justLocked = { ...activeBet, openedAtMs: 0, lockedAtMs: 15_000 };
    expect(validateAction({ tool: "cancel_bet", arguments: { reason: "unclear" } }, context({ nowMs: 20_000, bet: justLocked }))).toContain("20 seconds");
    expect(validateAction({ tool: "cancel_bet", arguments: { reason: "The scene left the moment." } }, context({ nowMs: 20_000, bet: justLocked }))).toBeNull();
  });
});
