import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OverlayBet } from "../overlay/state.js";
import { calculatePayouts, type PayoutResult, type Stake } from "./payouts.js";

export type ChatBetStatus = "open" | "locked" | "resolved" | "refunded";

export interface ChatBet {
  id: string;
  question: string;
  outcomes: string[];
  status: ChatBetStatus;
  openedAtMs: number;
  windowSeconds: number;
  expiresAtMs: number;
  lockedAtMs?: number;
  settledAtMs?: number;
  winningOutcomeIndex?: number;
  stakes: Record<string, { outcomeIndex: number; amount: number }>;
}

interface PersistedLedger {
  balances: Record<string, number>;
  currentBet: ChatBet | null;
  lastOpenedAtMs: number | null;
}

export interface BetCommand {
  outcomeIndex: number;
  amount: number | "all";
}

export interface PlaceStakeResult {
  accepted: boolean;
  reason?: string;
  balance?: number;
  stake?: number;
}

export function parseBetCommand(text: string, outcomeCount: number): BetCommand | undefined {
  const match = /^!(\d{1,2})(?:\s+(all|\d+))?$/i.exec(text.trim());
  if (!match) return undefined;
  const outcomeIndex = Number(match[1]) - 1;
  if (outcomeIndex < 0 || outcomeIndex >= outcomeCount) return undefined;
  const amountText = match[2];
  if (amountText?.toLowerCase() === "all") return { outcomeIndex, amount: "all" };
  const amount = amountText === undefined ? 100 : Number(amountText);
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
  return { outcomeIndex, amount };
}

export class ChatBetLedger {
  private readonly balances: Record<string, number>;
  private readonly seenMessageIds = new Set<string>();
  private saveQueue: Promise<void> = Promise.resolve();
  currentBet: ChatBet | null;
  lastOpenedAtMs: number | null;

  private constructor(private readonly filePath: string, saved: PersistedLedger) {
    this.balances = saved.balances;
    this.currentBet = saved.currentBet;
    this.lastOpenedAtMs = saved.lastOpenedAtMs;
  }

