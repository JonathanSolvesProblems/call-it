import type { ActiveBetContext, OpenBetAction } from "../agent/types.js";
import type { OverlayServer } from "../overlay/server.js";
import type { OverlayBet } from "../overlay/state.js";
import { ChatBetLedger, parseBetCommand } from "./chat-ledger.js";
import type { MomentRecord, MomentRecorder } from "./moment-recorder.js";
import { twitchFailureStatus } from "./moment-recorder.js";

export type SendChatMessage = (message: string) => Promise<void>;

interface StakeReply {
  login: string;
  amount: number;
  outcome: string;
  balance: number;
}

interface StakeReplyBatch {
  entries: StakeReply[];
  timer: ReturnType<typeof setTimeout>;
}

export class ChatBetService {
  private paused = false;
  private adBreak = false;
  private nextNoBetReplyAtMs = 0;
  private readonly stakeReplyBatches = new Map<string, StakeReplyBatch>();
  private readonly rejectedViewersByBet = new Set<string>();

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

  async handleBetMessage(messageId: string, userId: string, text: string, nowMs = Date.now(), userLogin = userId): Promise<void> {
    const command = parseBetCommand(text, 10);
    if (!command) return;
    if (!this.ledger.markMessageSeen(messageId)) return;
    const bet = this.ledger.getActiveBet();
    if (!bet) {
      const lastBet = this.ledger.currentBet;
      if (lastBet && (lastBet.status === "resolved" || lastBet.status === "refunded")) {
        await this.rejectOnce(lastBet.id, userId, userLogin, "that bet is closed.");
        return;
      }
      if (nowMs >= this.nextNoBetReplyAtMs) {
        this.nextNoBetReplyAtMs = nowMs + 30_000;
        await this.sendSafely("No bet open right now");
      }
      return;
    }
    if (this.paused || this.adBreak) {
      await this.rejectOnce(bet.id, userId, userLogin, "betting is paused.");
      return;
    }
    if (bet.status !== "open" || nowMs >= bet.expiresAtMs) {
      await this.rejectOnce(bet.id, userId, userLogin, bet.status === "locked" ? "that bet is locked." : "that bet is closed.");
      return;
    }
    if (command.outcomeIndex >= bet.outcomes.length) {
      await this.rejectOnce(bet.id, userId, userLogin, "that outcome is not in this bet.");
      return;
    }
    const balanceBefore = this.ledger.balance(userId);
    const result = await this.ledger.placeStake(messageId, userId, command, nowMs, true, userLogin);
    if (result.accepted) {
      this.overlay.update({ bet: this.ledger.overlayBet(nowMs) });
      this.queueStakeReply(bet.id, { login: userLogin, amount: command.amount === "all" ? balanceBefore : command.amount, outcome: bet.outcomes[command.outcomeIndex]!, balance: result.balance ?? 0 });
    } else if (result.reason === "not enough points") {
      await this.rejectOnce(bet.id, userId, userLogin, `not enough points (${(result.balance ?? this.ledger.balance(userId)).toLocaleString()} left).`);
    } else if (result.reason === "one outcome per viewer") {
      await this.rejectOnce(bet.id, userId, userLogin, "you are already on another outcome for this bet.");
    }
  }

  async openBet(action: OpenBetAction, nowMs = Date.now()): Promise<void> {
    await this.ledger.openBet(action.question, action.outcomes, action.window_seconds, nowMs);
    const instructions = action.outcomes.map((outcome, index) => `!${index + 1} ${outcome}`).join(" | ");
    this.overlay.update({ bet: this.ledger.overlayBet(nowMs) });
    await this.sendSafely(trimChat(`BET: ${action.question} | ${instructions} | closes in ${action.window_seconds}s`));
  }

