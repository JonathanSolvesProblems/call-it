export interface OpenBetAction {
  question: string;
  outcomes: string[];
  window_seconds: number;
  reason: string;
}

export type AgentAction =
  | { tool: "wait"; arguments: Record<string, never> }
  | { tool: "open_bet"; arguments: OpenBetAction }
  | { tool: "lock_bet"; arguments: { reason: string } }
  | { tool: "resolve_bet"; arguments: { outcome_index: number; evidence: string } }
  | { tool: "cancel_bet"; arguments: { reason: string } };

export interface ActiveBetContext {
  status: "open" | "locked";
  question: string;
  outcomes: string[];
  pools: Array<{ points: number; bettors: number }>;
  openedAtMs: number;
  expiresAtMs: number;
}

export interface AgentContext {
  nowMs: number;
  frames: Array<{ timestampMs: number; jpegBase64: string; sha256: string }>;
  bet: ActiveBetContext | null;
  lastOpenedAtMs: number | null;
  decisions: Array<Record<string, unknown>>;
  memorySummary: string;
  adBreak: boolean;
}
