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
  whiteName?: string | null;
  blackName?: string | null;
}

export interface BetRecord {
  question: string;
  outcomes: string[];
  openedAt: { iso: string; vodOffsetSeconds: number };
  endedAt?: { iso: string; vodOffsetSeconds: number } | null;
  ended: { type: "resolved"; outcomeIndex: number; outcome: string } | { type: "cancelled"; reason: string } | { type: "timeout" } | null;
}

interface GradedBet {
  question: string;
  openedAt: string;
  gameUrl?: string;
  status: "correct" | "incorrect" | "refunded" | "ungraded";
  predictedResults?: Array<ChessGame["result"]>;
  actualResult?: string;
  reason?: string;
}

export interface GradeSummary {
  graderVersion: "2026-10-31b";
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
    const game = matchGameForBet(openedAtMs, games);
    if (!game) return { question: bet.question, openedAt: bet.openedAt.iso, status: "ungraded", reason: "no game in progress" };
    if (bet.ended?.type === "cancelled" || bet.ended?.type === "timeout") {
      return { question: bet.question, openedAt: bet.openedAt.iso, gameUrl: game.url, status: "refunded", reason: bet.ended.type === "cancelled" ? bet.ended.reason : "timeout" };
    }
    if (bet.ended?.type === "resolved" && bet.endedAt) {
      const settledAtMs = Date.parse(bet.endedAt.iso);
      if (settledAtMs < Date.parse(game.startedAt) || Date.parse(game.endedAt) - settledAtMs > 10_000) {
        return { question: bet.question, openedAt: bet.openedAt.iso, gameUrl: game.url, status: "incorrect", actualResult: game.result, reason: "paid out before the game ended" };
      }
    }
    const outcomes = bet.outcomes.map((outcome) => mapOutcomeToResults(outcome, bet.question, game));
    if (outcomes.some((result) => result === null)) {
      return { question: bet.question, openedAt: bet.openedAt.iso, gameUrl: game.url, status: "ungraded", reason: "outcomes do not map to streamer win, opponent win, or draw" };
    }
    if (bet.ended?.type !== "resolved") {
      return { question: bet.question, openedAt: bet.openedAt.iso, gameUrl: game.url, status: "ungraded", reason: "bet has no resolved outcome" };
    }
    const predictedResults = outcomes[bet.ended.outcomeIndex];
    if (!predictedResults) return { question: bet.question, openedAt: bet.openedAt.iso, gameUrl: game.url, status: "ungraded", reason: "resolved outcome index is invalid" };
    const actualResult = game.result;
    const status = predictedResults.has(actualResult) ? "correct" : "incorrect";
    return { question: bet.question, openedAt: bet.openedAt.iso, gameUrl: game.url, status, predictedResults: [...predictedResults], actualResult };
  });
  const ungradedReasons: Record<string, number> = {};
  for (const bet of gradedBets) if (bet.status === "ungraded") ungradedReasons[bet.reason ?? "unknown"] = (ungradedReasons[bet.reason ?? "unknown"] ?? 0) + 1;
  const result: GradeSummary = {
    graderVersion: "2026-10-31b",
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

export function matchGameForBet(openedAtMs: number, games: ChessGame[]): ChessGame | undefined {
  const ordered = [...games].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const inProgress = ordered.filter((game) => Date.parse(game.startedAt) <= openedAtMs && openedAtMs <= Date.parse(game.endedAt));
  if (inProgress.length) return inProgress.at(-1);
  return ordered.find((game) => {
    const secondsBeforeStart = (Date.parse(game.startedAt) - openedAtMs) / 1000;
    return secondsBeforeStart > 0 && secondsBeforeStart <= 300;
  });
}

export function mapOutcomeToResults(outcome: string, question: string, game: ChessGame): Set<ChessGame["result"]> | null {
  const normalized = normalize(outcome);
  const words = normalized.split(" ").filter(Boolean);
  const players = playerAliases(game);
  const exactMatched = (Object.keys(players) as Array<"white" | "black">).filter((color) => players[color].some((alias) => hasPhrase(normalized, alias)));
  if (exactMatched.length > 1) return null;
  let matched = exactMatched;
  if (matched.length > 1) return null;

  const reserved = new Set([
    "yes", "no", "draw", "stalemate", "tie", "win", "wins", "won", "winning", "lose", "loses", "loss", "lost", "losing",
    "streamer", "player", "opponent", "other", "white", "black", "the", "a", "an", "vs", "versus", "and", "will",
  ]);
  const knownNameWords = new Set(Object.values(players).flatMap((aliases) => aliases.flatMap((alias) => alias.split(" "))));
  const resultVerbIndex = words.findIndex((word) => ["win", "wins", "won", "winning", "lose", "loses", "loss", "lost", "losing"].includes(word));
  const nameCandidates = resultVerbIndex < 0 ? words : words.slice(0, resultVerbIndex);
  if (matched.length === 0) matched = fuzzyPlayerMatches(nameCandidates, players);
  if (matched.length > 1) return null;
  if (matched.length === 0) {
    if (nameCandidates.some((word) => word.length >= 3 && !reserved.has(word) && !knownNameWords.has(word))) return null;
    if ([...outcome.matchAll(/\b[A-Z][a-zA-Z]{2,}\b/g)].some(([word]) => {
      const normalizedWord = normalize(word);
      return !reserved.has(normalizedWord) && !knownNameWords.has(normalizedWord);
    })) return null;
  }

  if (words.includes("yes") || words.includes("no")) {
    if (words.length !== 1) return null;
    const assertion = questionResult(question, game, players);
    if (!assertion) return null;
    return words[0] === "yes" ? assertion : new Set(( ["white", "black", "draw"] as const).filter((result) => !assertion.has(result)));
  }

  if (words.includes("draw") || words.includes("stalemate") || words.includes("tie")) return new Set(["draw"]);
  if (words.length === 1 && ["win", "wins", "lose", "loses", "loss"].includes(words[0]!)) {
    const questionResultSet = questionResult(question, game, players);
    if (!questionResultSet || questionResultSet.size !== 1 || questionResultSet.has("draw")) return null;
    const playerResult = [...questionResultSet][0]!;
    const asksForLoss = ["lose", "loses", "loss"].includes(words[0]!);
    return new Set([asksForLoss ? playerResult === "white" ? "black" : "white" : playerResult]);
  }
  let winnerColor = matched[0];
  if (words.includes("streamer") || words.includes("player")) {
    if (winnerColor) return null;
    winnerColor = game.white.toLowerCase() === game.streamer.toLowerCase() ? "white" : game.black.toLowerCase() === game.streamer.toLowerCase() ? "black" : undefined;
  } else if (words.includes("opponent") || words.includes("other")) {
    if (winnerColor) return null;
    winnerColor = game.white.toLowerCase() === game.streamer.toLowerCase() ? "black" : game.black.toLowerCase() === game.streamer.toLowerCase() ? "white" : undefined;
  }
  const hasLose = words.some((word) => ["lose", "loses", "loss", "lost", "losing"].includes(word));
  const hasWin = words.some((word) => ["win", "wins", "won", "winning"].includes(word));
  if (hasLose && hasWin) return null;
  if (hasLose && winnerColor) winnerColor = winnerColor === "white" ? "black" : "white";
  if (!winnerColor && (words.includes("white") || words.includes("black"))) {
    if (words.includes("white") && words.includes("black")) return null;
    const namedColor = words.includes("white") ? "white" : "black";
    winnerColor = hasLose ? namedColor === "white" ? "black" : "white" : namedColor;
  }
  return winnerColor ? new Set([winnerColor]) : null;
}

function questionResult(question: string, game: ChessGame, players: Record<"white" | "black", string[]>): Set<ChessGame["result"]> | null {
  const normalized = normalize(question);
  const drawMatch = /\b(draw|stalemate|tie)\b/.exec(normalized);
  const verbMatch = /\b(win|wins|won|winning|lose|loses|loss|lost|losing)\b/.exec(normalized);
  if (drawMatch && verbMatch) return null;
  const match = drawMatch && (!verbMatch || drawMatch.index < verbMatch.index) ? drawMatch : verbMatch;
  if (!match || match.index === undefined) return null;
  const subjectText = normalized.slice(0, match.index);
  const colors = (Object.keys(players) as Array<"white" | "black">).filter((color) => players[color].some((alias) => hasPhrase(subjectText, alias)));
  if (colors.length > 1) return null;
  let subjectColor = colors[0];
  const subjectWords = subjectText.split(" ");
  if (!subjectColor && (subjectWords.includes("streamer") || subjectWords.includes("player"))) {
    subjectColor = game.white.toLowerCase() === game.streamer.toLowerCase() ? "white" : game.black.toLowerCase() === game.streamer.toLowerCase() ? "black" : undefined;
  }
  if (!subjectColor && (subjectWords.includes("opponent") || subjectWords.includes("other"))) {
    subjectColor = game.white.toLowerCase() === game.streamer.toLowerCase() ? "black" : game.black.toLowerCase() === game.streamer.toLowerCase() ? "white" : undefined;
  }
  if (match[0] && /draw|stalemate|tie/.test(match[0])) return new Set(["draw"]);
  if (!subjectColor) return null;
  const isLoss = /lose|loses|loss|lost|losing/.test(match[0]!);
  const resultColor = isLoss ? subjectColor === "white" ? "black" : "white" : subjectColor;
  return new Set([resultColor]);
}

function playerAliases(game: ChessGame): Record<"white" | "black", string[]> {
  const aliases = (username: string, displayName?: string | null) => {
    const values = new Set<string>();
    const normalizedUsername = normalize(username);
    if (normalizedUsername) values.add(normalizedUsername);
    if (displayName) {
      const normalizedDisplayName = normalize(displayName);
      if (normalizedDisplayName) values.add(normalizedDisplayName);
      for (const word of normalizedDisplayName.split(" ")) if (word.length >= 3) values.add(word);
    }
    return [...values];
  };
  return { white: aliases(game.white, game.whiteName), black: aliases(game.black, game.blackName) };
}

function fuzzyPlayerMatches(words: string[], players: Record<"white" | "black", string[]>): Array<"white" | "black"> {
  const matches = new Set<"white" | "black">();
  for (const word of words) {
    if (word.length < 5) continue;
    for (const color of ["white", "black"] as const) {
      const aliases = players[color].flatMap((alias) => alias.split(" ")).filter((alias) => alias.length >= 5);
      if (aliases.some((alias) => editDistanceAtMostTwo(word, alias))) matches.add(color);
    }
  }
  return [...matches];
}

function editDistanceAtMostTwo(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 2) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]! <= 2;
}

function normalize(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function hasPhrase(text: string, phrase: string): boolean { return Boolean(phrase) && ` ${text} `.includes(` ${phrase} `); }