  async lockBet(reason: string, nowMs = Date.now()): Promise<void> {
    const current = this.ledger.getActiveBet();
    if (current) await this.flushStakeReplies(current.id);
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
    const active = this.ledger.getActiveBet();
    if (active) await this.flushStakeReplies(active.id);
    if (this.ledger.currentBet?.status === "open") await this.lockBet(reason, nowMs);
    const { bet, payout } = await this.ledger.resolve(outcomeIndex, nowMs);
    const outcome = bet.outcomes[outcomeIndex] ?? "Winning outcome";
    if (Object.keys(bet.stakes).length === 0) {
      await this.ledger.recordSettlement(bet.id, { reason, winnerCount: 0, biggestPayout: 0, checkedBySecondLook: true });
      this.overlay.update({ bet: this.ledger.overlayBet(nowMs), lastDecisionReason: reason });
      const sent = await this.sendSafely(trimChat(`${outcome}! No one bet on this one.`));
      return sent ? this.recordPayoutMoment(bet, outcome) : undefined;
    }
    if (payout.refunds) {
      await this.ledger.recordSettlement(bet.id, { reason: "No one chose the winning outcome.", winnerCount: 0, biggestPayout: 0, checkedBySecondLook: true });
      this.overlay.update({ bet: this.ledger.overlayBet(nowMs), lastDecisionReason: reason });
      const sent = await this.sendSafely("Refunded: no points were placed on the winning outcome.");
      return sent ? this.recordPayoutMoment(bet, "refunded") : undefined;
    }
    const winners = payout.winners;
    const biggestWinner = winners.reduce((best, winner) => winner.payout > best.payout ? winner : best);
    const biggestWin = biggestWinner.payout;
    const biggestWinnerLogin = bet.stakes[biggestWinner.userId]?.login;
    await this.ledger.recordSettlement(bet.id, { reason, winnerCount: winners.length, biggestPayout: biggestWin, ...(biggestWinnerLogin ? { biggestWinnerLogin } : {}), checkedBySecondLook: true });
    this.overlay.update({ bet: this.ledger.overlayBet(nowMs), lastDecisionReason: reason });
    const winnerName = biggestWinnerLogin ? `@${biggestWinnerLogin}` : "A viewer";
    const winnerCount = `${winners.length} winner${winners.length === 1 ? "" : "s"}`;
    const sent = await this.sendSafely(trimChat(`Resolved: ${outcome} | ${winnerName} +${biggestWin.toLocaleString()} pts | ${winnerCount} | ${reason}`));
    return sent ? this.recordPayoutMoment(bet, outcome) : undefined;
  }

  async cancelBet(reason: string, nowMs = Date.now(), recordMoment = true): Promise<MomentRecord | void> {
    const bet = this.ledger.getActiveBet();
    if (!bet) return;
    await this.flushStakeReplies(bet.id);
    await this.ledger.refund(nowMs);
    await this.ledger.recordSettlement(bet.id, { reason, winnerCount: 0, biggestPayout: 0, checkedBySecondLook: false });
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

  private async rejectOnce(betId: string, userId: string, login: string, message: string): Promise<void> {
    const key = `${betId}:${userId}`;
    if (this.rejectedViewersByBet.has(key)) return;
    this.rejectedViewersByBet.add(key);
    await this.sendSafely(trimChat(`@${login} ${message}`));
  }

  private queueStakeReply(betId: string, entry: StakeReply): void {
    const existing = this.stakeReplyBatches.get(betId);
    if (existing) {
      existing.entries.push(entry);
      return;
    }
    const timer = setTimeout(() => { void this.flushStakeReplies(betId); }, 3000);
    this.stakeReplyBatches.set(betId, { entries: [entry], timer });
  }

  private async flushStakeReplies(betId: string): Promise<void> {
    const batch = this.stakeReplyBatches.get(betId);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.stakeReplyBatches.delete(betId);
    const lines = batch.entries.map(({ login, amount, outcome, balance }) => `@${login} ${amount.toLocaleString()} on ${outcome} (${balance.toLocaleString()} left)`);
    await this.sendSafely(trimChat(lines.join(" · ")));
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
