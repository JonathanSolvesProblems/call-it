import type { AgentAction, ActiveBetContext } from "./types.js";

export interface GuardContext {
  nowMs: number;
  mode?: "chat" | "native";
  bet: ActiveBetContext | null;
  lastOpenedAtMs: number | null;
  minGapSeconds: number;
  live: boolean;
  paused: boolean;
  adBreak: boolean;
}

export function validateAction(action: AgentAction, context: GuardContext): string | null {
  if (action.tool === "wait") return null;
  if (!context.live) return "The stream is offline.";
  if (context.paused) return "The agent is paused.";
  if (context.adBreak) return "An ad break is active.";

  if (action.tool === "open_bet") {
    if (context.bet) return "A bet is already active.";
    if (context.lastOpenedAtMs !== null && context.nowMs - context.lastOpenedAtMs < context.minGapSeconds * 1000) {
      if (!/\bboss\b/i.test(action.arguments.reason)) return `Wait at least ${context.minGapSeconds} seconds between bets.`;
    }
    const { question, outcomes, window_seconds, reason } = action.arguments;
    const questionLimit = context.mode === "native" ? 45 : 90;
    if (question.length < 1 || question.length > questionLimit) return `Question must be 1 to ${questionLimit} characters.`;
    if (!Array.isArray(outcomes) || outcomes.length < 2 || outcomes.length > 10) return "A bet needs 2 to 10 outcomes.";
    if (outcomes.some((outcome) => typeof outcome !== "string" || outcome.length < 1 || outcome.length > 25)) return "Each outcome must be 1 to 25 characters.";
    if (!Number.isInteger(window_seconds) || window_seconds < 30 || window_seconds > 1800) return "Bet window must be 30 to 1800 seconds.";
    if (reason.trim().length === 0) return "Reason must not be empty.";
    return null;
  }

  if (!context.bet) return "There is no active bet.";
  if (action.tool === "lock_bet") {
    if (context.bet.status !== "open") return "Only an open bet can be locked.";
    if (action.arguments.reason.trim().length === 0) return "Reason must not be empty.";
    if (context.nowMs - context.bet.openedAtMs < 30_000) return "Keep the bet open for at least 30 seconds before locking.";
    return null;
  }
  if (action.tool === "resolve_bet") {
    if (!Number.isInteger(action.arguments.outcome_index) || action.arguments.outcome_index < 0 || action.arguments.outcome_index >= context.bet.outcomes.length) return "Outcome index is out of range.";
    if (action.arguments.evidence.trim().length === 0) return "Evidence must not be empty.";
    if (context.nowMs - context.bet.openedAtMs < 30_000 && !hasVisibleOutcome(action.arguments.evidence)) return "Keep the bet open for at least 30 seconds unless the outcome is already visible.";
    return null;
  }
  if (action.tool === "cancel_bet") {
    if (action.arguments.reason.trim().length === 0) return "Reason must not be empty.";
    const lastMomentChangeMs = context.bet.lockedAtMs ?? context.bet.openedAtMs;
    if (context.nowMs - lastMomentChangeMs < 20_000 && !/scene (?:has )?left|left the scene|scene changed|left the moment/i.test(action.arguments.reason)) {
      return "Wait 20 seconds after opening or locking before cancelling unless the scene left the moment.";
    }
  }
  return null;
}

function hasVisibleOutcome(evidence: string): boolean {
  return /\b(dead|0\s*hp|zero hp|kill(?:ed)?|experience|\bexp\b|\bxp\b|loot|victory|defeat|reset|cleared|completed|objective complete)\b/i.test(evidence);
}
