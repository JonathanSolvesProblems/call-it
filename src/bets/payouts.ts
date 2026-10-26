export interface Stake {
  userId: string;
  outcomeIndex: number;
  amount: number;
}

export interface PayoutResult {
  refunds: boolean;
  losingPool: number;
  payouts: Record<string, number>;
  winners: Array<{ userId: string; stake: number; profit: number; payout: number }>;
}

export function calculatePayouts(stakes: Stake[], winningOutcomeIndex: number): PayoutResult {
  const winners = stakes.filter((stake) => stake.outcomeIndex === winningOutcomeIndex && stake.amount > 0);
  const losers = stakes.filter((stake) => stake.outcomeIndex !== winningOutcomeIndex && stake.amount > 0);
  const payouts: Record<string, number> = {};

  if (winners.length === 0) {
    for (const stake of stakes) payouts[stake.userId] = (payouts[stake.userId] ?? 0) + stake.amount;
    return { refunds: true, losingPool: 0, payouts, winners: [] };
  }

  const losingPool = losers.reduce((total, stake) => total + stake.amount, 0);
  const winningStake = winners.reduce((total, stake) => total + stake.amount, 0);
  let distributed = 0;
  const shares = winners.map((stake) => {
    const profit = Math.floor(losingPool * stake.amount / winningStake);
    distributed += profit;
    return { userId: stake.userId, stake: stake.amount, profit, payout: stake.amount + profit };
  });
  const remainder = losingPool - distributed;
  if (remainder > 0) {
    const largest = shares.reduce((best, share) => share.stake > best.stake || (share.stake === best.stake && share.userId.localeCompare(best.userId) < 0) ? share : best);
    largest.profit += remainder;
    largest.payout += remainder;
  }
  for (const share of shares) payouts[share.userId] = (payouts[share.userId] ?? 0) + share.payout;
  return { refunds: false, losingPool, payouts, winners: shares };
}
