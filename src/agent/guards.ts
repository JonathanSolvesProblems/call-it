import type { AgentAction, ActiveBetContext } from "./types.js";

export interface GuardContext {
  nowMs: number;
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
      return `Wait at least ${context.minGapSeconds} seconds between bets.`;
    }
    const { question, outcomes, window_seconds, reason } = action.arguments;
    if (question.length < 1 || question.length > 45) return "Question must be 1 to 45 characters.";
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
    return null;
  }
  if (action.tool === "resolve_bet") {
    if (context.nowMs - context.bet.openedAtMs < 10_000) return "A bet cannot be resolved during its first 10 seconds.";
    if (!Number.isInteger(action.arguments.outcome_index) || action.arguments.outcome_index < 0 || action.arguments.outcome_index >= context.bet.outcomes.length) return "Outcome index is out of range.";
    if (action.arguments.evidence.trim().length === 0) return "Evidence must not be empty.";
    return null;
  }
  if (action.tool === "cancel_bet" && action.arguments.reason.trim().length === 0) return "Reason must not be empty.";
  return null;
}
