import type { AgentExecutor } from "../agent/loop.js";
import type { ActiveBetContext, OpenBetAction } from "../agent/types.js";
import { ChatBetLedger } from "../bets/chat-ledger.js";
import { ChatBetService } from "../bets/chat-mode.js";
import type { ChatBet } from "../bets/chat-ledger.js";
import type { OverlayServer } from "../overlay/server.js";

export interface ReplayBetRecord {
  question: string;
  outcomes: string[];
  openedAt: { iso: string; vodOffsetSeconds: number };
  lockedAt: { iso: string; vodOffsetSeconds: number } | null;
  endedAt: { iso: string; vodOffsetSeconds: number } | null;
  ended: { type: "resolved"; outcomeIndex: number; outcome: string } | { type: "cancelled"; reason: string } | { type: "timeout" } | null;
}

export class ReplayBetExecutor implements AgentExecutor {
  readonly ledger = ChatBetLedger.inMemory();
  readonly service: ChatBetService;
  readonly bets: ReplayBetRecord[] = [];
  private readonly byBet = new Map<string, ReplayBetRecord>();

  constructor(overlay: OverlayServer, private readonly vodStartedAtMs: number, private readonly log: (message: string) => void = console.log) {
    this.service = new ChatBetService(this.ledger, async (message) => this.log(`[fake chat] ${message}`), overlay);
  }

  getAgentBetContext(nowMs: number): { bet: ActiveBetContext | null; lastOpenedAtMs: number | null } { return this.service.getAgentBetContext(nowMs); }
  overlayBet(nowMs: number): ReturnType<OverlayServer["getState"]>["bet"] { return this.service.overlayBet(nowMs); }
  setPaused(paused: boolean): void { this.service.setPaused(paused); }
  setAdBreak(active: boolean): void { this.service.setAdBreak(active); }

  async openBet(action: OpenBetAction, nowMs: number): Promise<void> {
    await this.service.openBet(action, nowMs);
    const bet = this.ledger.currentBet!;
    const record: ReplayBetRecord = {
      question: bet.question,
      outcomes: [...bet.outcomes],
      openedAt: this.point(bet.openedAtMs),
      lockedAt: null,
      endedAt: null,
      ended: null,
    };
    this.bets.push(record);
    this.byBet.set(bet.id, record);
  }

  async lockBet(reason: string, nowMs: number): Promise<void> {
    await this.service.lockBet(reason, nowMs);
    const bet = this.ledger.currentBet;
    if (bet) this.recordLock(bet, nowMs);
  }

  async lockBetForResolution(nowMs: number): Promise<void> {
    await this.service.lockBetForResolution(nowMs);
    const bet = this.ledger.currentBet;
    if (bet) this.recordLock(bet, nowMs);
  }

  async resolveBet(outcomeIndex: number, evidence: string, reason: string, nowMs: number): Promise<void> {
    const bet = this.ledger.currentBet;
    await this.service.resolveBet(outcomeIndex, evidence, reason, nowMs);
    if (!bet) return;
    const record = this.byBet.get(bet.id);
    if (record) {
      record.endedAt = this.point(nowMs);
      record.ended = { type: "resolved", outcomeIndex, outcome: bet.outcomes[outcomeIndex] ?? "" };
    }
  }

  async restoreBetStatus(status: "open" | "locked", lockedAtMs?: number): Promise<void> {
    await this.service.restoreBetStatus(status, lockedAtMs);
    const bet = this.ledger.currentBet;
    const record = bet ? this.byBet.get(bet.id) : undefined;
    if (record && status === "open") record.lockedAt = null;
    else if (record && lockedAtMs !== undefined) record.lockedAt = this.point(lockedAtMs);
  }

  async cancelBet(reason: string, nowMs: number): Promise<void> {
    const bet = this.ledger.currentBet;
    await this.service.cancelBet(reason, nowMs);
    if (bet) this.finish(bet, nowMs, { type: "cancelled", reason });
  }

  async checkDeadlines(nowMs: number, maxBetSeconds: number, resolutionPending = false): Promise<"timeout" | "window_end" | null> {
    const bet = this.ledger.currentBet;
    const result = await this.service.checkDeadlines(nowMs, maxBetSeconds, resolutionPending);
    if (result === "timeout" && bet) this.finish(bet, nowMs, { type: "timeout" });
    else if (result === "window_end" && bet) this.recordLock(bet, nowMs);
    return result;
  }

  private recordLock(bet: ChatBet, nowMs: number): void {
    const record = this.byBet.get(bet.id);
    if (record && !record.lockedAt) record.lockedAt = this.point(nowMs);
  }

  private finish(bet: ChatBet, nowMs: number, ended: NonNullable<ReplayBetRecord["ended"]>): void {
    const record = this.byBet.get(bet.id);
    if (!record) return;
    record.endedAt = this.point(nowMs);
    record.ended = ended;
  }

  private point(timestampMs: number): ReplayBetRecord["openedAt"] {
    return { iso: new Date(timestampMs).toISOString(), vodOffsetSeconds: (timestampMs - this.vodStartedAtMs) / 1000 };
  }
}
