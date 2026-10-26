export type BetStatus = "open" | "locked" | "resolved" | "refunded";

export interface OverlayOutcome {
  title: string;
  points: number;
  bettors: number;
}

export interface OverlayBet {
  question: string;
  outcomes: OverlayOutcome[];
  status: BetStatus;
  secondsLeft: number;
  winningOutcomeIndex?: number;
}

export interface OverlayDecision {
  timestampMs: number;
  reason: string;
}

export interface OverlayState {
  bet: OverlayBet | null;
  lastDecisionReason: string | null;
  decisions: OverlayDecision[];
  paused: boolean;
  adBreak: boolean;
  latestFrameJpegBase64: string | null;
  demoData: boolean;
}

export function initialOverlayState(): OverlayState {
  return {
    bet: null,
    lastDecisionReason: null,
    decisions: [],
    paused: false,
    adBreak: false,
    latestFrameJpegBase64: null,
    demoData: false,
  };
}