  static async open(filePath: string): Promise<ChatBetLedger> {
    let saved: PersistedLedger = { balances: {}, currentBet: null, lastOpenedAtMs: null };
    try {
      saved = JSON.parse(await readFile(filePath, "utf8")) as PersistedLedger;
      if (!saved.balances || typeof saved.balances !== "object") throw new Error("Ledger file has invalid balances.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new ChatBetLedger(filePath, saved);
  }

  balance(userId: string): number {
    return this.balances[userId] ?? 1000;
  }

  getActiveBet(): ChatBet | null {
    return this.currentBet && (this.currentBet.status === "open" || this.currentBet.status === "locked") ? this.currentBet : null;
  }

  async openBet(question: string, outcomes: string[], windowSeconds: number, nowMs: number): Promise<ChatBet> {
    const bet: ChatBet = {
      id: randomUUID(),
      question,
      outcomes: [...outcomes],
      status: "open",
      openedAtMs: nowMs,
      windowSeconds,
      expiresAtMs: nowMs + windowSeconds * 1000,
      stakes: {},
    };
    this.currentBet = bet;
    this.lastOpenedAtMs = nowMs;
    await this.save();
    return bet;
  }

  async placeStake(messageId: string, userId: string, command: BetCommand, nowMs = Date.now(), messageAlreadyMarked = false): Promise<PlaceStakeResult> {
    if (!messageAlreadyMarked && !this.markMessageSeen(messageId)) return { accepted: false, reason: "duplicate message" };
    const bet = this.getActiveBet();
    if (!bet || bet.status !== "open" || nowMs >= bet.expiresAtMs) return { accepted: false, reason: "no open bet" };
    const existing = bet.stakes[userId];
    if (existing && existing.outcomeIndex !== command.outcomeIndex) return { accepted: false, reason: "one outcome per viewer" };
    const amount = command.amount === "all" ? this.balance(userId) : command.amount;
    if (!Number.isSafeInteger(amount) || amount <= 0) return { accepted: false, reason: "amount must be positive" };
    const balance = this.balance(userId);
    if (amount > balance) return { accepted: false, reason: "not enough points", balance };
    this.balances[userId] = balance - amount;
    bet.stakes[userId] = { outcomeIndex: command.outcomeIndex, amount: (existing?.amount ?? 0) + amount };
    await this.save();
    return { accepted: true, balance: this.balances[userId], stake: bet.stakes[userId].amount };
  }

  async lock(nowMs = Date.now()): Promise<ChatBet> {
    const bet = this.getActiveBet();
    if (!bet || bet.status !== "open") throw new Error("There is no open bet to lock.");
    bet.status = "locked";
    bet.lockedAtMs = nowMs;
    await this.save();
    return bet;
  }

  async restoreStatus(status: "open" | "locked", lockedAtMs?: number): Promise<void> {
    const bet = this.getActiveBet();
    if (!bet) return;
    bet.status = status;
    if (status === "open") delete bet.lockedAtMs;
    else if (lockedAtMs !== undefined) bet.lockedAtMs = lockedAtMs;
    await this.save();
  }

  async resolve(winningOutcomeIndex: number, nowMs = Date.now()): Promise<{ bet: ChatBet; payout: PayoutResult }> {
    const bet = this.getActiveBet();
    if (!bet) throw new Error("There is no active bet to resolve.");
    if (bet.status === "open") await this.lock(nowMs);
    if (winningOutcomeIndex < 0 || winningOutcomeIndex >= bet.outcomes.length) throw new Error("Winning outcome index is out of range.");
    const stakes: Stake[] = Object.entries(bet.stakes).map(([userId, value]) => ({ userId, ...value }));
    const payout = calculatePayouts(stakes, winningOutcomeIndex);
    for (const [userId, amount] of Object.entries(payout.payouts)) this.balances[userId] = this.balance(userId) + amount;
    const noStakes = Object.keys(bet.stakes).length === 0;
    bet.status = payout.refunds && !noStakes ? "refunded" : "resolved";
    bet.winningOutcomeIndex = winningOutcomeIndex;
    bet.settledAtMs = nowMs;
    await this.save();
    return { bet, payout };
  }

  async refund(nowMs = Date.now()): Promise<ChatBet> {
    const bet = this.getActiveBet();
    if (!bet) throw new Error("There is no active bet to refund.");
    for (const [userId, stake] of Object.entries(bet.stakes)) this.balances[userId] = this.balance(userId) + stake.amount;
    bet.status = "refunded";
    bet.settledAtMs = nowMs;
    await this.save();
    return bet;
  }

  pools(): Array<{ points: number; bettors: number }> {
    const bet = this.currentBet;
    if (!bet) return [];
    return bet.outcomes.map((_, outcomeIndex) => {
      const stakes = Object.values(bet.stakes).filter((stake) => stake.outcomeIndex === outcomeIndex);
      return { points: stakes.reduce((total, stake) => total + stake.amount, 0), bettors: stakes.length };
    });
  }

  overlayBet(nowMs = Date.now()): OverlayBet | null {
    const bet = this.currentBet;
    if (!bet) return null;
    return {
      question: bet.question,
      outcomes: bet.outcomes.map((title, index) => {
        const pool = this.pools()[index] ?? { points: 0, bettors: 0 };
        return { title, points: pool.points, bettors: pool.bettors };
      }),
      status: bet.status,
      secondsLeft: Math.max(0, Math.ceil((bet.expiresAtMs - nowMs) / 1000)),
      ...(bet.winningOutcomeIndex === undefined ? {} : { winningOutcomeIndex: bet.winningOutcomeIndex }),
    };
  }

  markMessageSeen(messageId: string): boolean {
    if (this.seenMessageIds.has(messageId)) return false;
    this.seenMessageIds.add(messageId);
    return true;
  }

  private async save(): Promise<void> {
    const saved: PersistedLedger = { balances: this.balances, currentBet: this.currentBet, lastOpenedAtMs: this.lastOpenedAtMs };
    const content = `${JSON.stringify(saved, null, 2)}\n`;
    this.saveQueue = this.saveQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, content, { mode: 0o600 });
    });
    await this.saveQueue;
  }
}
