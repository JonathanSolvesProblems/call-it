import type { ActiveBetContext, OpenBetAction } from "../agent/types.js";
import type { OverlayServer } from "../overlay/server.js";
import type { OverlayBet } from "../overlay/state.js";
import { ChatBetLedger, parseBetCommand } from "./chat-ledger.js";
import type { MomentRecord, MomentRecorder } from "./moment-recorder.js";
import { twitchFailureStatus } from "./moment-recorder.js";

export type SendChatMessage = (message: string) => Promise<void>;

export class ChatBetService {
  private paused = false;
  private adBreak = false;
  private nextNoBetReplyAtMs = 0;

  constructor(
    private readonly ledger: ChatBetLedger,
    private readonly send: SendChatMessage,
    private readonly overlay: OverlayServer,
    private readonly momentRecorder?: MomentRecorder,
    private readonly isLive: () => boolean = () => false,
    private readonly log: (message: string) => void = console.error,
  ) {}

  getAgentBetContext(nowMs = Date.now()): { bet: ActiveBetContext | null; lastOpenedAtMs: number | null } {
    const bet = this.ledger.getActiveBet();
    return {
      bet: bet ? {
        status: bet.status === "open" ? "open" : "locked",
        question: bet.question,
        outcomes: [...bet.outcomes],
        pools: this.ledger.pools(),
        openedAtMs: bet.openedAtMs,
        ...(bet.lockedAtMs === undefined ? {} : { lockedAtMs: bet.lockedAtMs }),
        expiresAtMs: bet.expiresAtMs,
      } : null,
      lastOpenedAtMs: this.ledger.lastOpenedAtMs,
    };
  }

  overlayBet(nowMs = Date.now()): OverlayBet | null {
    return this.ledger.overlayBet(nowMs);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.overlay.update({ paused });
  }

  setAdBreak(adBreak: boolean): void {
    this.adBreak = adBreak;
    this.overlay.update({ adBreak });
  }

  balance(userId: string): number {
    return this.ledger.balance(userId);
  }

  async handleBetMessage(messageId: string, userId: string, text: string, nowMs = Date.now()): Promise<void> {
    const command = parseBetCommand(text, 10);
    if (!command) return;
    if (!this.ledger.markMessageSeen(messageId)) return;
    const bet = this.ledger.getActiveBet();
    if (!bet) {
      if (nowMs >= this.nextNoBetReplyAtMs) {
        this.nextNoBetReplyAtMs = nowMs + 30_000;
        await this.sendSafely("No bet open right now");
      }
      return;
    }
    if (this.paused || this.adBreak || command.outcomeIndex >= bet.outcomes.length) return;
    const result = await this.ledger.placeStake(messageId, userId, command, nowMs, true);
    if (result.accepted) this.overlay.update({ bet: this.ledger.overlayBet(nowMs) });
  }

  async openBet(action: OpenBetAction, nowMs = Date.now()): Promise<void> {
    await this.ledger.openBet(action.question, action.outcomes, action.window_seconds, nowMs);
    const instructions = action.outcomes.map((outcome, index) => `!${index + 1} ${outcome}`).join(" | ");
    this.overlay.update({ bet: this.ledger.overlayBet(nowMs) });
    await this.sendSafely(trimChat(`BET: ${action.question} | ${instructions} | closes in ${action.window_seconds}s`));
  }

  async lockBet(reason: string, nowMs = Date.now()): Promise<void> {
    const bet = await this.ledger.lock(nowMs);
    const pools = this.ledger.pools();
    const poolText = pools.map((pool, index) => `!${index + 1} ${pool.points.toLocaleString()} pts (${pool.bettors})`).join(" | ");
    this.overlay.update({ bet: this.ledger.overlayBet(nowMs), lastDecisionReason: reason });
    if (pools.some((pool) => pool.bettors > 0)) await this.sendSafely(trimChat(`LOCKED: ${poolText || bet.question} | ${reason}`));
  }

