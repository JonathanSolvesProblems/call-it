import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export interface ChessGame {
  url: string;
  white: string;
  black: string;
  result: "white" | "black" | "draw";
  startedAt: string;
  endedAt: string;
  streamer: string;
}

export interface BetRecord {
  question: string;
  outcomes: string[];
  openedAt: { iso: string; vodOffsetSeconds: number };
  ended: { type: "resolved"; outcomeIndex: number; outcome: string } | { type: "cancelled"; reason: string } | { type: "timeout" } | null;
}

interface GradedBet {
  question: string;
  openedAt: string;
  gameUrl?: string;
  status: "correct" | "incorrect" | "refunded" | "ungraded";
  predictedResult?: string;
  actualResult?: string;
  reason?: string;
}

export interface GradeSummary {
  vodId: string;
  memoryOff: boolean;
  vodHours: number;
  betsOpened: number;
  betsPerHour: number;
  graded: number;
  matchedRecord: number;
  didNotMatch: number;
  refunded: number;
  ungraded: number;
  ungradedReasons: Record<string, number>;
  bets: GradedBet[];
}

export async function gradeRun(runDirectoryArg: string, gamesPathArg: string, resultDirectory = join(process.cwd(), "eval", "results")): Promise<GradeSummary> {
  const runDirectory = resolve(runDirectoryArg);
  const games = JSON.parse(await readFile(resolve(gamesPathArg), "utf8")) as ChessGame[];
  const bets = JSON.parse(await readFile(join(runDirectory, "bets.json"), "utf8")) as BetRecord[];
  const runPath = join(runDirectory, "run.json");
  let run: { vod?: { vodId?: string }; memoryOff?: boolean; fromSeconds?: number; toSeconds?: number } = {};
  try { run = JSON.parse(await readFile(runPath, "utf8")) as typeof run; } catch { /* Older replay folders infer duration from decision offsets. */ }
  let fromSeconds = run.fromSeconds ?? 0;
  let toSeconds = run.toSeconds;
  if (toSeconds === undefined) {
    try {
      const decisions = (await readFile(join(runDirectory, "decisions.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { vodOffsetSeconds?: number });
      toSeconds = Math.max(fromSeconds, ...decisions.map((entry) => entry.vodOffsetSeconds ?? 0));
    } catch { toSeconds = fromSeconds; }
  }
  const durationHours = Math.max(0, toSeconds - fromSeconds) / 3600;
  const gradedBets: GradedBet[] = bets.map((bet) => {
    const openedAtMs = Date.parse(bet.openedAt.iso);
    const game = games.find((candidate) => Date.parse(candidate.startedAt) <= openedAtMs && openedAtMs <= Date.parse(candidate.endedAt));
    if (!game) return { question: bet.question, openedAt: bet.openedAt.iso, status: "ungraded", reason: "no game in progress" };
    if (bet.ended?.type === "cancelled" || bet.ended?.type === "timeout") {
      return { question: bet.question, openedAt: bet.openedAt.iso, gameUrl: game.url, status: "refunded", reason: bet.ended.type === "cancelled" ? bet.ended.reason : "timeout" };
    }
    const outcomes = bet.outcomes.map((outcome) => outcomeResult(outcome, game));
    if (outcomes.some((result) => result === null)) {
      return { question: bet.question, openedAt: bet.openedAt.iso, gameUrl: game.url, status: "ungraded", reason: "outcomes do not map to streamer win, opponent win, or draw" };
    }
    if (bet.ended?.type !== "resolved") {
      return { question: bet.question, openedAt: bet.openedAt.iso, gameUrl: game.url, status: "ungraded", reason: "bet has no resolved outcome" };
    }
    const predictedResult = outcomes[bet.ended.outcomeIndex];
    if (!predictedResult) return { question: bet.question, openedAt: bet.openedAt.iso, gameUrl: game.url, status: "ungraded", reason: "resolved outcome index is invalid" };
    const actualResult = resultForStreamer(game.result, game);
    const status = predictedResult === actualResult ? "correct" : "incorrect";
    return { question: bet.question, openedAt: bet.openedAt.iso, gameUrl: game.url, status, predictedResult, actualResult };
  });
  const ungradedReasons: Record<string, number> = {};
  for (const bet of gradedBets) if (bet.status === "ungraded") ungradedReasons[bet.reason ?? "unknown"] = (ungradedReasons[bet.reason ?? "unknown"] ?? 0) + 1;
  const result: GradeSummary = {
    vodId: run.vod?.vodId ?? basename(runDirectory).replace(/-nomemory$/, ""),
    memoryOff: run.memoryOff ?? basename(runDirectory).endsWith("-nomemory"),
    vodHours: durationHours,
    betsOpened: bets.length,
    betsPerHour: durationHours > 0 ? bets.length / durationHours : 0,
    graded: gradedBets.filter((bet) => bet.status === "correct" || bet.status === "incorrect").length,
    matchedRecord: gradedBets.filter((bet) => bet.status === "correct").length,
    didNotMatch: gradedBets.filter((bet) => bet.status === "incorrect").length,
    refunded: gradedBets.filter((bet) => bet.status === "refunded").length,
    ungraded: gradedBets.filter((bet) => bet.status === "ungraded").length,
    ungradedReasons,
    bets: gradedBets,
  };
  await mkdir(resultDirectory, { recursive: true });
  const suffix = result.memoryOff ? "-nomemory" : "";
  const safeVodId = result.vodId.replace(/[^a-zA-Z0-9._-]/g, "_");
  await writeFile(join(resultDirectory, `chess-${safeVodId}${suffix}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function outcomeResult(outcome: string, game: ChessGame): "streamer win" | "opponent win" | "draw" | null {
  const normalized = outcome.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (/\b(draw|stalemate|tie)\b/.test(normalized)) return "draw";
  const streamer = game.streamer.toLowerCase();
  const streamerIsWhite = game.white.toLowerCase() === streamer;
  const streamerIsBlack = game.black.toLowerCase() === streamer;
  if (!streamerIsWhite && !streamerIsBlack) return null;
  const opponent = streamerIsWhite ? game.black.toLowerCase() : game.white.toLowerCase();
  if (containsName(normalized, streamer)) return /\b(lose|loses|lost|losing)\b/.test(normalized) ? "opponent win" : "streamer win";
  if (containsName(normalized, opponent)) return /\b(lose|loses|lost|losing)\b/.test(normalized) ? "streamer win" : "opponent win";
  if (/\b(streamer|player)\b/.test(normalized)) {
    if (/\b(lose|loses|lost|losing)\b/.test(normalized)) return "opponent win";
    if (/\b(win|wins|won|winning)\b/.test(normalized)) return "streamer win";
  }
  if (/\b(opponent|other player)\b/.test(normalized)) return /\b(lose|loses|lost|losing)\b/.test(normalized) ? "streamer win" : "opponent win";
  if (/\b(white|black)\b/.test(normalized)) {
    const winnerColor = /\bwhite\b/.test(normalized) ? "white" : "black";
    return (winnerColor === "white") === streamerIsWhite ? "streamer win" : "opponent win";
  }
  if (/\b(win|wins|won|winning)\b/.test(normalized)) return "streamer win";
  if (/\b(lose|loses|lost|losing)\b/.test(normalized)) return "opponent win";
  return null;
}

function resultForStreamer(result: ChessGame["result"], game: ChessGame): "streamer win" | "opponent win" | "draw" {
  if (result === "draw") return "draw";
  const winnerIsWhite = result === "white";
  return winnerIsWhite === (game.white.toLowerCase() === game.streamer.toLowerCase()) ? "streamer win" : "opponent win";
}

function containsName(text: string, name: string): boolean {
  const normalizedName = name.replace(/[^a-z0-9]+/g, " ").trim();
  return Boolean(normalizedName) && ` ${text} `.includes(` ${normalizedName} `);
}
