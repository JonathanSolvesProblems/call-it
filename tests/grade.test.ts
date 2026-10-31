import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gradeRun } from "../eval/grade-lib.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

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
      { question: "Will the boss fall?", outcomes: ["Yes", "No"], openedAt: at(22), ended: { type: "resolved", outcomeIndex: 0, outcome: "Yes" } },
      { question: "Who wins?", outcomes: ["Alice", "Bob"], openedAt: at(30), ended: { type: "resolved", outcomeIndex: 0, outcome: "Alice" } },
    ]));
    const games = join(root, "games.json");
    await writeFile(games, await readFile(join(process.cwd(), "tests", "fixtures", "chess-games.json")));
    const result = await gradeRun(runDir, games, resultDir);
    expect(result).toMatchObject({ betsOpened: 5, vodHours: 1, graded: 2, matchedRecord: 1, didNotMatch: 1, refunded: 1, ungraded: 2 });
    expect(result.ungradedReasons).toEqual({ "outcomes do not map to streamer win, opponent win, or draw": 1, "no game in progress": 1 });
    expect(result.bets.map((bet) => bet.status)).toEqual(["correct", "incorrect", "refunded", "ungraded", "ungraded"]);
  });
});
