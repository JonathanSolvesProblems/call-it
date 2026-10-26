import type { ActiveBetContext, OpenBetAction } from "../agent/types.js";
import type { OverlayServer } from "../overlay/server.js";
import type { OverlayBet } from "../overlay/state.js";
import { ChatBetLedger, parseBetCommand } from "./chat-ledger.js";

export type SendChatMessage = (message: string) => Promise<void>;

export class ChatBetService {
  private paused = false;
  private adBreak = false;

  constructor(private readonly ledger: ChatBetLedger, private readonly send: SendChatMessage, private readonly overlay: OverlayServer) {}

  getAgentBetContext(nowMs = Date.now()): { bet: ActiveBetContext | null; lastOpenedAtMs: number | null } {
    const bet = this.ledger.getActiveBet();
    return {
      bet: bet ? {
        status: bet.status === "open" ? "open" : "locked",
        question: bet.question,
        outcomes: [...bet.outcomes],
        pools: this.ledger.pools(),
        openedAtMs: bet.openedAtMs,
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
    const bet = this.ledger.getActiveBet();
    if (!bet || this.paused || this.adBreak) return;
    const command = parseBetCommand(text, bet.outcomes.length);
    if (!command) return;
    const result = await this.ledger.placeStake(messageId, userId, command, nowMs);
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
    const pools = this.ledger.pools().map((pool, index) => `!${index + 1} ${pool.points.toLocaleString()} pts (${pool.bettors})`).join(" | ");
    this.overlay.update({ bet: this.ledger.overlayBet(nowMs), lastDecisionReason: reason });
    await this.sendSafely(trimChat(`LOCKED: ${pools || bet.question}`));
  }

  async resolveBet(outcomeIndex: number, evidence: string, nowMs = Date.now()): Promise<void> {
    if (this.ledger.currentBet?.status === "open") await this.lockBet("Outcome is ready to resolve.", nowMs);
    const { bet, payout } = await this.ledger.resolve(outcomeIndex, nowMs);
    if (payout.refunds) {
      this.overlay.update({ bet: this.ledger.overlayBet(nowMs), lastDecisionReason: evidence });
      await this.sendSafely("Refunded: no points were placed on the winning outcome.");
      return;
    }
    const winners = payout.winners;
    const biggestWin = winners.reduce((best, winner) => Math.max(best, winner.payout), 0);
    const outcome = bet.outcomes[outcomeIndex] ?? "winning outcome";
    this.overlay.update({ bet: this.ledger.overlayBet(nowMs), lastDecisionReason: evidence });
    await this.sendSafely(trimChat(`Resolved: ${outcome} | ${winners.length} winners | biggest win ${biggestWin.toLocaleString()} pts`));
  }

  async cancelBet(reason: string, nowMs = Date.now()): Promise<void> {
    await this.ledger.refund(nowMs);
    this.overlay.update({ bet: this.ledger.overlayBet(nowMs), lastDecisionReason: reason });
    await this.sendSafely(trimChat(`Refunded: ${reason}`));
  }

  async checkDeadlines(nowMs: number, maxBetSeconds: number): Promise<"timeout" | "window_end" | null> {
    const bet = this.ledger.getActiveBet();
    if (!bet) return null;
    if (nowMs - bet.openedAtMs >= maxBetSeconds * 1000) {
      await this.cancelBet("bet timed out.", nowMs);
      return "timeout";
    }
    if (bet.status === "open" && nowMs >= bet.expiresAtMs) {
      await this.lockBet("Bet window ended.", nowMs);
      return "window_end";
    }
    return null;
  }

  private async sendSafely(message: string): Promise<void> {
    try { await this.send(message); }
    catch (error) { console.error("Could not send a chat announcement", error); }
  }
}

function trimChat(message: string): string {
  return message.length > 480 ? `${message.slice(0, 477)}...` : message;
}
