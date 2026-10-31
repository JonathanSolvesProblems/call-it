import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseReplayFlags, runReplay } from "../src/replay/run.js";
import type { AgentContext } from "../src/agent/types.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function fn(name: string, args: unknown, id: number): Response {
  return {
    id: `response-${id}`,
    output: [{ type: "function_call", call_id: `call-${id}`, name, arguments: JSON.stringify(args) }],
    usage: { input_tokens: 7, output_tokens: 2 },
  } as unknown as Response;
}

describe("fast VOD replay", () => {
  it("supports an explicit replay model-call cap and stays unlimited by default", () => {
    expect(parseReplayFlags([], 120, {}).maxCalls).toBeUndefined();
    expect(parseReplayFlags(["--max-calls", "25"], 120, {}).maxCalls).toBe(25);
    expect(parseReplayFlags([], 120, { CALLIT_MAX_MODEL_CALLS: "40" }).maxCalls).toBe(40);
  });

  it("uses VOD timestamps and 2-second frames, writes decisions and bet lifecycle without real waits", async () => {
    const root = await mkdtemp(join(tmpdir(), "callit-replay-test-"));
    directories.push(root);
    const vodFolder = join(root, "vod");
    const outputRoot = join(root, "runs");
    await mkdir(vodFolder);
    const startedAt = "2026-01-01T00:00:00.000Z";
    await writeFile(join(vodFolder, "vod.json"), JSON.stringify({ vodId: "fixture-vod", channel: "alice", url: "https://vod.invalid/1", startedAt }));
    for (let second = 0; second <= 40; second += 1) await writeFile(join(vodFolder, `${String(second).padStart(6, "0")}.jpg`), Buffer.from(`frame-${second}`));
    const base = Date.parse(startedAt);
    let calls = 0;
    let hasOpened = false;
    let resolutionProposed = false;
    let hasSettled = false;
    let lastContext: AgentContext | undefined;
    const brain = {
      model: "fake-model",
      call: vi.fn(async (context: AgentContext) => {
        calls += 1;
        lastContext = context;
        if (!context.bet && !hasOpened) {
          hasOpened = true;
          return fn("open_bet", { question: "Will Alice win this game?", outcomes: ["Alice wins", "Bob wins"], window_seconds: 30, reason: "A new chess game has started." }, calls);
        }
        if (context.pendingResolution) { hasSettled = true; return fn("confirm_resolution", { outcome_index: 0, reason: "The board shows checkmate." }, calls); }
        if (!hasSettled && !resolutionProposed && context.nowMs >= base + 32_000) {
          resolutionProposed = true;
          return fn("resolve_bet", { outcome_index: 0, evidence: `${context.frames.at(-1)?.timestampMs}: Alice checkmates Bob.`, reason: "Alice won the game." }, calls);
        }
        return fn("wait", {}, calls);
      }),
    };
    const logs: string[] = [];
    const result = await runReplay(vodFolder, ["--memory", "off", "--from", "0", "--to", "40"], { brain, outputRoot, tickSeconds: 2, log: (line) => logs.push(line) });
    const decisions = (await readFile(join(result.directory, "decisions.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { vodOffsetSeconds: number; inputTokens: number; outputTokens: number });
    const bets = JSON.parse(await readFile(join(result.directory, "bets.json"), "utf8")) as Array<{ openedAt: { iso: string; vodOffsetSeconds: number }; lockedAt: { vodOffsetSeconds: number } | null; endedAt: { vodOffsetSeconds: number } | null; ended: { type: string; outcomeIndex?: number } | null }>;
    const runInfo = JSON.parse(await readFile(join(result.directory, "run.json"), "utf8")) as { memoryOff: boolean };
    expect(result.directory).toContain("fixture-vod-nomemory");
    expect(runInfo.memoryOff).toBe(true);
    expect(result.modelCalls).toBe(calls);
    expect(result.inputTokens).toBe(calls * 7);
    expect(result.outputTokens).toBe(calls * 2);
    expect(lastContext?.memorySummary).toBe("No stored channel memory summary yet.");
    expect(decisions[0]?.vodOffsetSeconds).toBe(0);
    expect(lastContext?.frames.map(({ timestampMs }) => (timestampMs - base) / 1000)).toEqual([36, 38, 40]);
    expect(decisions.some((decision) => decision.vodOffsetSeconds === 30)).toBe(true);
    expect(bets).toHaveLength(1);
    expect(bets[0]).toMatchObject({ openedAt: { iso: startedAt, vodOffsetSeconds: 0 }, lockedAt: { vodOffsetSeconds: 30 }, endedAt: { vodOffsetSeconds: 34 }, ended: { type: "resolved", outcomeIndex: 0 } });
    expect(logs.some((line) => line.includes("[fake chat] BET:"))).toBe(true);
    expect(logs.some((line) => line.includes("[fake moment recorder] marker and clip:"))).toBe(true);
    expect(logs.at(-1)).toContain(`${calls} model calls`);

    const limitedLogs: string[] = [];
    const limited = await runReplay(vodFolder, ["--to", "40", "--max-calls", "1"], {
      brain: { model: "fake-model", call: vi.fn(async () => fn("wait", {}, 1)) },
      outputRoot: join(root, "limited-runs"), tickSeconds: 2, log: (line) => limitedLogs.push(line),
    });
    const limitedRows = (await readFile(join(limited.directory, "decisions.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { tool: string });
    const limitedRun = JSON.parse(await readFile(join(limited.directory, "run.json"), "utf8")) as { ticks: number; toSeconds: number };
    expect(limited.modelCalls).toBe(1);
    expect(limitedRows.map(({ tool }) => tool)).toEqual(["wait", "model_call_budget_reached"]);
    expect(limitedRun).toMatchObject({ ticks: 1, toSeconds: 0 });
    expect(limitedLogs).toContain("model call budget reached");
  });
});
