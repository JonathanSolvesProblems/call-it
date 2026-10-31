import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gradeRun, mapOutcomeToResults, matchGameForBet, type ChessGame } from "../eval/grade-lib.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const nameGame: ChessGame = {
  url: "https://www.chess.com/game/names", white: "annacramling", black: "JanistanTV", result: "black",
  startedAt: "2026-01-01T00:00:10.000Z", endedAt: "2026-01-01T00:10:00.000Z", streamer: "annacramling",
  whiteName: "Anna Cramling", blackName: "GM Jan Gustafsson",
};

describe("chess outcome mapping", () => {
  it("matches usernames, full names, and display-name words without confusing the streamer", () => {
    expect(mapOutcomeToResults("Jan wins", "Who wins?", nameGame)).toEqual(new Set(["black"]));
    expect(mapOutcomeToResults("Jan Gustafsson wins", "Who wins?", nameGame)).toEqual(new Set(["black"]));
    expect(mapOutcomeToResults("Anna wins", "Who wins?", nameGame)).toEqual(new Set(["white"]));
  });

  it("maps Yes and No from the question, including draws in No's complement", () => {
    expect(mapOutcomeToResults("Yes", "Will Anna win?", nameGame)).toEqual(new Set(["white"]));
    expect(mapOutcomeToResults("No", "Will Anna win?", nameGame)).toEqual(new Set(["black", "draw"]));
    expect(mapOutcomeToResults("Yes", "Will Anna lose?", nameGame)).toEqual(new Set(["black"]));
    expect(mapOutcomeToResults("No", "Will Anna lose?", nameGame)).toEqual(new Set(["white", "draw"]));
    expect(mapOutcomeToResults("Yes", "Will Anna draw?", nameGame)).toEqual(new Set(["draw"]));
    expect(mapOutcomeToResults("No", "Will Anna draw?", nameGame)).toEqual(new Set(["white", "black"]));
  });

  it("leaves third-party names and outcomes that match both players unmappable", () => {
    expect(mapOutcomeToResults("Bob wins", "Who wins?", nameGame)).toBeNull();
    expect(mapOutcomeToResults("Anna or Jan wins", "Who wins?", nameGame)).toBeNull();
    expect(mapOutcomeToResults("Wins", "Will Anna win?", nameGame)).toBeNull();
    expect(mapOutcomeToResults("Lose", "Will Anna win?", nameGame)).toBeNull();
  });

  it("matches a bet opened 30 seconds before the game, but an active previous game wins", () => {
    const openingTime = Date.parse(nameGame.startedAt) - 30_000;
    expect(matchGameForBet(openingTime, [nameGame])).toBe(nameGame);
    const previous: ChessGame = { ...nameGame, url: "previous", startedAt: "2025-12-31T23:00:00.000Z", endedAt: "2026-01-01T00:00:08.000Z" };
    expect(matchGameForBet(Date.parse("2026-01-01T00:00:05.000Z"), [nameGame, previous])?.url).toBe("previous");
  });
});

describe("chess result grader", () => {
  it("matches, mismatches, refunds, leaves unmappable bets ungraded, and reports bets without a game", async () => {
    const root = await mkdtemp(join(tmpdir(), "callit-grade-test-"));
    directories.push(root);
    const runDir = join(root, "fixture-vod");
    const resultDir = join(root, "results");
    await mkdir(runDir);
    const at = (seconds: number) => ({ iso: new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1000).toISOString(), vodOffsetSeconds: seconds });
    await writeFile(join(runDir, "run.json"), JSON.stringify({ vod: { vodId: "fixture-vod" }, memoryOff: false, fromSeconds: 0, toSeconds: 3600 }));
    await writeFile(join(runDir, "bets.json"), JSON.stringify([
      { question: "Who wins?", outcomes: ["Alice", "Bob", "Draw"], openedAt: at(10), ended: { type: "resolved", outcomeIndex: 0, outcome: "Alice" } },
      { question: "Who wins?", outcomes: ["Alice", "Bob", "Draw"], openedAt: at(12), ended: { type: "resolved", outcomeIndex: 1, outcome: "Bob" } },
      { question: "Will Alice win?", outcomes: ["Yes", "No"], openedAt: at(14), ended: { type: "cancelled", reason: "could not see the end" } },
      { question: "Will Alice win?", outcomes: ["Yes", "No"], openedAt: at(22), ended: { type: "resolved", outcomeIndex: 1, outcome: "No" } },
      { question: "Will the boss fall?", outcomes: ["Yes", "No"], openedAt: at(24), ended: { type: "resolved", outcomeIndex: 0, outcome: "Yes" } },
      { question: "Who wins?", outcomes: ["Alice", "Bob"], openedAt: at(30), ended: { type: "resolved", outcomeIndex: 0, outcome: "Alice" } },
    ]));
    const games = join(root, "games.json");
    await writeFile(games, await readFile(join(process.cwd(), "tests", "fixtures", "chess-games.json")));
    const result = await gradeRun(runDir, games, resultDir);
    expect(result).toMatchObject({ betsOpened: 6, vodHours: 1, graded: 3, matchedRecord: 2, didNotMatch: 1, refunded: 1, ungraded: 2 });
    expect(result.ungradedReasons).toEqual({ "outcomes do not map to streamer win, opponent win, or draw": 1, "no game in progress": 1 });
    expect(result.bets.map((bet) => bet.status)).toEqual(["correct", "incorrect", "refunded", "correct", "ungraded", "ungraded"]);
    expect(result.bets[3]?.predictedResults).toEqual(["white", "draw"]);
  });
});