  async lockBetForResolution(nowMs = Date.now()): Promise<void> {
    if (this.ledger.currentBet?.status !== "open") return;
    await this.ledger.lock(nowMs);
    this.overlay.update({ bet: this.ledger.overlayBet(nowMs) });
  }

  async restoreBetStatus(status: "open" | "locked", lockedAtMs?: number): Promise<void> {
    await this.ledger.restoreStatus(status, lockedAtMs);
    this.overlay.update({ bet: this.ledger.overlayBet() });
  }

  async resolveBet(outcomeIndex: number, evidence: string, reason: string, nowMs = Date.now()): Promise<MomentRecord | void> {
    if (this.ledger.currentBet?.status === "open") await this.lockBet(reason, nowMs);
    const { bet, payout } = await this.ledger.resolve(outcomeIndex, nowMs);
    const outcome = bet.outcomes[outcomeIndex] ?? "Winning outcome";
    if (Object.keys(bet.stakes).length === 0) {
      this.overlay.update({ bet: this.ledger.overlayBet(nowMs), lastDecisionReason: reason });
      const sent = await this.sendSafely(trimChat(`${outcome}! No one bet on this one.`));
      return sent ? this.recordPayoutMoment(bet, outcome) : undefined;
    }
    if (payout.refunds) {
      this.overlay.update({ bet: this.ledger.overlayBet(nowMs), lastDecisionReason: reason });
      const sent = await this.sendSafely("Refunded: no points were placed on the winning outcome.");
      return sent ? this.recordPayoutMoment(bet, "refunded") : undefined;
    }
    const winners = payout.winners;
    const biggestWin = winners.reduce((best, winner) => Math.max(best, winner.payout), 0);
    this.overlay.update({ bet: this.ledger.overlayBet(nowMs), lastDecisionReason: reason });
    const sent = await this.sendSafely(trimChat(`Resolved: ${outcome} | ${winners.length} winners | biggest win ${biggestWin.toLocaleString()} pts | ${reason}`));
    return sent ? this.recordPayoutMoment(bet, outcome) : undefined;
  }

  async cancelBet(reason: string, nowMs = Date.now(), recordMoment = true): Promise<MomentRecord | void> {
    const bet = this.ledger.getActiveBet();
    if (!bet) return;
    await this.ledger.refund(nowMs);
    this.overlay.update({ bet: this.ledger.overlayBet(nowMs), lastDecisionReason: reason });
    const sent = await this.sendSafely(trimChat(`Refunded: ${reason}`));
    return sent && recordMoment ? this.recordPayoutMoment(bet, "refunded") : undefined;
  }

  async checkDeadlines(nowMs: number, maxBetSeconds: number, resolutionPending = false): Promise<"timeout" | "window_end" | null> {
    const bet = this.ledger.getActiveBet();
    if (!bet) return null;
    if (nowMs - bet.openedAtMs >= maxBetSeconds * 1000) {
      await this.cancelBet("bet timed out.", nowMs, false);
      return "timeout";
    }
    if (resolutionPending) return null;
    if (bet.status === "open" && nowMs >= bet.expiresAtMs) {
      await this.lockBet("Bet window ended.", nowMs);
      return "window_end";
    }
    return null;
  }

  private async sendSafely(message: string): Promise<boolean> {
    try { await this.send(message); return true; }
    catch (error) { console.error("Could not send a chat announcement", error); return false; }
  }

  private async recordPayoutMoment(bet: NonNullable<ChatBetLedger["currentBet"]>, result: string): Promise<MomentRecord | void> {
    if (!this.momentRecorder || !this.isLive()) return;
    try {
      const moment = await this.momentRecorder.record(bet.question, result);
      await this.ledger.recordMoment(bet.id, moment);
      this.overlay.update({ bet: this.ledger.overlayBet(bet.settledAtMs) });
      return moment;
    } catch (error) {
      this.log(`Call It moment recording failed (${twitchFailureStatus(error)}).`);
      return;
    }
  }
}

function trimChat(message: string): string {
  return message.length > 480 ? `${message.slice(0, 477)}...` : message;
}
